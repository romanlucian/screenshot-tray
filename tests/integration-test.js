// SPDX-License-Identifier: GPL-3.0-or-later
// Setting up, sending to and removing a real SSH server. Run through tests/integration.sh,
// which starts the throwaway server and sets TEST_PORT, TEST_CONTAINER and TEST_IMAGE.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {assertEqual, finish, requireMadeUpHome, test} from './lib.js';
import {configDir, parseServerInput} from '../extension/app/servers.js';
import {
    addedArguments, checkTarget, forgetServerId, removeServerKey, runCommand, scanServerId, sendTo,
    setUpServer, SetupCancelled, SetupError,
} from '../extension/app/ssh.js';

requireMadeUpHome();

const port = Number(GLib.getenv('TEST_PORT'));
const container = GLib.getenv('TEST_CONTAINER');
const image = GLib.getenv('TEST_IMAGE');
const home = GLib.get_home_dir();
const PASSWORD = 'not-a-real-secret';
const NONEWLINE_LINES = 'ssh-ed25519 AAAAmadeupone one@example\nssh-ed25519 AAAAmadeuptwo two@example';

const server = user => parseServerInput({address: '127.0.0.1', user, port, name: 'Test server'});
const target = user => ({kind: 'added', ...server(user)});
const yes = () => Promise.resolve(true);

function root(command) {
    return runCommand(['docker', 'exec', container, 'sh', '-c', command], {limitSeconds: 30});
}

function asUser(user, command) {
    return runCommand(['docker', 'exec', '-u', user, '-e', `HOME=/home/${user}`, container, 'sh', '-c', command],
        {limitSeconds: 30});
}

async function keyLines(user) {
    const r = await asUser(user, 'grep -c screenshot-tray- "$HOME/.ssh/authorized_keys" || true');
    return Number(r.stdout.trim() || 0);
}

