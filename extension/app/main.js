// SPDX-License-Identifier: GPL-3.0-or-later
// Screenshot Tray: starts the tray (tray.js) and answers what the top-bar menu asks of it.
//
// The GNOME Shell add-on (../extension.js) starts this with --managed and pins its
// window in the bottom corner. Without the add-on it runs as an ordinary window with a
// title bar that stays open, so it can be placed by hand:
//     gjs -m main.js              (add --preload=3 to show the 3 newest at once)

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

import {showAbout, showHelp} from './help.js';
import {showSettings} from './settings.js';
import {Tray} from './tray.js';

const APP_ID = 'com.zincoo.ScreenshotTray';
const ADDON_UUID = 'screenshot-tray@zincoo.com';
const APP_PATH = '/com/zincoo/ScreenshotTray';
const MANAGED = System.programArgs.includes('--managed');
const OPEN_SETTINGS = System.programArgs.includes('--settings');
const APP_DIR = GLib.path_get_dirname(Gio.File.new_for_uri(import.meta.url).get_path());

function log(message) {
    console.log(`Screenshot Tray: ${message}`);
}

// Started from the app list while the add-on is switched off (after "Quit" in its
// top-bar menu): switch the add-on back on, which starts the pinned tray. Returns
// false when there's nothing to switch on, and the tray then opens as a window.
function switchAddOnOn() {
    const call = (method, replyType) => Gio.DBus.session.call_sync(
        'org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions', 'org.gnome.Shell.Extensions',
        method, new GLib.Variant('(s)', [ADDON_UUID]), new GLib.VariantType(replyType),
        Gio.DBusCallFlags.NONE, 3000, null).recursiveUnpack();
    try {
        const [info] = call('GetExtensionInfo', '(a{sv})');
        // 2 = switched off, 6 = loaded but never switched on (GNOME's ExtensionState)
        if (info.state !== 2 && info.state !== 6)
            return false;
        const [switchedOn] = call('EnableExtension', '(b)');
        return switchedOn;
    } catch {
        return false;   // no GNOME Shell to ask, e.g. in the README-image sandbox
    }
}

// Waits for the tray to be on the session bus. Returns false if it doesn't come in time.
function trayAppears(waitMs) {
    const loop = new GLib.MainLoop(null, false);
    let appeared = false;
    const watch = Gio.bus_watch_name(Gio.BusType.SESSION, APP_ID, Gio.BusNameWatcherFlags.NONE, () => {
        appeared = true;
        loop.quit();
    }, null);
    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, waitMs, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    loop.run();
    Gio.bus_unwatch_name(watch);
    if (!appeared)
        GLib.source_remove(timer);
    return appeared;
}

// "Settings" on the app icon's right-click menu: reaches the tray that is running, after
// switching the add-on back on if needed. Returns false when there is no tray to reach.
function askTrayForSettings() {
    const wasOff = switchAddOnOn();
    if (!trayAppears(wasOff ? 10000 : 500))
        return false;
    Gio.DBusActionGroup.get(Gio.DBus.session, APP_ID, APP_PATH).activate_action('settings', null);
    Gio.DBus.session.flush_sync(null);
    return true;
}

function loadStyle() {
    const provider = new Gtk.CssProvider();
    provider.load_from_path(GLib.build_filenamev([APP_DIR, 'style.css']));
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

const preloadArg = System.programArgs.find(arg => arg.startsWith('--preload='));
const preloadCount = preloadArg ? Math.max(0, parseInt(preloadArg.split('=')[1]) || 0) : 0;
const renderPath = System.programArgs.find(arg => arg.startsWith('--render='))?.slice('--render='.length);

// One tray at a time: starting the app again (say from the app list) reaches the
// tray that is already running instead of opening a second one.
const app = new Adw.Application({
    application_id: APP_ID,
    flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
});
let tray = null;
let activations = 0;
app.connect('startup', () => {
    loadStyle();
    tray = new Tray(app, {managed: MANAGED});
    tray.restore();
    tray.watch();
    tray.followServers();
    tray.followSettings();
    if (preloadCount > 0)
        tray.preload(preloadCount);
    if (renderPath)
        tray.renderTo(renderPath);

    // What the top-bar menu (in the add-on) can ask the tray to do.
    for (const [name, run] of [
        ['restore-last', () => tray.restoreLast()],
        ['show-recent', () => tray.preload(3)],
        ['clear', () => tray.clear()],
        ['open-folder', () => tray.openFolder()],
        ['settings', () => showSettings()],
        ['help', () => showHelp()],
        ['about', () => showAbout()],
    ]) {
        const action = new Gio.SimpleAction({name});
        action.connect('activate', () => run());
        app.add_action(action);
    }
    app.hold();     // keep running while the tray is empty and hidden
});
app.connect('activate', () => {
    // The first activation is this tray starting up; later ones are repeat launches.
    if (activations++ > 0)
        tray.bringBack();
    else if (OPEN_SETTINGS)
        showSettings();
});

if (OPEN_SETTINGS ? askTrayForSettings() : !MANAGED && !renderPath && preloadCount === 0 && switchAddOnOn())
    log(OPEN_SETTINGS ? 'asked the tray to open Settings' : 'the add-on was switched off; switched it back on, and it starts the tray');
else
    await app.runAsync([System.programInvocationName]);
