// SPDX-License-Identifier: GPL-3.0-or-later
// Every SSH call the tray makes, for Claude Code or Codex running on another computer.
// This is the only part of the app that goes online, and only when asked to.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {configDir, ensureConfigDir} from './servers.js';

const APP_DIR = GLib.path_get_dirname(Gio.File.new_for_uri(import.meta.url).get_path());

// The longest each kind of work may take, in seconds.
export const LIMITS = {scan: 15, setup: 60, send: 300};

const NO_SSH = "This computer doesn't have SSH. Install it with: sudo apt install openssh-client";

// For every connection: give up on a dead network, and never forward anything.
const COMMON = ['-T', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=3', '-o', 'LogLevel=ERROR', '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes'];

// Setup went wrong; the message says why. .field is 'password' if the password was refused.
export class SetupError extends Error {
    constructor(message, field) {
        super(message);
        this.field = field;
    }
}

export class SetupCancelled extends Error {}

function knownHostsPath() {
    return GLib.build_filenamev([configDir(), 'known_hosts']);
}

function keyPath() {
    return GLib.build_filenamev([configDir(), 'key']);
}

// For added servers: the ID must already be trusted, and ssh never writes one down.
function idOptions() {
    return ['-o', `UserKnownHostsFile="${knownHostsPath()}" ~/.ssh/known_hosts`,
        '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no'];
}

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
        [/Could not resolve hostname|Name or service not known|nodename nor servname|Temporary failure in name resolution/,
            `Can't find ${name}. Check the address.`],
        // SSH servers briefly shut out a computer after several failed tries.
        [/kex_exchange_identification|Connection closed by/,
            `${name} closed the connection. If you just tried several times, wait a minute and try again.`],
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

// What ssh said. It stays silent at this log level when a server closes the connection
// before logging in, and exit code 255 is how ssh reports a connection problem.
function sshMessage(result) {
    return result.stderr.trim() ||
        (result.status === 255 ? 'Connection closed by remote host' : `ssh stopped with code ${result.status}`);
}

function explainResult(target, result) {
    if (result.timedOut)
        return `${target.name} stopped responding.`;
    return explainSshError(target.name, sshMessage(result), target.kind);
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

// A request to a server added in Settings. Only the app's own key is offered, without
// the SSH agent or the user's SSH settings, and it can only do what its key line allows.
export function addedArguments(server, request) {
    return ['ssh', '-F', 'none', ...COMMON, ...idOptions(), '-o', 'BatchMode=yes',
        '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes', '-o', 'PasswordAuthentication=no',
        '-i', keyPath(), '-p', String(server.port), '-l', server.user, '--', server.address, request];
}

// Checks that sending to a server would work. Rejects with a plain reason if not.
export async function checkTarget(target, cancellable = null) {
    const argv = target.kind === 'added' ? addedArguments(target, 'check')
        : entryArguments(target, "sh -c 'exit 0'");
    const result = await runCommand(argv, {limitSeconds: LIMITS.setup, cancellable});
    if (!result.success && !result.cancelled)
        throw new Error(explainResult(target, result));
}

function entryUploadScript(name) {
    const script = `d="$HOME/.cache/screenshot-tray/inbox"; mkdir -p "$d" && chmod 700 "$d" && ` +
        `cat > "$d/${name}" && printf "%s" "$d/${name}"`;
    return `sh -c '${script}'`;
}

// Copies a screenshot into ~/.cache/screenshot-tray/inbox on a server, and resolves
// with the file's path there. It never asks for a password.
export async function sendTo(target, path) {
    const name = safeRemoteName(path);
    const [, contents] = Gio.File.new_for_path(path).load_contents(null);
    const argv = target.kind === 'added' ? addedArguments(target, `put ${name}`)
        : entryArguments(target, entryUploadScript(name));
    const result = await runCommand(argv, {stdin: new GLib.Bytes(contents), limitSeconds: LIMITS.send});
    if (!result.success)
        throw new Error(explainResult(target, result));
    const remotePath = cleanRemotePath(result.stdout, name);
    if (!remotePath)
        throw new Error(`${target.name} sent an unexpected answer, so nothing was copied.`);
    return remotePath;
}

// Creates the app's key the first time it's needed. It has no passphrase, because it
// must work without asking, so what it may do on a server is limited (see keyLine).
export async function ensureKey() {
    ensureConfigDir();
    const key = keyPath();
    const publicPath = `${key}.pub`;
    if (!GLib.file_test(key, GLib.FileTest.EXISTS) || !GLib.file_test(publicPath, GLib.FileTest.EXISTS)) {
        for (const path of [key, publicPath])
            GLib.unlink(path);
        const keyId = GLib.uuid_string_random().replaceAll('-', '').slice(0, 16);
        const made = await runCommand(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '',
            '-C', `screenshot-tray-${keyId}`, '-f', key], {limitSeconds: LIMITS.scan});
        if (!made.success)
            throw new SetupError(`Couldn't create a key: ${made.stderr.trim()}`);
    }
    const [, contents] = GLib.file_get_contents(publicPath);
    const [type, blob, comment] = new TextDecoder().decode(contents).trim().split(/\s+/);
    return {keyPath: key, publicKey: `${type} ${blob}`, keyId: comment.replace('screenshot-tray-', '')};
}

// What the app's key may do on a server: check, put or forget, and nothing else. It runs
// instead of whatever was asked, and checks the request and the file name itself.
function receiverScript(keyId) {
    return 'd="$HOME/.cache/screenshot-tray/inbox"; case "$SSH_ORIGINAL_COMMAND" in ' +
        'check) mkdir -p "$d" && chmod 700 "$d" && : > "$d/.check" && rm -f "$d/.check" ;; ' +
        '"put "*) n="${SSH_ORIGINAL_COMMAND#put }"; ' +
        'case "$n" in ""|.*|*[!A-Za-z0-9._-]*) echo "bad name" >&2; exit 2 ;; esac; ' +
        'mkdir -p "$d" && chmod 700 "$d" && cat > "$d/$n" && printf "%s" "$d/$n" ;; ' +
        'forget) f="$HOME/.ssh/authorized_keys"; [ -L "$f" ] && exit 3; umask 077; ' +
        't="$f.screenshot-tray.$$"; ' +
        `grep -v "screenshot-tray-${keyId}" "$f" > "$t"; [ $? -le 1 ] || { rm -f "$t"; exit 3; }; ` +
        'mv -f "$t" "$f" ;; ' +
        '*) echo "not allowed" >&2; exit 2 ;; esac';
}

// The line for the server's authorized_keys. restrict turns off a shell, forwarding and
// anything SSH adds later.
export function keyLine(publicKey, keyId) {
    const script = receiverScript(keyId).replaceAll('"', '\\"');
    return `restrict,command="sh -c '${script}'" ${publicKey} screenshot-tray-${keyId}`;
}

// Adds the key line on the server. Running it twice leaves one line, a file with no final
// newline keeps its last line whole, and no other line is touched.
function installScript(line, keyId) {
    return [
        'umask 077',
        'mkdir -p "$HOME/.ssh"',
        'f="$HOME/.ssh/authorized_keys"',
        'touch "$f"',
        `grep -qF "screenshot-tray-${keyId}" "$f" && exit 0`,
        '[ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ] && printf "\\n" >> "$f"',
        `cat >> "$f" <<'SCREENSHOT_TRAY_EOF'`,
        line,
        'SCREENSHOT_TRAY_EOF',
        '',
    ].join('\n');
}

// How known_hosts files name this server.
function hostSpec(server) {
    return server.port === 22 ? server.address : `[${server.address}]:${server.port}`;
}

// The type and key of every line of an ssh-keyscan or known_hosts listing.
function hostKeys(lines) {
    return lines.map(line => line.match(/(\S+) (AAAA\S+)/)?.slice(1).join(' ')).filter(Boolean);
}

// Reads the server's IDs of the given types, or all of them. Each type is one connection,
// and SSH servers count connections that don't log in, so ask for no more than needed.
async function readServerIds(server, types, cancellable) {
    const scan = await runCommand(['ssh-keyscan', '-T', '10', ...(types ? ['-t', types] : []),
        '-p', String(server.port), '--', server.address], {limitSeconds: LIMITS.scan, cancellable});
    if (scan.cancelled)
        throw new SetupCancelled();
    return {
        keyLines: scan.stdout.split('\n').filter(line => line && !line.startsWith('#')),
        connected: /SSH-\d/.test(scan.stderr),
        stderr: scan.stderr,
    };
}

// Asks the server for its ID, and says how that compares with the IDs saved on this
// computer: 'known', 'new', or 'changed' if a different one is saved for this address.
export async function scanServerId(server, cancellable = null) {
    let scan = await readServerIds(server, 'ed25519', cancellable);
    if (scan.keyLines.length === 0 && scan.connected)
        scan = await readServerIds(server, null, cancellable);    // an older server
    if (scan.keyLines.length === 0) {
        let reason = 'Connection timed out';
        if (/not known|name resolution|nodename/.test(scan.stderr))
            reason = 'Name or service not known';
        else if (/Connection closed/.test(scan.stderr))
            reason = 'Connection closed by remote host';
        throw new SetupError(explainSshError(server.name, reason, 'added'));
    }

    const saved = [];
    for (const file of [knownHostsPath(), GLib.build_filenamev([GLib.get_home_dir(), '.ssh', 'known_hosts'])]) {
        if (!GLib.file_test(file, GLib.FileTest.EXISTS))
            continue;
        const found = await runCommand(['ssh-keygen', '-F', hostSpec(server), '-f', file],
            {limitSeconds: LIMITS.scan, cancellable});
        saved.push(...hostKeys(found.stdout.split('\n').filter(line => line && !line.startsWith('#'))));
    }
    const matches = lines => hostKeys(lines).some(key => saved.includes(key));
    let state = 'new';
    if (saved.length > 0) {
        // Saved under another type? Look at every ID before calling it changed.
        if (!matches(scan.keyLines))
            scan = await readServerIds(server, null, cancellable);
        state = matches(scan.keyLines) ? 'known' : 'changed';
    }
    const {keyLines} = scan;

    const preferred = keyLines.find(line => line.includes('ssh-ed25519')) ?? keyLines[0];
    const listed = await runCommand(['ssh-keygen', '-lf', '-'], {
        stdin: new GLib.Bytes(new TextEncoder().encode(`${preferred}\n`)),
        limitSeconds: LIMITS.scan,
        cancellable,
    });
    const fingerprint = listed.stdout.match(/SHA256:\S+/)?.[0] ?? '';
    return {keyLines, fingerprint, state};
}

// Saves a server's ID in the app's own list, never in ~/.ssh.
export function trustServerId(keyLines) {
    ensureConfigDir();
    const stream = Gio.File.new_for_path(knownHostsPath()).append_to(Gio.FileCreateFlags.PRIVATE, null);
    stream.write_bytes(new GLib.Bytes(new TextEncoder().encode(`${keyLines.join('\n')}\n`)), null);
    stream.close(null);
}

// Forgets a server's ID in the app's own list, so a reinstalled server can be added again.
export async function forgetServerId(server) {
    if (!GLib.file_test(knownHostsPath(), GLib.FileTest.EXISTS))
        return;
    await runCommand(['ssh-keygen', '-R', hostSpec(server), '-f', knownHostsPath()], {limitSeconds: LIMITS.scan});
    GLib.unlink(`${knownHostsPath()}.old`);
}

// The one-time login that puts the key on the server: with the typed password, or with
// an empty one through the keys this computer already logs in with. The password goes
// only into this ssh's environment, and -F none means no SSH setting can pass it on.
function loginArguments(server, password, command) {
    const target = ['-p', String(server.port), '-l', server.user, '--', server.address, command];
    if (!password)
        return ['ssh', ...COMMON, ...idOptions(), '-o', 'BatchMode=yes', ...target];
    return ['ssh', '-F', 'none', ...COMMON, ...idOptions(), '-o', 'PubkeyAuthentication=no',
        '-o', 'PreferredAuthentications=keyboard-interactive,password',
        '-o', 'NumberOfPasswordPrompts=1', ...target];
}

function loginEnvironment(password) {
    return password ? {
        SSH_ASKPASS: GLib.build_filenamev([APP_DIR, 'askpass.sh']),
        SSH_ASKPASS_REQUIRE: 'force',
        SCREENSHOT_TRAY_PASSWORD: password,
    } : {};
}

function loginError(server, password, result) {
    if (result.timedOut)
        return new SetupError(`${server.name} stopped responding.`);
    if (result.stderr.includes('screenshot-tray: unsupported prompt'))
        return new SetupError("This server also asks for a code, which this form can't answer.");
    const denied = result.stderr.match(/Permission denied \(([^)]*)\)/);
    if (denied) {
        if (!/password|keyboard-interactive/.test(denied[1])) {
            return new SetupError("This server doesn't accept passwords, only SSH keys. " +
                'Set up a key for it in the terminal, then add it again with Password left empty.');
        }
        return password ? new SetupError("That username or password wasn't accepted.", 'password')
            : new SetupError('This server needs your password.');
    }
    return new SetupError(explainSshError(server.name, sshMessage(result), 'added'));
}

