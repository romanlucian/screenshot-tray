// SPDX-License-Identifier: GPL-3.0-or-later
// The Settings window: the servers a screenshot can be sent to. It goes online only
// when a button here is pressed, so a row says "Ready" only after its Test has passed.

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {inGreen, realDeps, showAddServer} from './add-server.js';
import {loadList, onServersChanged, removeServer, setSshHostOn, sshHosts} from './servers.js';

// Must not be the tray's own window title: the add-on pins only the window with that title.
const TITLE = 'Settings';
const OFF = 'Not offered on your cards';
const ICON = 'network-server-symbolic';

const escaped = text => GLib.markup_escape_text(text, -1);

let openDialog = null;

function addressOf(server) {
    const port = server.port === 22 ? '' : `:${server.port}`;
    return `${server.user}@${server.address}${port}`;
}

// A Test button for a row. plain is what the row says before and besides the result.
function testButton(deps, row, target, plain, passed) {
    const test = new Gtk.Button({label: 'Test', valign: Gtk.Align.CENTER});
    test.connect('clicked', () => {
        test.sensitive = false;
        row.subtitle = 'Testing…';
        deps.checkTarget(target)
            .then(() => {
                passed();
                row.subtitle = [escaped(plain()), inGreen('Ready')].filter(Boolean).join(' · ');
            })
            .catch(e => (row.subtitle = escaped(e.message)))
            .finally(() => (test.sensitive = true));
    });
    return test;
}

function addedRow(dialog, deps, server, ready) {
    const row = new Adw.ActionRow({title: escaped(server.name), subtitle: escaped(addressOf(server))});
    row.add_prefix(new Gtk.Image({icon_name: ICON}));
    if (ready.has(server.id))
        row.subtitle = `${escaped(addressOf(server))} · ${inGreen('Ready')}`;
    row.add_suffix(testButton(deps, row, {kind: 'added', ...server}, () => addressOf(server),
        () => ready.add(server.id)));

    const remove = new Gtk.Button({
        icon_name: 'user-trash-symbolic',
        tooltip_text: 'Remove',
        valign: Gtk.Align.CENTER,
    });
    remove.connect('clicked', () => {
        const question = new Adw.AlertDialog({
            heading: `Remove ${server.name}?`,
            body: 'Screenshots already sent stay on that server.',
        });
        question.add_response('cancel', 'Cancel');
        question.add_response('remove', 'Remove');
        question.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);
        question.default_response = 'cancel';
        question.close_response = 'cancel';
        question.connect('response', async (_question, response) => {
            if (response !== 'remove')
                return;
            row.sensitive = false;
            row.subtitle = 'Removing…';
            const keyGone = await deps.removeServerKey(server);
            await deps.forgetServerId(server);
            ready.delete(server.id);
            removeServer(server.id);
            if (!keyGone) {
                dialog.add_toast(new Adw.Toast({
                    title: 'The key stayed on that server. It can only drop screenshots into the inbox.',
                }));
            }
        });
        question.present(dialog);
    });
    row.add_suffix(remove);
    return row;
}

function sshGroup(deps, hosts, sshOn) {
    const group = new Adw.PreferencesGroup({
        title: 'Already in your SSH settings',
        description: 'Servers you set up yourself for the terminal. Turn one on to offer it on your cards.',
    });
    for (const host of hosts) {
        const row = new Adw.ActionRow({title: escaped(host)});
        row.add_prefix(new Gtk.Image({icon_name: ICON}));
        const test = testButton(deps, row, {kind: 'ssh', name: host}, () => '', () => {});
        const toggle = new Gtk.Switch({valign: Gtk.Align.CENTER, active: sshOn.includes(host)});
        const show = () => {
            test.visible = toggle.active;
            row.subtitle = toggle.active ? '' : OFF;
        };
        show();
        toggle.connect('notify::active', () => {
            setSshHostOn(host, toggle.active);
            show();
        });
        row.add_suffix(test);
        row.add_suffix(toggle);
        row.activatable_widget = toggle;
        group.add(row);
    }
    return group;
}

export function showSettings(deps = realDeps) {
    if (openDialog) {
        openDialog.get_root()?.present?.();
        return openDialog;
    }
    const dialog = new Adw.PreferencesDialog({title: TITLE, search_enabled: false});
    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup({
        title: 'Send to a server',
        description: 'Send a screenshot to a computer you own, then paste its path into Claude Code or Codex running there.',
    });
    page.add(group);

    const ready = new Set();
    let rows = [];
    let shownIds = null;
    const showServers = () => {
        const {added} = loadList();
        const ids = JSON.stringify(added.map(server => [server.id, server.name]));
        if (ids === shownIds)
            return;
        shownIds = ids;
        rows.forEach(row => group.remove(row));
        rows = added.map(server => addedRow(dialog, deps, server, ready));

        const add = new Adw.ActionRow({title: 'Add a server…', activatable: true});
        add.add_prefix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
        add.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
        add.connect('activated', () => showAddServer(dialog, deps));
        rows.push(add);
        rows.forEach(row => group.add(row));
    };
    showServers();

    const hosts = sshHosts();
    if (hosts.length > 0)
        page.add(sshGroup(deps, hosts, loadList().sshOn));

    const stopWatching = onServersChanged(showServers);
    dialog.connect('closed', () => {
        stopWatching();
        openDialog = null;
    });
    dialog.add(page);
    dialog.present(null);
    openDialog = dialog;
    return dialog;
}
