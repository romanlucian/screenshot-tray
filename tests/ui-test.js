// SPDX-License-Identifier: GPL-3.0-or-later
// The Settings window and the Add a server form, drawn on an invisible display and
// pressed by the tests. Nothing goes near a network. Run through tests/ui.sh.

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {assertEqual, finish, requireMadeUpHome, test} from './lib.js';
import {button, row, rows, walk} from './widgets.js';
import {
    addServer, configDir, loadList, onServersChanged, parseServerInput, setSshHostOn,
} from '../extension/app/servers.js';
import {SetupCancelled, SetupError} from '../extension/app/ssh.js';
import {showAddServer} from '../extension/app/add-server.js';
import {showSettings} from '../extension/app/settings.js';

requireMadeUpHome();
// Windows behave differently without an application, so test inside one as the tray runs.
const app = new Adw.Application({application_id: 'com.zincoo.ScreenshotTrayTests', flags: Gio.ApplicationFlags.NON_UNIQUE});
app.register(null);
app.hold();

const home = GLib.get_home_dir();
const pi = parseServerInput({address: '203.0.113.10', user: 'lucian', name: 'Studio Pi'});
const ENTERED = {address: '203.0.113.10', user: 'lucian', password: 'secret'};

function pause(ms = 20) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

// Closes a window as a person does. (force_close doesn't report closed.)
async function closed(dialog) {
    dialog.close();
    await pause(50);
}

