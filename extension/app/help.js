// SPDX-License-Identifier: GPL-3.0-or-later
// The "How to use" and "About" windows, opened from the top-bar menu.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

import {checkServer, openSshConfig, sshHosts} from './servers.js';

// Must not be the tray's own window title: the add-on pins only the window with that title.
const HELP_TITLE = 'How to use Screenshot Tray';

const EVERYDAY = [
    ['camera-photo-symbolic', 'Take a screenshot',
        'Use your usual screenshot shortcut (Print, unless you changed it). The screenshot appears in the tray, in the bottom-left corner.'],
    ['input-mouse-symbolic', 'Drag a card into any app',
        'A terminal gets the file\'s path, which Claude Code and Codex understand. A browser, chat or email gets the file. Once an app takes it, the card leaves the tray.'],
    ['edit-copy-symbolic', 'Hover a card for more',
        'Copy the picture, open it, send it to a server, or close the card with ✕. The file always stays in Pictures › Screenshots.'],
    ['edit-undo-symbolic', 'Bring back',
        'Closed a card by mistake? Press Bring back at the top of the tray, or choose it in the top-bar menu.'],
    ['application-exit-symbolic', 'Quit and start again',
        'Top-bar icon › Quit Screenshot Tray switches it off. Click Screenshot Tray in the app list to switch it back on.'],
];

function row(title, subtitle, iconName) {
    const actionRow = new Adw.ActionRow({title, subtitle, subtitle_lines: 0});
    if (iconName)
        actionRow.add_prefix(new Gtk.Image({icon_name: iconName}));
    return actionRow;
}

export function showHelp() {
    const dialog = new Adw.PreferencesDialog({title: HELP_TITLE, search_enabled: false});
    const page = new Adw.PreferencesPage();

    const everyday = new Adw.PreferencesGroup({title: 'Everyday use'});
    for (const [icon, title, subtitle] of EVERYDAY)
        everyday.add(row(title, subtitle, icon));
    page.add(everyday);

    const servers = new Adw.PreferencesGroup({
        title: 'Send to a server',
        description: 'For Claude Code or Codex running on another computer over SSH. The server ' +
            'button on a card uploads the screenshot there and copies its path: click in that ' +
            'terminal and press Ctrl+Shift+V. Servers need an SSH key (no passwords), and you ' +
            'should connect once by hand first.',
    });
    const hosts = sshHosts();
    if (hosts.length === 0) {
        servers.add(row('No servers yet',
            'Servers come from your SSH settings. Add one with the button below; its server button then appears on new cards.',
            'network-server-symbolic'));
    }
    for (const host of hosts) {
        const serverRow = row(host, 'Press Test to check that sending works.', 'network-server-symbolic');
        const test = new Gtk.Button({label: 'Test', valign: Gtk.Align.CENTER});
        test.connect('clicked', () => {
            test.sensitive = false;
            serverRow.subtitle = 'Testing…';
            checkServer(host)
                .then(() => (serverRow.subtitle = '✓ Ready: sending to this server works.'))
                .catch(e => (serverRow.subtitle = e.message))
                .finally(() => (test.sensitive = true));
        });
        serverRow.add_suffix(test);
        servers.add(serverRow);
    }
    const edit = row('Edit the server list', 'Opens your SSH settings (~/.ssh/config) in the text editor.',
        'document-edit-symbolic');
    edit.activatable = true;
    edit.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
    edit.connect('activated', () => {
        try {
            openSshConfig(Gdk.Display.get_default().get_app_launch_context());
        } catch (e) {
            edit.subtitle = `Couldn't open it: ${e.message}`;
        }
    });
    servers.add(edit);
    page.add(servers);

    dialog.add(page);
    dialog.present(null);
    return dialog;
}

export function showAbout() {
    const about = new Adw.AboutDialog({
        application_name: 'Screenshot Tray',
        application_icon: 'com.zincoo.ScreenshotTray',
        developer_name: 'Zincoo · Lucian Roman',
        version: '1.0',
        website: 'https://zincoo.com',
        comments: 'Your latest screenshots float in the corner of the screen, ready to drag into any app.',
        copyright: '© 2026 Lucian Roman, Zincoo',
        license_type: Gtk.License.GPL_3_0,
    });
    about.present(null);
    return about;
}
