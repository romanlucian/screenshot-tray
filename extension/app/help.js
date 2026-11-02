// SPDX-License-Identifier: GPL-3.0-or-later
// The "How to use" and "About" windows, opened from the top-bar menu.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

import {showSettings} from './settings.js';

// Must not be the tray's own window title: the add-on pins only the window with that title.
const HELP_TITLE = 'How to use Screenshot Tray';

const EVERYDAY = [
    ['camera-photo-symbolic', 'Take a screenshot',
        'Use your usual screenshot shortcut (Print, unless you changed it). The screenshot appears in the tray, in the corner of the screen.'],
    ['input-mouse-symbolic', 'Drag a card into any app',
        'A terminal gets the file\'s path, which Claude Code and Codex understand. A browser, chat or email gets the file. Once an app takes it, the card leaves the tray.'],
    ['edit-copy-symbolic', 'Hover a card for more',
        'Copy the picture, open it, send it to a server, or close the card with ✕. The file always stays in Pictures › Screenshots.'],
    ['edit-undo-symbolic', 'Bring back',
        'Closed a card by mistake? Press Bring back at the top of the tray, or choose it in the top-bar menu.'],
    ['emblem-system-symbolic', 'Settings',
        'Press the gear above your cards, or choose Settings in the top-bar menu. It also sits in the menu you get when you right-click the app\'s icon.'],
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
    const servers = row('Send to a server', 'Set up the servers your cards can send to.',
        'network-server-symbolic');
    servers.activatable = true;
    servers.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
    servers.connect('activated', () => showSettings(undefined, 'servers'));
    everyday.add(servers);
    page.add(everyday);

    dialog.add(page);
    dialog.present(null);
    return dialog;
}

export function showAbout() {
    const about = new Adw.AboutDialog({
        application_name: 'Screenshot Tray',
        application_icon: 'com.zincoo.ScreenshotTray',
        developer_name: 'Zincoo · Lucian Roman',
        version: '1.2',
        website: 'https://zincoo.com',
        comments: 'Your latest screenshots float in the corner of the screen, ready to drag into any app.',
        copyright: '© 2026 Lucian Roman, Zincoo',
        license_type: Gtk.License.GPL_3_0,
    });
    about.present(null);
    return about;
}