function reset() {
    GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(configDir())} ${GLib.shell_quote(`${home}/.ssh`)}`);
}

function sshConfig(text) {
    GLib.mkdir_with_parents(`${home}/.ssh`, 0o700);
    GLib.file_set_contents(`${home}/.ssh/config`, text);
}

// Stand-ins for the SSH calls. Each records that it was called.
function fakeDeps(overrides = {}) {
    const calls = {setUpServer: 0, checkTarget: 0, removeServerKey: 0, forgetServerId: 0};
    const counted = (name, fn) => (...args) => {
        calls[name]++;
        return fn(...args);
    };
    return {
        calls,
        setUpServer: counted('setUpServer', overrides.setUpServer ?? (async () => {})),
        checkTarget: counted('checkTarget', overrides.checkTarget ?? (async () => {})),
        removeServerKey: counted('removeServerKey', overrides.removeServerKey ?? (async () => true)),
        forgetServerId: counted('forgetServerId', overrides.forgetServerId ?? (async () => {})),
    };
}

function fill(dialog, {address = '', user = '', password = ''}) {
    row(dialog, 'Server address').text = address;
    row(dialog, 'Username').text = user;
    row(dialog, 'Password').text = password;
}

function connectButton(dialog) {
    return button(dialog, 'Connect');
}

function textOn(dialog) {
    return [...walk(dialog)].filter(widget => widget instanceof Gtk.Label && widget.get_visible())
        .map(widget => widget.get_text()).join(' | ');
}

function fresh(name, fn) {
    test(name, async () => {
        reset();
        await fn();
    });
}

// Settings ---------------------------------------------------------------------------

fresh('Settings lists added servers and SSH entries', async () => {
    addServer(pi);
    sshConfig('Host my-server\nHost build-box\n');
    const dialog = showSettings(fakeDeps());
    assertEqual(rows(dialog).map(item => item.title),
        ['Studio Pi', 'Add a server…', 'my-server', 'build-box']);
    assertEqual(row(dialog, 'Studio Pi').subtitle, 'lucian@203.0.113.10');
    await closed(dialog);
});
fresh('a non-standard port shows in the address', async () => {
    addServer(parseServerInput({address: '203.0.113.10', user: 'lucian', port: 2222, name: 'Pi'}));
    const dialog = showSettings(fakeDeps());
    assertEqual(row(dialog, 'Pi').subtitle, 'lucian@203.0.113.10:2222');
    await closed(dialog);
});
fresh('a name with odd characters shows as typed', async () => {
    addServer(parseServerInput({address: 'h', user: 'a', name: 'R&D <box>'}));
    const dialog = showSettings(fakeDeps());
    assertEqual(rows(dialog)[0].title, 'R&amp;D &lt;box&gt;');
    await closed(dialog);
});
fresh('the SSH group hides when there are no entries', async () => {
    const dialog = showSettings(fakeDeps());
    assertEqual(rows(dialog).map(item => item.title), ['Add a server…']);
    assertEqual(textOn(dialog).includes('Already in your SSH settings'), false);
    await closed(dialog);
});
fresh('opening Settings twice gives the same window', async () => {
    const first = showSettings(fakeDeps());
    const second = showSettings(fakeDeps());
    assertEqual(first === second, true);
    await closed(first);
    const third = showSettings(fakeDeps());
    assertEqual(third === first, false);
    await closed(third);
});
fresh('an entry that is off says Not offered on your cards, with no Test', async () => {
    sshConfig('Host my-server\n');
    const dialog = showSettings(fakeDeps());
    const entry = row(dialog, 'my-server');
    assertEqual(entry.subtitle, 'Not offered on your cards');
    assertEqual(button(entry, 'Test').get_visible(), false);
    await closed(dialog);
});
fresh('a switch saves, and tells listeners', async () => {
    sshConfig('Host my-server\n');
    const dialog = showSettings(fakeDeps());
    let told = 0;
    const stop = onServersChanged(() => told++);
    const entry = row(dialog, 'my-server');
    [...walk(entry)].find(widget => widget instanceof Gtk.Switch).active = true;
    stop();
    assertEqual([loadList().sshOn, told, entry.subtitle], [['my-server'], 1, '']);
    assertEqual(button(entry, 'Test').get_visible(), true);
    await closed(dialog);
});
fresh('an entry that was on shows as on', async () => {
    sshConfig('Host my-server\n');
    setSshHostOn('my-server', true);
    const dialog = showSettings(fakeDeps());
    assertEqual([...walk(row(dialog, 'my-server'))].find(widget => widget instanceof Gtk.Switch).active, true);
    await closed(dialog);
});
fresh('Ready appears only after Test passes', async () => {
    addServer(pi);
    const deps = fakeDeps();
    const dialog = showSettings(deps);
    assertEqual([deps.calls.checkTarget, row(dialog, 'Studio Pi').subtitle.includes('Ready')], [0, false]);
    button(row(dialog, 'Studio Pi'), 'Test').emit('clicked');
    await pause();
    assertEqual([deps.calls.checkTarget, row(dialog, 'Studio Pi').subtitle.includes('Ready')], [1, true]);
    await closed(dialog);
});
fresh('a failed Test shows the reason', async () => {
    addServer(pi);
    const deps = fakeDeps({checkTarget: () => Promise.reject(new Error('Studio Pi stopped responding.'))});
    const dialog = showSettings(deps);
    button(row(dialog, 'Studio Pi'), 'Test').emit('clicked');
    await pause();
    assertEqual(row(dialog, 'Studio Pi').subtitle, 'Studio Pi stopped responding.');
    await closed(dialog);
});

// Dialogs over a window can open as windows of their own, so look through them all.
function everything() {
    return Gtk.Window.list_toplevels().flatMap(window => [...walk(window)]);
}

function openQuestion() {
    return everything().find(widget => widget instanceof Adw.AlertDialog) ?? null;
}

function answer(question, label) {
    button(question, label).emit('clicked');
}

fresh('remove asks first, then removes and forgets the ID', async () => {
    addServer(pi);
    const deps = fakeDeps();
    const dialog = showSettings(deps);
    const trash = [...walk(row(dialog, 'Studio Pi'))].find(widget =>
        widget instanceof Gtk.Button && widget.icon_name === 'user-trash-symbolic');
    trash.emit('clicked');
    await pause();
    const question = openQuestion();
    assertEqual([question.heading, question.body, deps.calls.removeServerKey, loadList().added.length],
        ['Remove Studio Pi?', 'Screenshots already sent stay on that server.', 0, 1]);
    answer(question, 'Remove');
    await pause();
    assertEqual([deps.calls.removeServerKey, deps.calls.forgetServerId, loadList().added.length], [1, 1, 0]);
    assertEqual(row(dialog, 'Studio Pi'), null);
    await closed(dialog);
});
fresh('saying no to remove keeps the server', async () => {
    addServer(pi);
    const deps = fakeDeps();
    const dialog = showSettings(deps);
    [...walk(row(dialog, 'Studio Pi'))].find(widget =>
        widget instanceof Gtk.Button && widget.icon_name === 'user-trash-symbolic').emit('clicked');
    await pause();
    answer(openQuestion(), 'Cancel');
    await pause();
    assertEqual([deps.calls.removeServerKey, loadList().added.length], [0, 1]);
    await closed(dialog);
});
fresh('remove with an unreachable server still removes, and shows the notice', async () => {
    addServer(pi);
    const deps = fakeDeps({removeServerKey: async () => false});
    const dialog = showSettings(deps);
    [...walk(row(dialog, 'Studio Pi'))].find(widget =>
        widget instanceof Gtk.Button && widget.icon_name === 'user-trash-symbolic').emit('clicked');
    await pause();
    answer(openQuestion(), 'Remove');
    await pause();
    assertEqual(loadList().added.length, 0);
    assertEqual(textOn(dialog).includes('The key stayed on that server'), true);
    await closed(dialog);
});

// Add a server -----------------------------------------------------------------------

fresh('Connect is greyed until address and user are filled', async () => {
    const dialog = showAddServer(null, fakeDeps());
    assertEqual(connectButton(dialog).sensitive, false);
    fill(dialog, {address: '203.0.113.10'});
    assertEqual(connectButton(dialog).sensitive, false);
    fill(dialog, {address: '203.0.113.10', user: 'lucian'});
    assertEqual(connectButton(dialog).sensitive, true);
    await closed(dialog);
});
fresh('user@host in the address enables Connect', async () => {
    const dialog = showAddServer(null, fakeDeps());
    fill(dialog, {address: 'lucian@203.0.113.10'});
    assertEqual(connectButton(dialog).sensitive, true);
    await closed(dialog);
});
fresh('a bad address shows why, and stays on the form', async () => {
    const deps = fakeDeps();
    const dialog = showAddServer(null, deps);
    fill(dialog, {address: 'bad address', user: 'lucian'});
    connectButton(dialog).emit('clicked');
    await pause();
    assertEqual(deps.calls.setUpServer, 0);
    assertEqual(textOn(dialog).includes("That address has characters a server address can't have."), true);
    assertEqual(row(dialog, 'Server address').has_css_class('error'), true);
    await closed(dialog);
});
fresh('More options sets the name and the port', async () => {
    let seen = null;
    const deps = fakeDeps({setUpServer: async server => {
        seen = server;
    }});
    const dialog = showAddServer(null, deps);
    fill(dialog, ENTERED);
    row(dialog, 'Name').text = 'Studio Pi';
    row(dialog, 'Port').value = 2222;
    connectButton(dialog).emit('clicked');
    await pause();
    assertEqual([seen.name, seen.port], ['Studio Pi', 2222]);
    await closed(dialog);
});
fresh('the password reaches setup only', async () => {
    let seen = null;
    const deps = fakeDeps({setUpServer: async (_server, password) => {
        seen = password;
    }});
    const dialog = showAddServer(null, deps);
    fill(dialog, ENTERED);
    connectButton(dialog).emit('clicked');
    await pause();
    assertEqual(seen, 'secret');
    const [, saved] = GLib.file_get_contents(`${configDir()}/servers.json`);
    assertEqual(new TextDecoder().decode(saved).includes('secret'), false);
    await closed(dialog);
});
fresh('success empties the password and adds the server', async () => {
    const dialog = showAddServer(null, fakeDeps());
    fill(dialog, ENTERED);
    connectButton(dialog).emit('clicked');
    await pause();
    assertEqual(row(dialog, 'Password').text, '');
    assertEqual(loadList().added.map(server => server.address), ['203.0.113.10']);
    assertEqual(textOn(dialog).includes('203.0.113.10 is ready.'), true);
    assertEqual(button(dialog, 'Done').get_visible(), true);
    await closed(dialog);
});
fresh('the checklist follows the steps', async () => {
    let release;
    const hold = new Promise(resolve => {
        release = resolve;
    });
    const deps = fakeDeps({setUpServer: async (_server, _password, {onStep}) => {
        onStep('found', 'running');
        onStep('found', 'done');
        onStep('logged-in', 'running');
        await hold;
    }});
    const dialog = showAddServer(null, deps);
    fill(dialog, ENTERED);
    connectButton(dialog).emit('clicked');
    await pause();
    const state = title => {
        const widgets = [...walk(row(dialog, title))];
        if (widgets.some(widget => widget instanceof Adw.Spinner))
            return 'running';
        if (widgets.some(widget => widget instanceof Gtk.Image && widget.icon_name === 'object-select-symbolic'))
            return 'done';
        return 'waiting';
    };
    assertEqual(['Found the server', 'Logged in', 'Installed a secure key', 'Sending works'].map(state),
        ['done', 'running', 'waiting', 'waiting']);
    release();
    await pause();
    await closed(dialog);
});
fresh('the window keeps its width after Connect', async () => {
    let finishSetup;
    const setup = new Promise(resolve => {
        finishSetup = resolve;
    });
    const dialog = showAddServer(null, fakeDeps({setUpServer: () => setup}));
    fill(dialog, ENTERED);
    await pause(600);
    const before = dialog.get_root().get_width();
    connectButton(dialog).emit('clicked');
    await pause(600);
    assertEqual(dialog.get_root().get_width(), before);
    finishSetup();  // the message that appears now is what used to stretch the window
    await pause(600);
    assertEqual(dialog.get_root().get_width(), before);
    await closed(dialog);
});
fresh('a failed step shows the message; Back keeps the fields', async () => {
    const deps = fakeDeps({setUpServer: () => Promise.reject(new SetupError("203.0.113.10 isn't answering."))});
    const dialog = showAddServer(null, deps);
    fill(dialog, ENTERED);
    connectButton(dialog).emit('clicked');
    await pause();
    assertEqual(textOn(dialog).includes("203.0.113.10 isn't answering."), true);
    button(dialog, 'Back').emit('clicked');
    await pause();
    assertEqual([row(dialog, 'Server address').text, row(dialog, 'Username').text, row(dialog, 'Password').text],
        ['203.0.113.10', 'lucian', 'secret']);
    assertEqual(loadList().added.length, 0);
    await closed(dialog);
});
fresh('a rejected password is cleared', async () => {
    const deps = fakeDeps({setUpServer: () => Promise.reject(new SetupError('Wrong.', 'password'))});
    const dialog = showAddServer(null, deps);
    fill(dialog, ENTERED);
    connectButton(dialog).emit('clicked');
    await pause();
    assertEqual(row(dialog, 'Password').text, '');
    await closed(dialog);
});
fresh('saying no to the question goes back to the form', async () => {
    const deps = fakeDeps({setUpServer: () => Promise.reject(new SetupCancelled())});
    const dialog = showAddServer(null, deps);
    fill(dialog, ENTERED);
    connectButton(dialog).emit('clicked');
    await pause();
    assertEqual(connectButton(dialog).get_visible(), true);
    assertEqual(row(dialog, 'Server address').text, '203.0.113.10');
    await closed(dialog);
});

function hangingSetup(seen) {
    return {setUpServer: (_server, _password, options) => {
        Object.assign(seen, options);
        return new Promise((_resolve, reject) => {
            options.cancellable.connect(() => reject(new SetupCancelled()));
        });
    }};
}

fresh('closing during setup cancels it and saves nothing', async () => {
    const seen = {};
    const dialog = showAddServer(null, fakeDeps(hangingSetup(seen)));
    fill(dialog, ENTERED);
    connectButton(dialog).emit('clicked');
    await pause();
    await closed(dialog);
    await pause();
    assertEqual([seen.cancellable.is_cancelled(), loadList().added.length, row(dialog, 'Password').text],
        [true, 0, '']);
});
fresh('Cancel during setup stops the work', async () => {
    const seen = {};
    const dialog = showAddServer(null, fakeDeps(hangingSetup(seen)));
    fill(dialog, ENTERED);
    connectButton(dialog).emit('clicked');
    await pause();
    button(dialog, 'Cancel').emit('clicked');
    await pause();
    assertEqual(seen.cancellable.is_cancelled(), true);
});
fresh('a late step after closing causes no error', async () => {
    const seen = {};
    const dialog = showAddServer(null, fakeDeps(hangingSetup(seen)));
    fill(dialog, ENTERED);
    connectButton(dialog).emit('clicked');
    await pause();
    await closed(dialog);
    await pause();
    seen.onStep('key', 'running');
    seen.onStep('key', 'done');
    await pause();
});

async function askedQuestion(state) {
    const seen = {};
    const dialog = showAddServer(null, fakeDeps(hangingSetup(seen)));
    fill(dialog, ENTERED);
    connectButton(dialog).emit('clicked');
    await pause();
    const reply = seen.askTrust({state, fingerprint: 'SHA256:abc'});
    await pause();
    return {dialog, reply, question: openQuestion()};
}

fresh('the first-connection question uses the spec wording', async () => {
    const {dialog, reply, question} = await askedQuestion('new');
    assertEqual([question.heading, question.body], ['Is this your server?',
        "This computer hasn't connected to 203.0.113.10 before. Its ID is SHA256:abc. Continue only if you expected to connect to this server."]);
    answer(question, 'Trust and continue');
    assertEqual(await reply, true);
    await closed(dialog);
});
fresh('the changed-ID question uses the spec wording', async () => {
    const {dialog, reply, question} = await askedQuestion('changed');
    assertEqual([question.heading, question.body], ["This server's ID has changed",
        "203.0.113.10 has a different ID from the one saved on this computer. Continue only if you reinstalled this server. If you didn't, someone could be listening in. Its new ID is SHA256:abc."]);
    answer(question, 'Cancel');
    assertEqual(await reply, false);
    await closed(dialog);
});
fresh('Settings shows a server added while it is open', async () => {
    const deps = fakeDeps();
    const settings = showSettings(deps);
    row(settings, 'Add a server…').emit('activated');
    await pause();
    const form = everything().find(widget => widget instanceof Adw.Dialog && widget !== settings);
    fill(form, ENTERED);
    connectButton(form).emit('clicked');
    await pause();
    assertEqual(row(settings, '203.0.113.10')?.title, '203.0.113.10');
    await closed(settings);
});

reset();
await finish();
