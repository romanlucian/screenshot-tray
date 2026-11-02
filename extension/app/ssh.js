// SPDX-License-Identifier: GPL-3.0-or-later
// Every SSH call the tray makes, for Claude Code or Codex running on another computer.
// This is the only part of the app that goes online, and only when asked to.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// The longest each kind of work may take, in seconds.
export const LIMITS = {scan: 15, setup: 60, send: 300};

const NO_SSH = "This computer doesn't have SSH. Install it with: sudo apt install openssh-client";

// For every connection: give up on a dead network, and never forward anything.
const COMMON = ['-T', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=3', '-o', 'LogLevel=ERROR', '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes'];

// Runs a program with a time limit. Always resolves, unless the program can't be started.
// On the limit or a cancel it kills the program and settles at once, even if something
// it left behind still holds its output open.
export function runCommand(argv, {stdin = null, env = {}, limitSeconds = LIMITS.setup, cancellable = null} = {}) {
    return new Promise((resolve, reject) => {
        const outcome = (fields = {}) => ({
            success: false, status: -1, stdout: '', stderr: '', timedOut: false, cancelled: false, ...fields,
        });
        if (cancellable?.is_cancelled()) {
            resolve(outcome({cancelled: true}));
            return;
        }
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_PIPE,
        });
        for (const [name, value] of Object.entries(env))
            launcher.setenv(name, value, true);
        let proc;
        try {
            proc = launcher.spawnv(argv);
        } catch {
            reject(new Error(NO_SSH));
            return;
        }

        let settled = false;
        let timerId = 0;
        let cancelledId = 0;
        const settle = result => {
            if (settled)
                return;
            settled = true;
            if (timerId)
                GLib.source_remove(timerId);
            if (cancelledId)
                cancellable.disconnect(cancelledId);
            resolve(result);
        };
        timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, limitSeconds, () => {
            timerId = 0;
            proc.force_exit();
            settle(outcome({timedOut: true}));
            return GLib.SOURCE_REMOVE;
        });
        if (cancellable) {
            cancelledId = cancellable.connect(() => {
                cancelledId = 0;    // disconnecting from inside this callback would hang
                proc.force_exit();
                settle(outcome({cancelled: true}));
            });
        }
        const text = bytes => new TextDecoder().decode(bytes?.toArray() ?? new Uint8Array());
        const input = stdin ?? new GLib.Bytes(new Uint8Array());
        proc.communicate_async(input, null, (_proc, result) => {
            try {
                const [, stdout, stderr] = proc.communicate_finish(result);
                settle(outcome({
                    success: proc.get_successful(),
                    status: proc.get_if_exited() ? proc.get_exit_status() : -1,
                    stdout: text(stdout),
                    stderr: text(stderr),
                }));
            } catch (e) {
                settle(outcome({stderr: e.message}));
            }
        });
    });
}

// Turns ssh's error into a plain sentence saying what to do. kind is 'added' for a
// server added in Settings, 'ssh' for an entry of ~/.ssh/config.
export function explainSshError(name, message, kind) {
    const added = kind === 'added';
    const cases = [
        [/REMOTE HOST IDENTIFICATION HAS CHANGED/,
            `${name}'s ID has changed since you last connected. If you reinstalled it, ` +
            `${added ? 'remove it in Settings and add it again' : `remove its old ID with: ssh-keygen -R ${name}`}. ` +
            "If not, don't send anything: someone could be listening in."],
        [/Host key verification failed/,
            added ? `${name} isn't trusted yet. Remove it in Settings and add it again.`
                : `${name} isn't trusted yet. Connect once in a terminal (ssh ${name}), then try again.`],
        [/Too many authentication failures/,
            `${name} gave up after too many keys. Name the right key for it in ~/.ssh/config.`],
        [/Permission denied/,
            added ? `${name} no longer accepts this computer's key. Remove it in Settings and add it again.`
                : `${name} wants a password or another key. The tray only logs in with a saved SSH key.`],
        [/Could not resolve hostname|Name or service not known|nodename nor servname/,
            `Can't find ${name}. Check the address.`],
        [/not responding|Broken pipe|Connection reset/,
            `${name} stopped responding.`],
        [/timed out|Connection refused|No route to host|Network is unreachable/,
            `${name} isn't answering. Is it switched on and online?`],
        [/is not recognized as an internal|(^|\s)sh: .*not found/,
            'This server has no Unix shell (a Windows server?). Sending needs a Linux or Mac server.'],
        [/No space left on device|Disk quota exceeded/,
            `${name} is out of disk space.`],
    ];
    const known = cases.find(([pattern]) => pattern.test(message));
    return known ? known[1] : `Couldn't send to ${name}: ${message.trim().split('\n').pop()}`;
}

