// SPDX-License-Identifier: GPL-3.0-or-later
// The real add-on and the real tray in a separate, invisible GNOME Shell: pinned in the
// chosen corner, real key presses and real mouse clicks. Run through tests/addon.sh.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {assertEqual, finish, requireMadeUpHome, test} from './lib.js';
import {traySettings} from '../extension/app/preferences.js';
import {setSshHostOn} from '../extension/app/servers.js';

requireMadeUpHome();

const ADDON = 'screenshot-tray@zincoo.com';
const APP_ID = 'com.zincoo.ScreenshotTray';
const APP_PATH = '/com/zincoo/ScreenshotTray';
const MARGIN = 16;
const TEST_DIR = GLib.path_get_dirname(Gio.File.new_for_uri(import.meta.url).get_path());
const WORK = GLib.getenv('WORK');
const prefs = traySettings();

function pause(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function until(what, check, seconds = 20) {
    for (let i = 0; i < seconds * 10; i++) {
        if (await check())
            return;
        await pause(100);
    }
    throw new Error(`waited ${seconds} s for: ${what}`);
}

function shellCall(path, iface, method, args, reply) {
    return Gio.DBus.session.call_sync(iface, path, iface, method, args,
        new GLib.VariantType(reply), Gio.DBusCallFlags.NONE, 10000, null).recursiveUnpack();
}

function addOnInfo() {
    const [info] = shellCall('/org/gnome/Shell/Extensions', 'org.gnome.Shell.Extensions', 'GetExtensionInfo',
        new GLib.Variant('(s)', [ADDON]), '(a{sv})');
    return info;
}

function setAddOn(on) {
    shellCall('/org/gnome/Shell/Extensions', 'org.gnome.Shell.Extensions', on ? 'EnableExtension' : 'DisableExtension',
        new GLib.Variant('(s)', [ADDON]), '(b)');
}

// Runs a line of code inside the invisible Shell, through the probe add-on.
function probe(code) {
    const [ok, result] = shellCall('/org/gnome/Shell', 'org.gnome.Shell', 'Eval',
        new GLib.Variant('(s)', [code]), '(bs)');
    if (!ok)
        throw new Error(`the Shell said: ${result}`);
    return result === '' ? undefined : JSON.parse(result);
}

function askTray(action) {
    Gio.DBusActionGroup.get(Gio.DBus.session, APP_ID, APP_PATH).activate_action(action, null);
    Gio.DBus.session.flush_sync(null);
}

const windows = () => probe('trayProbe.windows()');
const windowTitled = title => windows().find(window => window.title === title);
const trayWindow = () => windowTitled('Screenshot Tray');
const settingsWindow = () => windowTitled('Settings');

function savedCards() {
    try {
        const [, bytes] = GLib.file_get_contents(GLib.getenv('SCREENSHOT_TRAY_STATE'));
        return JSON.parse(new TextDecoder().decode(bytes)).cards.length;
    } catch {
        return 0;
    }
}

// As GNOME does: a new file appears in the Screenshots folder.
function takeScreenshot(number) {
    Gio.File.new_for_path(`${WORK}/pictures/shot-${number}.png`)
        .copy(Gio.File.new_for_path(`${GLib.getenv('SCREENSHOT_TRAY_DIR')}/shot-${number}.png`), Gio.FileCopyFlags.NONE, null, null);
}

function resetSettings() {
    prefs.list_keys().forEach(key => prefs.reset(key));
    Gio.Settings.sync();
}

async function emptyTray() {
    askTray('clear');
    await until('the tray to empty', () => savedCards() === 0);
    await until('the tray window to hide', () => !trayWindow());
}

async function closeSettings() {
    if (!settingsWindow())
        return;
    probe('trayProbe.press("Escape")');
    try {
        await until('Settings to close', () => !settingsWindow(), 4);
    } catch (e) {
        throw new Error(`${e.message}; windows: ${JSON.stringify(windows().map(window => [window.title, window.focused]))}`);
    }
}

function clickGear() {
    const tray = trayWindow();
    // One card and nothing closed: the gear is alone in the row above the card.
    probe(`trayProbe.moveTo(${tray.x + 14 + 14}, ${tray.y + 14 + 12})`);
    return pause(150).then(() => probe('trayProbe.click()'));
}

async function settingsInFront(how) {
    await until(`Settings to open (${how})`, () => settingsWindow(), 5);
    try {
        await until(`Settings to have the keyboard (${how})`, () => settingsWindow().focused, 4);
    } catch (e) {
        savePicture(`front-${how}`);
        throw new Error(`${e.message}; focus: ${JSON.stringify(windows().filter(window => window.focused).map(window => window.title))}; order: ${JSON.stringify(probe('trayProbe.onTop()'))}`);
    }
    const order = probe('trayProbe.onTop()').filter(title => title !== 'Screenshot Tray');
    assertEqual(order.at(-1), 'Settings');
}

// While looking into a failure: TRAY_TEST_PICTURES=folder tests/addon.sh saves the screen.
function savePicture(name) {
    const folder = GLib.getenv('TRAY_TEST_PICTURES');
    if (folder)
        probe(`trayProbe.saveScreen(${JSON.stringify(`${folder}/${name}.png`)})`);
}

function shortcut(key, accelerator) {
    prefs.set_strv(key, accelerator ? [accelerator] : []);
    Gio.Settings.sync();
}

test('the add-on loads at login with no error, at the version the app asks for', async () => {
    await until('the add-on to be running', () => addOnInfo().state === 1, 60);
    const info = addOnInfo();
    assertEqual([info.version, info.error ?? ''], [2, '']);
    await until('the probe to be ready', () => {
        try {
            return probe('trayProbe.ready()') === true;
        } catch {
            return false;
        }
    }, 60);
    probe('trayProbe.leaveOverview()');
    await until('the overview to close', () => probe('trayProbe.inOverview()') === false);
    await until('the tray to be on the bus', () => {
        const [owned] = Gio.DBus.session.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'NameHasOwner', new GLib.Variant('(s)', [APP_ID]), new GLib.VariantType('(b)'), Gio.DBusCallFlags.NONE, 3000, null).recursiveUnpack();
        return owned;
    }, 30);
});
test('a new screenshot in the folder makes the tray appear, with its gear', async () => {
    resetSettings();
    setSshHostOn('build-box', true);    // cards pick up the list when they appear
    await pause(1500);                  // the tray starts watching just after it's on the bus
    takeScreenshot(1);
    await until('the tray window', () => trayWindow());
    await until('the tray in place', () => trayWindow().x === trayWindow().areaX + MARGIN);
    assertEqual([savedCards(), trayWindow().focused], [1, false]);
});
test('a real click on the gear opens Settings, and it gets the keyboard', async () => {
    await pause(500);
    savePicture('tray-with-gear');
    await clickGear();
    await settingsInFront('gear, nothing else open');
    savePicture('settings-from-gear');
    await closeSettings();
    assertEqual(savedCards(), 1);
});
let otherApp = null;
test('with another app in front, the gear still brings Settings to the front', async () => {
    otherApp = Gio.Subprocess.new(['gjs', '-m', `${TEST_DIR}/addon-other-app.js`], Gio.SubprocessFlags.NONE);
    await until('the other app', () => windowTitled('Other app')?.focused);
    await clickGear();
    await settingsInFront('gear over another app');
    await closeSettings();
});
test('with another app in front, a shortcut brings Settings to the front', async () => {
    shortcut('shortcut-settings', 'F6');
    await pause(500);
    probe('trayProbe.focus("Other app")');
    await until('the other app in front', () => windowTitled('Other app').focused);
    probe('trayProbe.press("F6")');
    await settingsInFront('shortcut over another app');
});
test('Settings left open behind another app comes back to the front with the shortcut', async () => {
    probe('trayProbe.focus("Other app")');
    await until('the other app in front', () => windowTitled('Other app').focused);
    probe('trayProbe.press("F6")');
    await settingsInFront('shortcut, already open');
});
test('Settings left open behind another app comes back to the front with the gear', async () => {
    probe('trayProbe.focus("Other app")');
    await until('the other app in front', () => windowTitled('Other app').focused);
    await clickGear();
    await settingsInFront('gear, already open');
});
test('Settings left open behind another app comes back to the front from the app icon menu', async () => {
    probe('trayProbe.focus("Other app")');
    await until('the other app in front', () => windowTitled('Other app').focused);
    probe('trayProbe.openFromAppIconMenu()');
    await settingsInFront('app icon menu, already open');
    await pause(200);
    await closeSettings();
    shortcut('shortcut-settings', '');
    otherApp.force_exit();
    await until('the other app to go', () => !windowTitled('Other app'));
});
test('a real click on a card\'s server button sends the picture', async () => {
    savePicture('before-server-button');
    const tray = trayWindow();
    const cardCentre = tray.x + 14 + (tray.width - 28) / 2;
    const cardBottom = tray.y + tray.height - 14;
    probe(`trayProbe.moveTo(${cardCentre}, ${cardBottom - 40})`);
    await pause(300);
    // Copy, Open and Send, 30 wide with 8 between, centred: Send is the last.
    probe(`trayProbe.moveTo(${cardCentre + 38}, ${cardBottom - 6 - 15})`);
    await pause(300);
    probe('trayProbe.click()');
    const stdin = `${WORK}/ssh.log.stdin`;
    savePicture('after-server-button');
    await until('the picture to reach ssh', () => GLib.file_test(stdin, GLib.FileTest.EXISTS), 10);
    await pause(300);
    const [, sent] = GLib.file_get_contents(stdin);
    const [, original] = GLib.file_get_contents(`${WORK}/pictures/shot-1.png`);
    assertEqual([sent.length, GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, sent)],
        [original.length, GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, original)]);
    const [, args] = GLib.file_get_contents(`${WORK}/ssh.log`);
    assertEqual(new TextDecoder().decode(args).includes('build-box'), true);
    setSshHostOn('build-box', false);
    probe('trayProbe.moveTo(640, 100)');
    await pause(200);
});
test('the tray is pinned bottom-left, above other windows, on every workspace', async () => {
    takeScreenshot(2);
    takeScreenshot(3);
    await until('three cards', () => savedCards() === 3);
    await until('the tray in place', () => {
        const tray = trayWindow();
        return tray.x === tray.areaX + MARGIN;
    });
    const tray = trayWindow();
    assertEqual([tray.y + tray.height, tray.above, tray.onAllWorkspaces, tray.skipsTaskbar],
        [tray.areaY + tray.areaHeight - MARGIN, true, true, true]);
});
test('changing the corner moves the tray right away, and back', async () => {
    prefs.set_string('corner', 'bottom-right');
    Gio.Settings.sync();
    await until('the tray at the right', () => {
        const tray = trayWindow();
        return tray.x + tray.width === tray.areaX + tray.areaWidth - MARGIN;
    });
    prefs.reset('corner');
    Gio.Settings.sync();
    await until('the tray back at the left', () => {
        const tray = trayWindow();
        return tray.x === tray.areaX + MARGIN;
    });
});
test('Cards to keep lowers the cards in the running tray', async () => {
    assertEqual(savedCards(), 3);
    prefs.set_int('max-cards', 1);
    Gio.Settings.sync();
    await until('one card left', () => savedCards() === 1);
    prefs.reset('max-cards');
    Gio.Settings.sync();
});
test('a key press with no shortcut set does nothing', async () => {
    await emptyTray();
    askTray('show-recent');
    await until('a card', () => savedCards() > 0);
    probe('trayProbe.press("F9")');
    await pause(800);
    assertEqual(savedCards() > 0, true);
});
test('a real key press runs a tray shortcut, set while it is running', async () => {
    shortcut('shortcut-clear', '<Control><Alt>j');
    await pause(500);
    probe('trayProbe.press("Control_L", "Alt_L", "j")');
    await until('the shortcut to clear the tray', () => savedCards() === 0);
    shortcut('shortcut-clear', '');
});
test('a real key press brings back the last closed', async () => {
    shortcut('shortcut-restore-last', 'F8');
    await pause(500);
    probe('trayProbe.press("F8")');
    await until('a card to come back', () => savedCards() === 1);
    shortcut('shortcut-restore-last', '');
});
test('a real key press shows the newest screenshots', async () => {
    await emptyTray();
    shortcut('shortcut-show-recent', 'F7');
    await pause(500);
    probe('trayProbe.press("F7")');
    await until('cards to appear', () => savedCards() > 0);
    shortcut('shortcut-show-recent', '');
});
test('a real key press opens Settings', async () => {
    shortcut('shortcut-settings', 'F6');
    await pause(500);
    probe('trayProbe.press("F6")');
    await until('Settings to open', () => settingsWindow());
    await closeSettings();
    shortcut('shortcut-settings', '');
});
test('recording a shortcut works with real keys: tab, row, keys, and then it runs', async () => {
    await emptyTray();
    shortcut('shortcut-settings', 'F6');
    await pause(500);
    probe('trayProbe.press("F6")');
    await settingsInFront('to record a shortcut');
    await pause(400);
    const win = settingsWindow();
    probe(`trayProbe.moveTo(${win.x + 443}, ${win.y + 22})`);   // the Shortcuts tab
    await pause(150);
    probe('trayProbe.click()');
    await pause(500);
    savePicture('shortcuts-tab');
    probe(`trayProbe.moveTo(${win.x + 200}, ${win.y + 397})`);  // Bring back the last closed
    await pause(150);
    probe('trayProbe.click()');
    await pause(500);
    savePicture('shortcut-question');
    probe('trayProbe.press("Control_L", "Alt_L", "k")');
    await until('the keys to be saved', () => {
        Gio.Settings.sync();
        return prefs.get_strv('shortcut-restore-last').length === 1;
    }, 6);
    savePicture('shortcut-saved');
    assertEqual(prefs.get_strv('shortcut-restore-last')[0].toLowerCase().replace('primary', 'control'), '<control><alt>k');
    await pause(300);
    await closeSettings();
    await pause(500);
    probe('trayProbe.press("Control_L", "Alt_L", "k")');
    await until('the recorded shortcut to bring a card back', () => savedCards() === 1);
    prefs.reset('shortcut-restore-last');
    shortcut('shortcut-settings', '');
});
test('switching the add-on off takes its shortcuts and tray away, and back on is clean', async () => {
    shortcut('shortcut-settings', 'F6');
    await pause(500);
    setAddOn(false);
    await until('the add-on to stop', () => addOnInfo().state === 2);
    await until('the tray window to go', () => !trayWindow());
    probe('trayProbe.press("F6")');
    await pause(800);
    assertEqual(settingsWindow() ?? null, null);
    setAddOn(true);
    await until('the add-on to run again', () => addOnInfo().state === 1);
    await pause(1500);
    probe('trayProbe.press("F6")');
    await settingsInFront('shortcut, after switching back on');
    await pause(300);
    await closeSettings();
    shortcut('shortcut-settings', '');
});
test('Settings on the app icon switches the add-on back on, and opens', async () => {
    setAddOn(false);
    await until('the add-on to stop', () => addOnInfo().state === 2);
    await until('the tray to leave the bus', () => !trayWindow());
    await pause(1500);
    const launch = Gio.Subprocess.new(['timeout', '30', 'gjs', '-m', `${TEST_DIR}/../extension/app/main.js`, '--settings'],
        Gio.SubprocessFlags.STDERR_SILENCE);
    await until('the add-on to run again', () => addOnInfo().state === 1);
    await settingsInFront('app icon menu, add-on was off');
    launch.force_exit();
    await pause(300);
    await closeSettings();
});
await finish();
