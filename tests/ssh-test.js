// SPDX-License-Identifier: GPL-3.0-or-later
// The SSH calls, without any server: time limits, messages, and what gets passed to ssh.
// Run through tests/run.sh. Real servers are in tests/integration-test.js.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {assertEqual, finish, requireMadeUpHome, test} from './lib.js';
import {
    checkTarget, cleanRemotePath, explainSshError, keyLine, runCommand, safeRemoteName, sendTo,
} from '../extension/app/ssh.js';

requireMadeUpHome();

const home = GLib.get_home_dir();
const here = GLib.path_get_dirname(Gio.File.new_for_uri(import.meta.url).get_path());
const realPath = GLib.getenv('PATH');
const log = `${home}/fake-ssh.log`;

function useFakeSsh(output = '', exit = 0) {
    GLib.setenv('PATH', `${here}/fakes:${realPath}`, true);
    GLib.setenv('FAKE_SSH_LOG', log, true);
    GLib.setenv('FAKE_SSH_OUTPUT', output, true);
    GLib.setenv('FAKE_SSH_EXIT', String(exit), true);
}

function fakeSshArguments() {
    const [, contents] = GLib.file_get_contents(log);
    return new TextDecoder().decode(contents).trimEnd().split('\n');
}

async function messageFrom(promise) {
    try {
        await promise;
    } catch (e) {
        return e.message;
    }
    return null;
}

test('a command that finishes gives its output', async () => {
    const r = await runCommand(['sh', '-c', 'cat; echo err >&2'], {
        stdin: new GLib.Bytes(new TextEncoder().encode('in')), limitSeconds: 5,
    });
    assertEqual([r.success, r.stdout, r.stderr.trim(), r.timedOut, r.cancelled], [true, 'in', 'err', false, false]);
});
test('a command gets the environment it was given', async () => {
    const r = await runCommand(['sh', '-c', 'printf %s "$MADE_UP"'], {env: {MADE_UP: 'x y'}, limitSeconds: 5});
    assertEqual(r.stdout, 'x y');
});
test('a failing command says so', async () => {
    const r = await runCommand(['sh', '-c', 'exit 3'], {limitSeconds: 5});
    assertEqual([r.success, r.status], [false, 3]);
});
test('time limit ends a stuck command', async () => {
    const before = GLib.get_monotonic_time();
    const r = await runCommand(['sh', '-c', 'sleep 30 & wait'], {limitSeconds: 1});
    assertEqual([r.success, r.timedOut], [false, true]);
    // It settles at once, even with a leftover child still holding the pipes.
    assertEqual((GLib.get_monotonic_time() - before) / 1e6 < 5, true);
});
test('cancelling ends a command', async () => {
    const cancellable = new Gio.Cancellable();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        cancellable.cancel();
        return GLib.SOURCE_REMOVE;
    });
    const r = await runCommand(['sleep', '30'], {limitSeconds: 20, cancellable});
    assertEqual([r.success, r.cancelled], [false, true]);
});
test('a command already cancelled does not start', async () => {
    const cancellable = new Gio.Cancellable();
    cancellable.cancel();
    const r = await runCommand(['sh', '-c', `touch ${home}/started`], {limitSeconds: 5, cancellable});
    assertEqual([r.cancelled, GLib.file_test(`${home}/started`, GLib.FileTest.EXISTS)], [true, false]);
});
test('missing ssh gives the install message', async () => {
    GLib.setenv('PATH', '/nonexistent', true);
    const message = await messageFrom(runCommand(['ssh', 'x'], {limitSeconds: 5}));
    GLib.setenv('PATH', realPath, true);
    assertEqual(message, "This computer doesn't have SSH. Install it with: sudo apt install openssh-client");
});

