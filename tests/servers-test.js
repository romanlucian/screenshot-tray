// SPDX-License-Identifier: GPL-3.0-or-later
// The server list and the Add a server form's checks. Run through tests/run.sh.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {assertEqual, assertThrows, finish, requireMadeUpHome, test} from './lib.js';
import {
    addServer, configDir, loadList, onServersChanged, parseServerInput, removeServer, saveList,
    sendTargets, setSshHostOn, sshHosts,
} from '../extension/app/servers.js';

requireMadeUpHome();

const home = GLib.get_home_dir();
const listPath = `${configDir()}/servers.json`;
const pi = parseServerInput({address: '203.0.113.10', user: 'lucian', name: 'Studio Pi'});

function write(path, text) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents(path, text);
}

function mode(path) {
    return Gio.File.new_for_path(path).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null)
        .get_attribute_uint32('unix::mode') & 0o777;
}

function reset() {
    GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(configDir())} ${GLib.shell_quote(`${home}/.ssh`)}`);
}

function sshConfig(text) {
    write(`${home}/.ssh/config`, text);
}

// Each test starts with no list and no SSH settings.
function fresh(name, fn) {
    test(name, () => {
        reset();
        return fn();
    });
}

test('form reads a pasted user@host', () => assertEqual(
    parseServerInput({address: 'lucian@203.0.113.10', user: '', port: 22}),
    {id: 'lucian@203.0.113.10:22', name: '203.0.113.10', address: '203.0.113.10', user: 'lucian', port: 22}));
test('form: a filled-in username wins over a pasted one', () => assertEqual(
    parseServerInput({address: 'other@203.0.113.10', user: 'lucian'}).user, 'lucian'));
test('form reads a pasted host:port', () => assertEqual(
    parseServerInput({address: '203.0.113.10:2222', user: 'a'}).port, 2222));
test('form: a port field other than 22 wins over a pasted one', () => assertEqual(
    parseServerInput({address: '203.0.113.10:2222', user: 'a', port: 2200}).port, 2200));
test('IPv6 keeps its colons', () => assertEqual(
    parseServerInput({address: '2001:db8::1', user: 'a'}).address, '2001:db8::1'));
test('bracketed IPv6 gives a port', () => {
    const server = parseServerInput({address: '[2001:db8::1]:2222', user: 'a'});
    assertEqual([server.address, server.port], ['2001:db8::1', 2222]);
});
test('a port typed as text becomes a number', () => assertEqual(
    parseServerInput({address: 'h', user: 'a', port: '2222'}).port, 2222));
for (const bad of ['-oProxyCommand=x', '-x', 'a b', 'a;b', 'a$(x)', '', 'é.example']) {
    test(`address refused: ${bad}`, () =>
        assertThrows(() => parseServerInput({address: bad, user: 'a'}), 'address'));
}
for (const bad of ['-x', 'a b', 'a;b', '']) {
    test(`user refused: ${bad}`, () =>
        assertThrows(() => parseServerInput({address: 'h', user: bad}), 'user'));
}
for (const bad of [0, 70000, 'abc', '1 2']) {
    test(`port refused: ${bad}`, () =>
        assertThrows(() => parseServerInput({address: 'h', user: 'a', port: bad}), 'port'));
}
test('name is trimmed, cleaned and capped at 40', () => assertEqual(
    parseServerInput({address: 'h', user: 'a', name: `  x\n${'y'.repeat(60)}`}).name,
    `x${'y'.repeat(39)}`));

fresh('no list yet gives an empty one', () =>
    assertEqual(loadList(), {added: [], sshOn: []}));
fresh('saved list reads back', () => {
    saveList({added: [pi], sshOn: ['my-server']});
    assertEqual(loadList(), {added: [pi], sshOn: ['my-server']});
});
fresh('the list is private', () => {
    saveList({added: [pi], sshOn: []});
    assertEqual([mode(configDir()), mode(listPath)], [0o700, 0o600]);
});
fresh('adding the same id twice replaces it', () => {
    addServer(pi);
    addServer({...pi, name: 'New name'});
    assertEqual(loadList().added.map(server => server.name), ['New name']);
});
fresh('removing a server leaves the others', () => {
    const other = parseServerInput({address: '203.0.113.20', user: 'a'});
    addServer(pi);
    addServer(other);
    removeServer(pi.id);
    assertEqual(loadList().added, [other]);
});
fresh('a damaged file is kept aside', () => {
    write(listPath, '{not json');
    assertEqual(loadList(), {added: [], sshOn: []});
    const names = [];
    const children = Gio.File.new_for_path(configDir()).enumerate_children('standard::name',
        Gio.FileQueryInfoFlags.NONE, null);
    for (let info = children.next_file(null); info; info = children.next_file(null))
        names.push(info.get_name());
    assertEqual(names.some(name => name.startsWith('servers.json.damaged-')), true);
    assertEqual(names.includes('servers.json'), false);
});
fresh('an entry with unsafe values in the file is ignored', () => {
    write(listPath, JSON.stringify({
        added: [
            {...pi, address: '-oProxyCommand=x'},
            {...pi, user: '-x'},
            {...pi, port: 'abc'},
            'not a server',
            pi,
        ],
        sshOn: ['my-server', 42],
    }));
    assertEqual(loadList(), {added: [pi], sshOn: ['my-server']});
});

fresh('SSH entries start off', () => {
    sshConfig('Host my-server\n    HostName 203.0.113.10\n');
    assertEqual(sendTargets(), []);
});
fresh('an entry that is on is offered', () => {
    sshConfig('Host my-server\nHost build-box\n');
    setSshHostOn('build-box', true);
    assertEqual(sendTargets(), [{kind: 'ssh', name: 'build-box'}]);
});
fresh('an entry can be switched off again', () => {
    sshConfig('Host my-server\n');
    setSshHostOn('my-server', true);
    setSshHostOn('my-server', false);
    assertEqual(sendTargets(), []);
});
fresh('an entry on, then deleted from the file, is not offered', () => {
    sshConfig('Host my-server\n');
    setSshHostOn('my-server', true);
    sshConfig('Host build-box\n');
    assertEqual(sendTargets(), []);
});
fresh('added servers are offered first', () => {
    sshConfig('Host my-server\n');
    setSshHostOn('my-server', true);
    addServer(pi);
    assertEqual(sendTargets().map(target => [target.kind, target.name]),
        [['added', 'Studio Pi'], ['ssh', 'my-server']]);
});
fresh('no ssh config gives no hosts', () => assertEqual(sshHosts(), []));
fresh('strange ssh config gives no error', () => {
    sshConfig('# Host commented\nHost *\nHost a b\n  host = c\nMatch host x\nHost *.example ?x !y\n\n');
    assertEqual(sshHosts(), ['a', 'b', 'c']);
});

fresh('saving tells listeners, and unsubscribe stops it', () => {
    let calls = 0;
    const unsubscribe = onServersChanged(() => calls++);
    saveList({added: [], sshOn: []});
    assertEqual(calls, 1);
    unsubscribe();
    saveList({added: [], sshOn: []});
    assertEqual(calls, 1);
});

reset();
await finish();