function explainResult(target, result) {
    if (result.timedOut)
        return `${target.name} stopped responding.`;
    return explainSshError(target.name,
        result.stderr.trim() || `ssh stopped with code ${result.status}`, target.kind);
}

// A file name that is safe to pass to the server. The server checks it again.
export function safeRemoteName(path) {
    return GLib.path_get_basename(path).replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^[-.]+/, '') || 'screenshot.png';
}

// The path a server sent back, if it is the one expected. Only this goes on the
// clipboard, so a server can't put hidden commands there. Login scripts may print
// other lines first, so the last line counts.
export function cleanRemotePath(stdout, name) {
    const line = stdout.trim().split('\n').pop().trim();
    if (!/^\/[A-Za-z0-9._/ -]+$/.test(line))
        return null;
    return line.endsWith(`/.cache/screenshot-tray/inbox/${name}`) ? line : null;
}

function entryArguments(target, command) {
    return ['ssh', ...COMMON, '-o', 'BatchMode=yes', '--', target.name, command];
}

// Checks that sending to a server would work. Rejects with a plain reason if not.
export async function checkTarget(target, cancellable = null) {
    const result = await runCommand(entryArguments(target, "sh -c 'exit 0'"),
        {limitSeconds: LIMITS.setup, cancellable});
    if (!result.success && !result.cancelled)
        throw new Error(explainResult(target, result));
}

// Copies a screenshot into ~/.cache/screenshot-tray/inbox on a server, and resolves
// with the file's path there. It never asks for a password.
export async function sendTo(target, path) {
    const name = safeRemoteName(path);
    const [, contents] = Gio.File.new_for_path(path).load_contents(null);
    const script = `d="$HOME/.cache/screenshot-tray/inbox"; mkdir -p "$d" && chmod 700 "$d" && ` +
        `cat > "$d/${name}" && printf "%s" "$d/${name}"`;
    const result = await runCommand(entryArguments(target, `sh -c '${script}'`),
        {stdin: new GLib.Bytes(contents), limitSeconds: LIMITS.send});
    if (!result.success)
        throw new Error(explainResult(target, result));
    const remotePath = cleanRemotePath(result.stdout, name);
    if (!remotePath)
        throw new Error(`${target.name} sent an unexpected answer, so nothing was copied.`);
    return remotePath;
}

// Opens ~/.ssh/config in the text editor, first creating it with an example if missing.
export function openSshConfig(launchContext) {
    const dir = GLib.build_filenamev([GLib.get_home_dir(), '.ssh']);
    const path = GLib.build_filenamev([dir, 'config']);
    if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
        GLib.mkdir_with_parents(dir, 0o700);
        const example = [
            '# Servers for SSH, and for "Send to a server" in Screenshot Tray.',
            '# Copy these three lines for each server, remove the # signs, and fill them in:',
            '#',
            '# Host myserver',
            '#     HostName 203.0.113.5',
            '#     User myname',
            '',
        ].join('\n');
        // PRIVATE: readable by you only, as SSH expects of this file.
        Gio.File.new_for_path(path).replace_contents(new TextEncoder().encode(example),
            null, false, Gio.FileCreateFlags.PRIVATE, null);
    }
    Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(path).get_uri(), launchContext);
}