const CHANGED = '@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@\nHost key verification failed.';
const MESSAGES = [
    ['ssh: Could not resolve hostname h: Name or service not known', 'added', "Can't find pi. Check the address."],
    ['ssh: connect to host h port 22: Connection refused', 'added', "pi isn't answering. Is it switched on and online?"],
    ['ssh: connect to host h port 22: Connection timed out', 'ssh', "pi isn't answering. Is it switched on and online?"],
    ['ssh: connect to host h port 22: No route to host', 'added', "pi isn't answering. Is it switched on and online?"],
    ["'sh' is not recognized as an internal or external command", 'ssh', 'This server has no Unix shell (a Windows server?). Sending needs a Linux or Mac server.'],
    [CHANGED, 'added', "pi's ID has changed since you last connected. If you reinstalled it, remove it in Settings and add it again. If not, don't send anything: someone could be listening in."],
    [CHANGED, 'ssh', "pi's ID has changed since you last connected. If you reinstalled it, remove its old ID with: ssh-keygen -R pi. If not, don't send anything: someone could be listening in."],
    ['user@h: Permission denied (publickey).', 'added', "pi no longer accepts this computer's key. Remove it in Settings and add it again."],
    ['user@h: Permission denied (publickey,password).', 'ssh', 'pi wants a password or another key. The tray only logs in with a saved SSH key.'],
    ['Received disconnect from h: Too many authentication failures', 'ssh', 'pi gave up after too many keys. Name the right key for it in ~/.ssh/config.'],
    ['Host key verification failed.', 'ssh', "pi isn't trusted yet. Connect once in a terminal (ssh pi), then try again."],
    ['No ED25519 host key is known for h and you have requested strict checking.\nHost key verification failed.', 'added', "pi isn't trusted yet. Remove it in Settings and add it again."],
    ['cat: write error: No space left on device', 'added', 'pi is out of disk space.'],
    ['sh: 1: cannot create x: Disk quota exceeded', 'ssh', 'pi is out of disk space.'],
    ['Timeout, server h not responding.', 'added', 'pi stopped responding.'],
    ['client_loop: send disconnect: Broken pipe', 'ssh', 'pi stopped responding.'],
    ['kex_exchange_identification: Connection closed by remote host', 'added', 'pi closed the connection. If you just tried several times, wait a minute and try again.'],
    ['kex_exchange_identification: read: Connection reset by peer', 'ssh', 'pi closed the connection. If you just tried several times, wait a minute and try again.'],
    ['first line\nsomething odd happened', 'ssh', "Couldn't send to pi: something odd happened"],
];
for (const [stderr, kind, message] of MESSAGES) {
    test(`explains (${kind}): ${message}`, () =>
        assertEqual(explainSshError('pi', stderr, kind), message));
}
test('a changed ID never advises connecting in a terminal', () => {
    for (const kind of ['added', 'ssh'])
        assertEqual(explainSshError('pi', CHANGED, kind).includes('terminal'), false);
});

test('path: takes the last line after a welcome message', () => assertEqual(
    cleanRemotePath('welcome\n/home/u/.cache/screenshot-tray/inbox/a.png', 'a.png'),
    '/home/u/.cache/screenshot-tray/inbox/a.png'));
test('path: a home folder with a space is fine', () => assertEqual(
    cleanRemotePath('/home/a b/.cache/screenshot-tray/inbox/a.png', 'a.png'),
    '/home/a b/.cache/screenshot-tray/inbox/a.png'));
const box = '/.cache/screenshot-tray/inbox/a.png';
for (const bad of ['', '/etc/passwd', `relative${box}`, `/a\x1b[31m${box}`, `/a;b${box}`, `${box}\nrm -rf x`,
    '/.cache/screenshot-tray/inbox/other.png']) {
    test(`path refused: ${JSON.stringify(bad)}`, () => assertEqual(cleanRemotePath(bad, 'a.png'), null));
}

test('name: odd screenshot names become safe', () => {
    assertEqual(safeRemoteName('/x/Screenshot From 2026.png'), 'Screenshot-From-2026.png');
    assertEqual(safeRemoteName("/x/';rm -rf ~;'.png"), 'rm--rf-.png');
    assertEqual(safeRemoteName('/x/.hidden.png'), 'hidden.png');
    assertEqual(safeRemoteName('/x/---'), 'screenshot.png');
});