// Everything Connect does. onStep(name, status) reports progress: name is found, logged-in,
// key or works, status is running, done or failed. askTrust({state, fingerprint}) answers
// the first-connection question. Rejects with SetupError or SetupCancelled.
export async function setUpServer(server, password, {onStep = () => {}, askTrust, cancellable = null}) {
    const stopIfCancelled = () => {
        if (cancellable?.is_cancelled())
            throw new SetupCancelled();
    };
    const step = async (name, work) => {
        stopIfCancelled();
        onStep(name, 'running');
        try {
            await work();
            stopIfCancelled();
        } catch (e) {
            if (!(e instanceof SetupCancelled))
                onStep(name, 'failed');
            throw e;
        }
        onStep(name, 'done');
    };
    const run = async (argv, options) => {
        const result = await runCommand(argv, {limitSeconds: LIMITS.setup, cancellable, ...options});
        stopIfCancelled();
        return result;
    };

    const key = await ensureKey();
    await step('found', async () => {
        const id = await scanServerId(server, cancellable);
        stopIfCancelled();
        if (id.state === 'known')
            return;
        if (!await askTrust({state: id.state, fingerprint: id.fingerprint}))
            throw new SetupCancelled();
        stopIfCancelled();
        trustServerId(id.keyLines);
    });

    let alreadySetUp = false;
    await step('logged-in', async () => {
        // With a password there's no need to try the app's key first: installing is safe
        // to repeat, and SSH servers count every failed login.
        if (!password) {
            alreadySetUp = (await run(addedArguments(server, 'check'))).success;
            if (alreadySetUp)
                return;
        }
        const login = await run(loginArguments(server, password, "sh -c 'exit 0'"),
            {env: loginEnvironment(password)});
        if (!login.success)
            throw loginError(server, password, login);
    });
    await step('key', async () => {
        if (alreadySetUp)
            return;
        const script = installScript(keyLine(key.publicKey, key.keyId), key.keyId);
        const install = await run(loginArguments(server, password, 'sh -s'), {
            env: loginEnvironment(password),
            stdin: new GLib.Bytes(new TextEncoder().encode(script)),
        });
        if (!install.success)
            throw loginError(server, password, install);
    });
    await step('works', async () => {
        if (alreadySetUp)
            return;
        const check = await run(addedArguments(server, 'check'));
        if (check.success)
            return;
        if (/Permission denied/.test(check.stderr)) {
            throw new SetupError("The key was installed, but the server won't accept it. " +
                'Ask whoever runs it to check the permissions on your home folder.');
        }
        throw new SetupError(explainSshError(server.name, sshMessage(check), 'added'));
    });
}

// Asks the server to remove the app's key line. Resolves false if that didn't happen.
export async function removeServerKey(server) {
    try {
        return (await runCommand(addedArguments(server, 'forget'), {limitSeconds: LIMITS.setup})).success;
    } catch {
        return false;
    }
}

