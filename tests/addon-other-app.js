// SPDX-License-Identifier: GPL-3.0-or-later
// A big ordinary window, for tests/addon.sh: what you are working in when Settings opens.

import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

const app = new Gtk.Application({application_id: 'test.OtherApp', flags: Gio.ApplicationFlags.NON_UNIQUE});
app.connect('activate', () => {
    new Gtk.ApplicationWindow({application: app, title: 'Other app', default_width: 1100, default_height: 700}).present();
});
await app.runAsync([System.programInvocationName]);