test('sendTo on an SSH entry uses the fixed options', async () => {
    const picture = `${home}/My Shot.png`;
    GLib.file_set_contents(picture, 'picture bytes');
    useFakeSsh('/home/u/.cache/screenshot-tray/inbox/My-Shot.png');
    const remote = await sendTo({kind: 'ssh', name: 'my-server'}, picture);
    GLib.setenv('PATH', realPath, true);
    const args = fakeSshArguments();
    assertEqual(remote, '/home/u/.cache/screenshot-tray/inbox/My-Shot.png');
    for (const option of ['BatchMode=yes', 'ConnectTimeout=10', 'ServerAliveInterval=10',
        'ServerAliveCountMax=3', 'ForwardAgent=no', 'ClearAllForwardings=yes']) {
        assertEqual([option, args.includes(option)], [option, true]);
    }
    assertEqual(args[args.indexOf('--') + 1], 'my-server');
    assertEqual(args.at(-1).startsWith("sh -c '"), true);
    assertEqual(args.at(-1).includes('My-Shot.png'), true);
    const [, sent] = GLib.file_get_contents(`${log}.stdin`);
    assertEqual(new TextDecoder().decode(sent), 'picture bytes');
});
test('sendTo refuses a strange answer from the server', async () => {
    const picture = `${home}/a.png`;
    GLib.file_set_contents(picture, 'x');
    useFakeSsh('/tmp/evil\x1b[31m');
    const message = await messageFrom(sendTo({kind: 'ssh', name: 'my-server'}, picture));
    GLib.setenv('PATH', realPath, true);
    assertEqual(message, 'my-server sent an unexpected answer, so nothing was copied.');
});
test('sendTo turns a failure into a plain sentence', async () => {
    const picture = `${home}/a.png`;
    GLib.file_set_contents(picture, 'x');
    GLib.setenv('PATH', `${here}/fakes:${realPath}`, true);
    useFakeSsh('', 3);
    const message = await messageFrom(sendTo({kind: 'ssh', name: 'my-server'}, picture));
    GLib.setenv('PATH', realPath, true);
    assertEqual(message, "Couldn't send to my-server: ssh stopped with code 3");
});
test('ssh giving up with no words means the connection was closed', async () => {
    const picture = `${home}/a.png`;
    GLib.file_set_contents(picture, 'x');
    useFakeSsh('', 255);
    const message = await messageFrom(sendTo({kind: 'ssh', name: 'my-server'}, picture));
    GLib.setenv('PATH', realPath, true);
    assertEqual(message, 'my-server closed the connection. If you just tried several times, wait a minute and try again.');
});
test('checkTarget on an SSH entry runs only the shell', async () => {
    useFakeSsh();
    await checkTarget({kind: 'ssh', name: 'my-server'});
    GLib.setenv('PATH', realPath, true);
    const args = fakeSshArguments();
    assertEqual(args.at(-1), "sh -c 'exit 0'");
    assertEqual(args[args.indexOf('--') + 1], 'my-server');
});

const askpass = `${here}/../extension/app/askpass.sh`;
test('askpass answers a password prompt, exactly', async () => {
    const r = await runCommand([askpass, "user@h's password: "],
        {env: {SCREENSHOT_TRAY_PASSWORD: 'p@ss w"o\'r\\d$é'}, limitSeconds: 5});
    assertEqual([r.success, r.stdout], [true, 'p@ss w"o\'r\\d$é\n']);
});
for (const prompt of ['Verification code: ', 'Enter passphrase for key: ', 'Are you sure (yes/no)? ']) {
    test(`askpass refuses: ${prompt}`, async () => {
        const r = await runCommand([askpass, prompt], {env: {SCREENSHOT_TRAY_PASSWORD: 'secret'}, limitSeconds: 5});
        assertEqual([r.success, r.stdout, r.stderr.trim()], [false, '', 'screenshot-tray: unsupported prompt']);
    });
}

test('the key line is one line, limited, and marked with its id', () => {
    const line = keyLine('ssh-ed25519 AAAA', 'abc123');
    assertEqual(line.includes('\n'), false);
    assertEqual(line.startsWith('restrict,command="'), true);
    assertEqual(line.endsWith('" ssh-ed25519 AAAA screenshot-tray-abc123'), true);
});

await finish();
