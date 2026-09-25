// SPDX-License-Identifier: GPL-3.0-or-later
// Sending screenshots to servers over SSH, for Claude Code or Codex running there.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// The servers named on the "Host" lines of ~/.ssh/config (patterns like * are skipped).
export function sshHosts() {
    let contents;
    try {
        [, contents] = GLib.file_get_contents(GLib.build_filenamev([GLib.get_home_dir(), '.ssh', 'config']));
    } catch {
        return [];
    }
    const hosts = [];
    for (const line of new TextDecoder().decode(contents).split('\n')) {
        const match = line.match(/^\s*Host(?:\s+|\s*=\s*)(.+?)\s*$/i);
        for (const name of match ? match[1].split(/\s+/) : []) {
            if (!/[*?!]/.test(name) && !hosts.includes(name))
                hosts.push(name);
        }
    }
    return hosts;
}

// Turns ssh's error into a plain sentence saying what to do. The upload never asks
// for a password (ssh BatchMode), so each case below is a login the tray can't finish.
export function explainSshError(host, message) {
    const cases = [
        [/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/,
            `${host} isn't trusted yet. Connect once in a terminal (ssh ${host}), then try again.`],
        [/Too many authentication failures/,
            `${host} gave up after too many keys. Name the right key for it in ~/.ssh/config.`],
        [/Permission denied/,
            `${host} wants a password or another key. The tray only logs in with a saved SSH key.`],
        [/Could not resolve hostname|Name or service not known|nodename nor servname/,
            `Can't find ${host}. Check its address in ~/.ssh/config.`],
        [/timed out|Connection refused|No route to host|Network is unreachable/,
            `${host} isn't answering. Is it switched on and online?`],
        [/is not recognized as an internal|(^|\s)sh: .*not found/,
            `${host} has no Unix shell (a Windows server?). Sending needs a Linux or Mac server.`],
        [/No space left on device|Disk quota exceeded/,
            `${host} is out of disk space.`],
    ];
    const known = cases.find(([pattern]) => pattern.test(message));
    return known ? known[1] : `Couldn't send to ${host}: ${message.split('\n').pop()}`;
}

// Checks that sending to a server would work: logs in the same no-password way and
// runs nothing but the Unix shell. Resolves if ready, else rejects with a plain reason.
export function checkServer(host) {
    const ssh = Gio.Subprocess.new(
        ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', host, "sh -c 'exit 0'"],
        Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
    return new Promise((resolve, reject) => {
        ssh.communicate_utf8_async(null, null, (proc, result) => {
            try {
                const [, , stderr] = proc.communicate_utf8_finish(result);
                if (proc.get_successful())
                    resolve();
                else
                    reject(new Error(explainSshError(host, stderr?.trim() || `ssh stopped with code ${proc.get_exit_status()}`)));
            } catch (e) {
                reject(e);
            }
        });
    });
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

// Copies a screenshot into ~/.cache/screenshot-tray/inbox on a server, over the
// SSH login already set up for it (it never asks for a password), and resolves
// with the file's path on that server.
export function uploadToServer(path, host) {
    const name = GLib.path_get_basename(path).replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^[-.]+/, '') || 'screenshot.png';
    const script = `d="$HOME/.cache/screenshot-tray/inbox"; mkdir -p "$d" && chmod 700 "$d" && ` +
        `cat > "$d/${name}" && printf "%s" "$d/${name}"`;
    const [, contents] = Gio.File.new_for_path(path).load_contents(null);
    const ssh = Gio.Subprocess.new(
        ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', host, `sh -c '${script}'`],
        Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const text = bytes => new TextDecoder().decode(bytes?.toArray() ?? new Uint8Array()).trim();
    return new Promise((resolve, reject) => {
        ssh.communicate_async(new GLib.Bytes(contents), null, (proc, result) => {
            try {
                const [, stdout, stderr] = proc.communicate_finish(result);
                if (proc.get_successful() && text(stdout))
                    resolve(text(stdout));
                else
                    reject(new Error(explainSshError(host, text(stderr) || `ssh stopped with code ${proc.get_exit_status()}`)));
            } catch (e) {
                reject(e);
            }
        });
    });
}