function wait(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function failure(promise) {
    try {
        await promise;
    } catch (e) {
        return e;
    }
    throw new Error('expected a failure, but it worked');
}

// Each test starts with a client that has never met the server, and a clean server.
async function resetBothSides() {
    GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(configDir())} ${GLib.shell_quote(`${home}/.ssh`)}`);
    await root(`for f in /home/*/.ssh/authorized_keys; do [ -L "$f" ] && rm -f "$f"; [ -f "$f" ] && sed -i '/screenshot-tray-/d' "$f"; done; rm -rf /home/*/.cache`);
    await asUser('nonewline', `printf '%s' '${NONEWLINE_LINES}' > "$HOME/.ssh/authorized_keys"; chmod 600 "$HOME/.ssh/authorized_keys"`);
}

function fresh(name, fn) {
    test(`${image}: ${name}`, async () => {
        await resetBothSides();
        await fn();
    });
}

fresh('password setup finishes, and Test passes', async () => {
    const steps = [];
    await setUpServer(server('pw'), PASSWORD, {onStep: (step, state) => steps.push(`${step}:${state}`), askTrust: yes});
    assertEqual(steps, ['found:running', 'found:done', 'logged-in:running', 'logged-in:done',
        'key:running', 'key:done', 'works:running', 'works:done']);
    await checkTarget(target('pw'));
    assertEqual(await keyLines('pw'), 1);
});
fresh('the app files are private', async () => {
    await setUpServer(server('pw'), PASSWORD, {askTrust: yes});
    const mode = path => Gio.File.new_for_path(path).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null)
        .get_attribute_uint32('unix::mode') & 0o777;
    assertEqual([mode(configDir()), mode(`${configDir()}/key`)], [0o700, 0o600]);
});
fresh('a password with odd characters works', async () => {
    await setUpServer(server('quoted'), 'p@ss w"o\'r\\d$é', {askTrust: yes});
    await checkTarget(target('quoted'));
});
fresh('wrong password: spec message, field password', async () => {
    const e = await failure(setUpServer(server('pw'), 'wrong', {askTrust: yes}));
    assertEqual([e instanceof SetupError, e.field, e.message],
        [true, 'password', "That username or password wasn't accepted."]);
    assertEqual(await keyLines('pw'), 0);
});
fresh('key-only server, empty password: works', async () => {
    await setUpServer(server('keyonly'), '', {askTrust: yes});
    await checkTarget(target('keyonly'));
});
fresh('key-only server, password typed: keys-only message', async () => {
    const e = await failure(setUpServer(server('keyonly'), PASSWORD, {askTrust: yes}));
    assertEqual(e.message, "This server doesn't accept passwords, only SSH keys. Set up a key for it in the terminal, then add it again with Password left empty.");
});
fresh('empty password and no working key: needs your password', async () => {
    const e = await failure(setUpServer(server('pw'), '', {askTrust: yes}));
    assertEqual(e.message, 'This server needs your password.');
});
fresh('a server that is not there: plain message', async () => {
    const nobody = parseServerInput({address: '127.0.0.1', user: 'pw', port: 1, name: 'Nobody'});
    const e = await failure(setUpServer(nobody, PASSWORD, {askTrust: yes}));
    assertEqual(e.message, "Nobody isn't answering. Is it switched on and online?");
});
fresh('an address that does not exist: plain message', async () => {
    const nowhere = parseServerInput({address: 'no-such-host.invalid', user: 'pw', name: 'Nowhere'});
    const e = await failure(setUpServer(nowhere, PASSWORD, {askTrust: yes}));
    assertEqual(e.message, "Can't find Nowhere. Check the address.");
});
fresh('first connection asks, with state new and SHA256 ID', async () => {
    const asked = [];
    await setUpServer(server('pw'), PASSWORD, {askTrust: question => {
        asked.push(question);
        return Promise.resolve(true);
    }});
    assertEqual(asked.map(question => question.state), ['new']);
    assertEqual(/^SHA256:\S+$/.test(asked[0].fingerprint), true);
});
fresh('refusing the question cancels, and trusts nothing', async () => {
    const e = await failure(setUpServer(server('pw'), PASSWORD, {askTrust: () => Promise.resolve(false)}));
    assertEqual(e instanceof SetupCancelled, true);
    assertEqual(GLib.file_test(`${configDir()}/known_hosts`, GLib.FileTest.EXISTS), false);
    assertEqual(await keyLines('pw'), 0);
});
fresh('setting up twice asks once and leaves one key line', async () => {
    let asked = 0;
    const askTrust = () => {
        asked++;
        return Promise.resolve(true);
    };
    await setUpServer(server('pw'), PASSWORD, {askTrust});
    await setUpServer(server('pw'), '', {askTrust});
    assertEqual([asked, await keyLines('pw')], [1, 1]);
});
fresh('an ID already in ~/.ssh/known_hosts is not asked about', async () => {
    const {keyLines: lines} = await scanServerId(server('pw'));
    GLib.mkdir_with_parents(`${home}/.ssh`, 0o700);
    GLib.file_set_contents(`${home}/.ssh/known_hosts`, `${lines.join('\n')}\n`);
    assertEqual((await scanServerId(server('pw'))).state, 'known');
});
fresh('a different ID in ~/.ssh/known_hosts counts as changed', async () => {
    GLib.mkdir_with_parents(`${home}/.ssh`, 0o700);
    GLib.spawn_command_line_sync(`ssh-keygen -q -t ed25519 -N '' -f ${home}/other`);
    const [, other] = GLib.file_get_contents(`${home}/other.pub`);
    const [type, key] = new TextDecoder().decode(other).trim().split(' ');
    GLib.file_set_contents(`${home}/.ssh/known_hosts`, `[127.0.0.1]:${port} ${type} ${key}\n`);
    assertEqual((await scanServerId(server('pw'))).state, 'changed');
});

async function newServerKeys() {
    const before = (await scanServerId(server('pw'))).fingerprint;
    await root('rm -f /etc/ssh/ssh_host_*; ssh-keygen -A >/dev/null; kill -HUP 1');
    for (let i = 0; i < 50; i++) {
        await wait(200);
        try {
            if ((await scanServerId(server('pw'))).fingerprint !== before)
                return;
        } catch {
            // the server is restarting: try again
        }
    }
    throw new Error('the server never got new keys');
}

fresh('changed ID: scan says changed, Test fails with the ID message, nothing is sent', async () => {
    await setUpServer(server('pw'), PASSWORD, {askTrust: yes});
    await newServerKeys();
    assertEqual((await scanServerId(server('pw'))).state, 'changed');
    const message = "Test server's ID has changed since you last connected. If you reinstalled it, remove it in Settings and add it again. If not, don't send anything: someone could be listening in.";
    assertEqual((await failure(checkTarget(target('pw')))).message, message);
    const picture = `${home}/shot.png`;
    GLib.file_set_contents(picture, 'x');
    assertEqual((await failure(sendTo(target('pw'), picture))).message, message);
    const r = await asUser('pw', 'ls -A "$HOME/.cache/screenshot-tray/inbox" 2>/dev/null || true');
    assertEqual(r.stdout.includes('shot.png'), false);
});
fresh('remove then add again works after a changed ID', async () => {
    await setUpServer(server('pw'), PASSWORD, {askTrust: yes});
    await newServerKeys();
    await forgetServerId(server('pw'));
    const asked = [];
    await setUpServer(server('pw'), PASSWORD, {askTrust: question => {
        asked.push(question.state);
        return Promise.resolve(true);
    }});
    assertEqual(asked, ['new']);
    await checkTarget(target('pw'));
});

// SSH servers briefly block a computer after failed logins and scans. Setting up must stay
// well inside that allowance, on a server with its normal settings.
async function restartServerWith(command) {
    await root(`${command}; kill -HUP 1`);
    for (let i = 0; i < 50; i++) {
        await wait(200);
        const open = await runCommand(['bash', '-c', `exec 3<>/dev/tcp/127.0.0.1/${port}; head -c 3 <&3`],
            {limitSeconds: 5});
        if (open.stdout === 'SSH')
            return;
    }
    throw new Error('the server did not come back');
}
async function withNormalLimits(work) {
    await restartServerWith(`sed -i '/PerSourcePenalties/d' /etc/ssh/sshd_config`);
    try {
        await work();
    } finally {
        await restartServerWith(`echo 'PerSourcePenalties no' > /tmp/off; sed -i '/^PrintMotd/r /tmp/off' /etc/ssh/sshd_config`);
    }
}
fresh('on a server with normal limits, a wrong password then the right one works', () =>
    withNormalLimits(async () => {
        const wrong = await failure(setUpServer(server('pw'), 'wrong', {askTrust: yes}));
        assertEqual(wrong.message, "That username or password wasn't accepted.");
        await setUpServer(server('pw'), PASSWORD, {askTrust: yes});
        await checkTarget(target('pw'));
    }));
fresh('on a server with normal limits, an empty password that fails then the right one works', () =>
    withNormalLimits(async () => {
        const wrong = await failure(setUpServer(server('pw'), '', {askTrust: yes}));
        assertEqual(wrong.message, 'This server needs your password.');
        await setUpServer(server('pw'), PASSWORD, {askTrust: yes});
        await checkTarget(target('pw'));
    }));
fresh('on a server with normal limits, too many tries say to wait', () =>
    withNormalLimits(async () => {
        for (let i = 0; i < 8; i++)
            await runCommand(['ssh-keyscan', '-T', '3', '-p', String(port), '127.0.0.1'], {limitSeconds: 10});
        const e = await failure(setUpServer(server('pw'), PASSWORD, {askTrust: yes}));
        assertEqual(e.message, 'Test server closed the connection. If you just tried several times, wait a minute and try again.');
    }));

fresh('put stores the exact bytes and returns the path', async () => {
    await setUpServer(server('pw'), PASSWORD, {askTrust: yes});
    const bytes = new Uint8Array(70000).map((_, i) => (i * 31) % 256);
    const picture = `${home}/My Shot.png`;
    GLib.file_set_contents(picture, bytes);
    const remote = await sendTo(target('pw'), picture);
    assertEqual(remote, '/home/pw/.cache/screenshot-tray/inbox/My-Shot.png');
    const local = GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, bytes);
    const r = await asUser('pw', `sha256sum "${remote}" | cut -d' ' -f1; stat -c %a "$(dirname "${remote}")"`);
    assertEqual(r.stdout.trim().split('\n'), [local, '700']);
});

for (const request of ['id', 'sh', 'cat /etc/passwd', 'check; id', 'put', 'put ', 'put ../evil', 'put .ssh',
    'put .hidden', 'put a/b', 'put x;id', 'put $(id)', 'forget; id', 'rm -rf /home/pw']) {
    fresh(`limited key refuses: ${request}`, async () => {
        await setUpServer(server('pw'), PASSWORD, {askTrust: yes});
        const r = await runCommand(addedArguments(server('pw'), request), {limitSeconds: 30});
        assertEqual(r.success, false);
        const left = await asUser('pw', 'find "$HOME/.cache" -type f; [ -d "$HOME/.ssh" ] && echo ssh-still-there');
        assertEqual(left.stdout.trim(), 'ssh-still-there');
    });
}
fresh('limited key refuses a shell', async () => {
    await setUpServer(server('pw'), PASSWORD, {askTrust: yes});
    const argv = addedArguments(server('pw'), 'check');
    argv.splice(argv.indexOf('--'), 0, '-tt');
    const r = await runCommand(argv, {limitSeconds: 30});
    assertEqual(r.stderr.includes('PTY allocation request failed'), true);
});
fresh('limited key refuses forwarding', async () => {
    await setUpServer(server('pw'), PASSWORD, {askTrust: yes});
    // Asked with the app's own "no forwarding" option removed, so the server has to refuse.
    const argv = addedArguments(server('pw'), 'check').slice(0, -1);
    argv.splice(argv.indexOf('ClearAllForwardings=yes') - 1, 2);
    argv.splice(argv.indexOf('--'), 0, '-W', '127.0.0.1:22');
    const r = await runCommand(argv, {limitSeconds: 30});
    assertEqual([r.success, /forwarding/.test(r.stderr)], [false, true]);
});
fresh('the app key is not offered with other keys or the agent', async () => {
    await setUpServer(server('keyonly'), '', {askTrust: yes});
    // Remove the app's line: the agent's key is still authorised, but must not be used.
    await root(`sed -i '/screenshot-tray-/d' /home/keyonly/.ssh/authorized_keys`);
    const e = await failure(checkTarget(target('keyonly')));
    assertEqual(e.message, "Test server no longer accepts this computer's key. Remove it in Settings and add it again.");
});

fresh('forget leaves other lines byte for byte', async () => {
    await setUpServer(server('nonewline'), PASSWORD, {askTrust: yes});
    assertEqual(await removeServerKey(server('nonewline')), true);
    const r = await asUser('nonewline', 'cat "$HOME/.ssh/authorized_keys"; stat -c %a "$HOME/.ssh/authorized_keys"');
    assertEqual(r.stdout, `${NONEWLINE_LINES}\n600\n`);
});
fresh('forget gets a linked authorized_keys wrong in no way: it leaves it', async () => {
    await setUpServer(server('pw'), PASSWORD, {askTrust: yes});
    await asUser('pw', 'mv "$HOME/.ssh/authorized_keys" "$HOME/real-keys"; ln -s "$HOME/real-keys" "$HOME/.ssh/authorized_keys"');
    assertEqual(await removeServerKey(server('pw')), false);
    const r = await asUser('pw', '[ -L "$HOME/.ssh/authorized_keys" ] && echo still-a-link; grep -c screenshot-tray- "$HOME/real-keys"');
    await asUser('pw', 'rm -f "$HOME/.ssh/authorized_keys" "$HOME/real-keys"');
    assertEqual(r.stdout.trim().split('\n'), ['still-a-link', '1']);
});
fresh('removing from a server that is gone reports false', async () => {
    const nobody = parseServerInput({address: '127.0.0.1', user: 'pw', port: 1});
    assertEqual(await removeServerKey(nobody), false);
});
fresh('a file with no final newline keeps its lines', async () => {
    await setUpServer(server('nonewline'), PASSWORD, {askTrust: yes});
    const r = await asUser('nonewline', 'cat "$HOME/.ssh/authorized_keys"');
    const lines = r.stdout.trimEnd().split('\n');
    assertEqual(lines.slice(0, 2).join('\n'), NONEWLINE_LINES);
    assertEqual([lines.length, lines[2].startsWith('restrict,command="')], [3, true]);
});
if (image === 'ubuntu') {
    fresh('a welcome message does not spoil the path', async () => {
        await setUpServer(server('noisy'), PASSWORD, {askTrust: yes});
        const picture = `${home}/shot.png`;
        GLib.file_set_contents(picture, 'x');
        assertEqual(await sendTo(target('noisy'), picture), '/home/noisy/.cache/screenshot-tray/inbox/shot.png');
    });
}
fresh('cancelling during setup rejects with SetupCancelled, and no key line is added', async () => {
    const cancellable = new Gio.Cancellable();
    const e = await failure(setUpServer(server('pw'), PASSWORD, {
        askTrust: yes,
        cancellable,
        onStep: (step, state) => {
            if (step === 'logged-in' && state === 'running')
                cancellable.cancel();
        },
    }));
    assertEqual(e instanceof SetupCancelled, true);
    assertEqual(await keyLines('pw'), 0);
});
fresh('a server that freezes mid-send gives up within a minute', async () => {
    await setUpServer(server('pw'), PASSWORD, {askTrust: yes});
    const started = GLib.get_monotonic_time();
    const sending = sendTo(target('pw'), GLib.getenv('TEST_BIG_FILE'));
    await wait(300);
    await runCommand(['docker', 'pause', container], {limitSeconds: 30});
    const e = await failure(sending);
    await runCommand(['docker', 'unpause', container], {limitSeconds: 30});
    assertEqual((GLib.get_monotonic_time() - started) / 1e6 < 60, true);
    assertEqual(['Test server stopped responding.', "Test server isn't answering. Is it switched on and online?"]
        .includes(e.message), true);
});

GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(configDir())}`);
await finish();
