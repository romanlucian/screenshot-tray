// SPDX-License-Identifier: GPL-3.0-or-later
// An app that takes dropped files, for tests/addon.sh: it writes what it got to $DROP_LOG.

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

const app = new Gtk.Application({application_id: 'test.DropApp', flags: Gio.ApplicationFlags.NON_UNIQUE});
app.connect('activate', () => {
    const area = new Gtk.Label({label: 'Drop here', hexpand: true, vexpand: true});
    const target = Gtk.DropTarget.new(Gdk.FileList, Gdk.DragAction.COPY);
    target.connect('drop', (_target, files) => {
        const paths = files.get_files().map(file => file.get_path()).join('\n');
        GLib.file_set_contents(GLib.getenv('DROP_LOG'), `${paths}\n`);
        return true;
    });
    area.add_controller(target);
    new Gtk.ApplicationWindow({application: app, title: 'Drop app', default_width: 500, default_height: 400, child: area}).present();
});
await app.runAsync([System.programInvocationName]);
