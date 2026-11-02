// SPDX-License-Identifier: GPL-3.0-or-later
// The gear button, the General and Shortcuts tabs, and what those settings do to the
// tray, drawn on an invisible display. Settings live in memory only, so your real
// shortcuts can't change. Run through tests/ui.sh.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gtk from 'gi://Gtk?version=4.0';

import {assertEqual, finish, requireMadeUpHome, requireMemorySettings, test} from './lib.js';
import {button, row, rows, walk} from './widgets.js';
import {showHelp} from '../extension/app/help.js';
import {
    ADDON_VERSION, gnomeShortcuts, passesThrough, readShortcut, traySettings,
} from '../extension/app/preferences.js';
import {showSettings} from '../extension/app/settings.js';
import {Tray} from '../extension/app/tray.js';

requireMadeUpHome();
requireMemorySettings();

const app = new Adw.Application({application_id: 'com.zincoo.ScreenshotTrayTests2', flags: Gio.ApplicationFlags.NON_UNIQUE});
app.register(null);
app.hold();

const prefs = traySettings();
const gnome = gnomeShortcuts();
const SHOTS = GLib.getenv('SCREENSHOT_TRAY_DIR');
const TEST_DIR = GLib.path_get_dirname(Gio.File.new_for_uri(import.meta.url).get_path());

function pause(ms = 20) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function closed(dialog) {
    dialog.close();
    await pause(50);
}

function resetAll() {
    prefs.list_keys().forEach(key => prefs.reset(key));
    gnome.list_keys().forEach(key => gnome.reset(key));
}

const stubs = (upToDate = true) => ({
    setUpServer: async () => {},
    checkTarget: async () => {},
    removeServerKey: async () => true,
    forgetServerId: async () => {},
    addOnIsUpToDate: async () => upToDate,
});

function open(page, upToDate = true) {
    return showSettings(stubs(upToDate), page);
}

// The window also holds a page of its own, with no title, for searching.
function tabs(dialog) {
    return [...walk(dialog)].filter(widget => widget instanceof Adw.PreferencesPage && widget.title !== '');
}

function pageOf(dialog, name) {
    return tabs(dialog).find(page => page.name === name);
}

function everything() {
    return Gtk.Window.list_toplevels().flatMap(window => [...walk(window)]);
}

function openQuestion() {
    return everything().find(widget => widget instanceof Adw.AlertDialog) ?? null;
}

function press(question, keyval, state = 0) {
    const controllers = question.observe_controllers();
    for (let i = 0; i < controllers.get_n_items(); i++) {
        const item = controllers.get_item(i);
        if (item instanceof Gtk.EventControllerKey)
            return item.emit('key-pressed', keyval, 0, state);
    }
    throw new Error('the question listens for no keys');
}

function shownShortcut(item) {
    return [...walk(item)].find(widget => widget instanceof Adw.ShortcutLabel);
}

function fresh(name, fn) {
    test(name, async () => {
        resetAll();
        await fn();
        resetAll();
    });
}

// The stored settings ---------------------------------------------------------------

fresh('every setting starts out working as the app does today', () => {
    assertEqual([prefs.get_int('max-cards'), prefs.get_string('corner'), prefs.get_boolean('keep-after-drag'),
        prefs.get_int('hide-after-minutes')], [5, 'bottom-left', false, 0]);
    for (const action of ['restore-last', 'show-recent', 'clear', 'settings'])
        assertEqual(prefs.get_strv(`shortcut-${action}`), []);
});
test('the add-on version the app asks for is the one in metadata.json', () => {
    const [, bytes] = GLib.file_get_contents(`${TEST_DIR}/../extension/metadata.json`);
    const metadata = JSON.parse(new TextDecoder().decode(bytes));
    assertEqual([metadata.version, metadata['settings-schema']],
        [ADDON_VERSION, 'org.gnome.shell.extensions.screenshot-tray']);
});

// What counts as a shortcut ----------------------------------------------------------

const {CONTROL_MASK: CTRL, SHIFT_MASK: SHIFT, ALT_MASK: ALT, SUPER_MASK: SUPER, HYPER_MASK: HYPER, META_MASK: META, LOCK_MASK: CAPS} = Gdk.ModifierType;

function parsed(accelerator) {
    const [, keyval, mods] = Gtk.accelerator_parse(accelerator);
    return [Gdk.keyval_name(keyval), mods];
}

test('Super plus a letter is a shortcut', () => {
    assertEqual(parsed(readShortcut(Gdk.KEY_b, SUPER).accelerator), ['b', SUPER]);
});
test('Ctrl+Shift plus a letter is a shortcut, in lower case', () => {
    assertEqual(parsed(readShortcut(Gdk.KEY_B, CTRL | SHIFT).accelerator), ['b', CTRL | SHIFT]);
});
test('Caps Lock is ignored', () => {
    assertEqual(parsed(readShortcut(Gdk.KEY_b, SUPER | CAPS).accelerator), ['b', SUPER]);
});
test('Super is not doubled by the Hyper or Meta a keyboard can report with it', () => {
    assertEqual(parsed(readShortcut(Gdk.KEY_b, SUPER | HYPER | META).accelerator), ['b', SUPER]);
});
test('Print and F5 work alone', () => {
    assertEqual(parsed(readShortcut(Gdk.KEY_Print, 0).accelerator), ['Print', 0]);
    assertEqual(parsed(readShortcut(Gdk.KEY_F5, 0).accelerator), ['F5', 0]);
});
test('Alt+Print stays Alt+Print, not SysRq', () => {
    assertEqual(parsed(readShortcut(Gdk.KEY_Sys_Req, ALT).accelerator), ['Print', ALT]);
});
test('a letter alone is refused, because it would break typing', () => {
    assertEqual(Boolean(readShortcut(Gdk.KEY_b, 0).error), true);
    assertEqual(Boolean(readShortcut(Gdk.KEY_B, SHIFT).error), true);
    assertEqual(Boolean(readShortcut(Gdk.KEY_4, 0).error), true);
    assertEqual(Boolean(readShortcut(Gdk.KEY_Delete, 0).error), true);
});
test('a modifier alone keeps waiting for the rest', () => {
    for (const key of [Gdk.KEY_Shift_L, Gdk.KEY_Control_R, Gdk.KEY_Alt_L, Gdk.KEY_Super_L, Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_Caps_Lock])
        assertEqual(readShortcut(key, 0), null);
});
test('Tab, Return and Space alone move around the window, with Ctrl they count', () => {
    for (const key of [Gdk.KEY_Tab, Gdk.KEY_ISO_Left_Tab, Gdk.KEY_Return, Gdk.KEY_space, Gdk.KEY_Up])
        assertEqual(passesThrough(key, 0), true);
    assertEqual(passesThrough(Gdk.KEY_Return, CTRL), false);
});

// The window ------------------------------------------------------------------------

fresh('Settings has three tabs, and General comes first', async () => {
    const dialog = open();
    assertEqual(tabs(dialog).map(page => page.title), ['General', 'Servers', 'Shortcuts']);
    assertEqual(dialog.visible_page_name, 'general');
    await closed(dialog);
});
fresh('every tab has an icon the desktop can draw', async () => {
    const dialog = open();
    const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
    for (const page of tabs(dialog))
        assertEqual([page.name, theme.has_icon(page.icon_name)], [page.name, true]);
    await closed(dialog);
});
fresh('Settings can open on one tab, also when already open', async () => {
    const dialog = open('servers');
    assertEqual(dialog.visible_page_name, 'servers');
    assertEqual(open('shortcuts') === dialog, true);
    assertEqual(dialog.visible_page_name, 'shortcuts');
    await closed(dialog);
});
fresh('How to use opens the Servers tab', async () => {
    const help = showHelp();
    row(help, 'Send to a server').emit('activated');
    await pause();
    const settings = everything().find(widget => widget instanceof Adw.PreferencesDialog && widget.title === 'Settings');
    assertEqual(settings.visible_page_name, 'servers');
    await closed(settings);
    await closed(help);
});
fresh('a note asks for a login while the running add-on is older', async () => {
    const dialog = open(null, false);
    await pause();
    const banners = [...walk(dialog)].filter(widget => widget instanceof Adw.Banner);
    assertEqual(banners.length, 2);
    assertEqual(banners.every(banner => banner.revealed && banner.title.includes('Log out and back in once')), true);
    await closed(dialog);
});
fresh('no note once the add-on is up to date', async () => {
    const dialog = open(null, true);
    await pause();
    assertEqual([...walk(dialog)].filter(widget => widget instanceof Adw.Banner).some(banner => banner.revealed), false);
    await closed(dialog);
});

// General ---------------------------------------------------------------------------

fresh('General shows and saves Cards to keep', async () => {
    prefs.set_int('max-cards', 3);
    const dialog = open();
    assertEqual(row(dialog, 'Cards to keep').value, 3);
    row(dialog, 'Cards to keep').value = 2;
    assertEqual(prefs.get_int('max-cards'), 2);
    await closed(dialog);
});
fresh('Cards to keep stops at 1 and at 5', async () => {
    const dialog = open();
    const cards = row(dialog, 'Cards to keep');
    assertEqual([cards.adjustment.lower, cards.adjustment.upper], [1, 5]);
    await closed(dialog);
});
fresh('General shows and saves the screen corner', async () => {
    prefs.set_string('corner', 'bottom-right');
    const dialog = open();
    const corner = row(dialog, 'Screen corner');
    assertEqual(corner.selected, 1);
    corner.selected = 0;
    assertEqual(prefs.get_string('corner'), 'bottom-left');
    await closed(dialog);
});
fresh('General shows and saves Keep after dragging', async () => {
    const dialog = open();
    const keep = row(dialog, 'Keep after dragging');
    assertEqual(keep.active, false);
    keep.active = true;
    assertEqual(prefs.get_boolean('keep-after-drag'), true);
    await closed(dialog);
});
fresh('General offers Never, 5, 15 and 60 minutes', async () => {
    prefs.set_int('hide-after-minutes', 15);
    const dialog = open();
    const hide = row(dialog, 'Hide old cards');
    assertEqual(hide.selected, 2);
    const model = hide.model;
    assertEqual([...Array(model.get_n_items()).keys()].map(index => model.get_string(index)),
        ['Never', 'After 5 minutes', 'After 15 minutes', 'After 1 hour']);
    hide.selected = 3;
    assertEqual(prefs.get_int('hide-after-minutes'), 60);
    hide.selected = 0;
    assertEqual(prefs.get_int('hide-after-minutes'), 0);
    await closed(dialog);
});

// Shortcuts -------------------------------------------------------------------------

const TRAY_TITLES = ['Bring back the last closed', 'Show the newest screenshots', 'Clear the tray', 'Open Settings'];
const GNOME_TITLES = ['Open the screenshot tool', 'Whole screen', 'Current window'];

async function recording(dialog, title) {
    row(dialog, title).emit('activated');
    await pause();
    return openQuestion();
}

fresh('Shortcuts lists GNOME\'s three and the tray\'s four, with what is set', async () => {
    gnome.set_strv('screenshot', ['<Shift>Print']);
    const dialog = open('shortcuts');
    assertEqual(rows(pageOf(dialog, 'shortcuts')).map(item => item.title), [...GNOME_TITLES, ...TRAY_TITLES]);
    assertEqual(shownShortcut(row(dialog, 'Whole screen')).accelerator, '<Shift>Print');
    assertEqual(TRAY_TITLES.map(title => shownShortcut(row(dialog, title)).accelerator), ['', '', '', '']);
    assertEqual(shownShortcut(row(dialog, 'Clear the tray')).disabled_text, 'Not set');
    await closed(dialog);
});
fresh('pressing keys saves a tray shortcut, shows it and closes the question', async () => {
    const dialog = open('shortcuts');
    const question = await recording(dialog, 'Clear the tray');
    assertEqual(press(question, Gdk.KEY_c, SUPER), true);
    await pause(50);
    assertEqual(parsed(prefs.get_strv('shortcut-clear')[0]), ['c', SUPER]);
    assertEqual(parsed(shownShortcut(row(dialog, 'Clear the tray')).accelerator), ['c', SUPER]);
    assertEqual(openQuestion(), null);
    await closed(dialog);
});
fresh('pressing keys changes GNOME\'s own shortcut', async () => {
    const dialog = open('shortcuts');
    const question = await recording(dialog, 'Whole screen');
    press(question, Gdk.KEY_F9);
    await pause(50);
    assertEqual(gnome.get_strv('screenshot'), ['F9']);
    await closed(dialog);
});
fresh('a letter alone is refused, and the question stays open and says why', async () => {
    const dialog = open('shortcuts');
    const question = await recording(dialog, 'Clear the tray');
    assertEqual(press(question, Gdk.KEY_b), true);
    await pause();
    assertEqual([prefs.get_strv('shortcut-clear'), openQuestion() === question], [[], true]);
    assertEqual(question.body.includes('Ctrl, Alt or Super'), true);
    button(question, 'Cancel').emit('clicked');
    await pause(50);
    await closed(dialog);
});
fresh('a shortcut already in this list is refused, naming what uses it', async () => {
    prefs.set_strv('shortcut-settings', ['<Super>s']);
    const dialog = open('shortcuts');
    const question = await recording(dialog, 'Clear the tray');
    press(question, Gdk.KEY_s, SUPER);
    await pause();
    assertEqual(prefs.get_strv('shortcut-clear'), []);
    assertEqual(question.body.includes('Open Settings'), true);
    button(question, 'Cancel').emit('clicked');
    await pause(50);
    await closed(dialog);
});
fresh('pressing a row\'s own shortcut again is fine', async () => {
    prefs.set_strv('shortcut-clear', ['<Super>c']);
    const dialog = open('shortcuts');
    const question = await recording(dialog, 'Clear the tray');
    press(question, Gdk.KEY_c, SUPER);
    await pause(50);
    assertEqual(openQuestion(), null);
    await closed(dialog);
});
fresh('Esc cancels and changes nothing', async () => {
    prefs.set_strv('shortcut-clear', ['<Super>c']);
    const dialog = open('shortcuts');
    const question = await recording(dialog, 'Clear the tray');
    press(question, Gdk.KEY_Escape);
    await pause(50);
    assertEqual([prefs.get_strv('shortcut-clear'), openQuestion()], [['<Super>c'], null]);
    await closed(dialog);
});
fresh('Clear empties a shortcut', async () => {
    prefs.set_strv('shortcut-clear', ['<Super>c']);
    const dialog = open('shortcuts');
    const question = await recording(dialog, 'Clear the tray');
    button(question, 'Clear').emit('clicked');
    await pause(50);
    assertEqual(prefs.get_strv('shortcut-clear'), []);
    assertEqual(shownShortcut(row(dialog, 'Clear the tray')).accelerator, '');
    await closed(dialog);
});
fresh('only GNOME\'s rows offer GNOME\'s default, and it restores it', async () => {
    gnome.set_strv('screenshot', ['F9']);
    const dialog = open('shortcuts');
    const tray = await recording(dialog, 'Clear the tray');
    assertEqual(button(tray, 'Use GNOME\'s default'), null);
    button(tray, 'Cancel').emit('clicked');
    await pause(50);
    const own = await recording(dialog, 'Whole screen');
    button(own, 'Use GNOME\'s default').emit('clicked');
    await pause(50);
    assertEqual(gnome.get_strv('screenshot'), gnome.get_default_value('screenshot').deepUnpack());
    await closed(dialog);
});
fresh('a shortcut with an unusual key still shows', async () => {
    gnome.set_strv('screenshot-window', ['<Alt>Launch9']);
    gnome.set_strv('show-screenshot-ui', ['<Shift>plusminus']);
    const dialog = open('shortcuts');
    assertEqual(shownShortcut(row(dialog, 'Current window')).accelerator, '<Alt>Launch9');
    assertEqual(shownShortcut(row(dialog, 'Open the screenshot tool')).accelerator, '<Shift>plusminus');
    await closed(dialog);
});

// The tray --------------------------------------------------------------------------

function makeShots(count) {
    GLib.mkdir_with_parents(SHOTS, 0o700);
    for (let i = 1; i <= count; i++) {
        const picture = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 400, 200);
        picture.fill(0x336699ff);
        picture.savev(`${SHOTS}/shot-${i}.png`, 'png', [], []);
    }
}

makeShots(6);
const tray = new Tray(app, {managed: false});
tray.followSettings();

function freshTray(name, fn) {
    fresh(name, async () => {
        prefs.reset('max-cards');
        await pause(5);
        tray.clear();
        await fn();
        tray.clear();
        await pause(5);
    });
}

const shown = () => tray.cards.map(card => GLib.path_get_basename(card.path));

freshTray('the gear shows with one card, and opens Settings', async () => {
    tray.preload(1);
    assertEqual([tray.gear.get_visible(), tray.gear.get_parent().get_visible(), tray.gear.tooltip_text, tray.gear.icon_name],
        [true, true, 'Settings', 'emblem-system-symbolic']);
    tray.gear.emit('clicked');
    await pause();
    const settings = everything().find(widget => widget instanceof Adw.PreferencesDialog && widget.title === 'Settings');
    assertEqual(settings?.visible_page_name, 'general');
    await closed(settings);
});
freshTray('lowering Cards to keep moves the oldest to Bring back straight away', async () => {
    tray.preload(4);
    const before = shown();
    prefs.set_int('max-cards', 2);
    await pause();
    assertEqual(shown(), before.slice(2));
    assertEqual(tray.restoreLast(), true);
    assertEqual(shown().length, 2);     // the limit still holds for what comes back
});
freshTray('a new card pushes out the oldest at the chosen limit', async () => {
    prefs.set_int('max-cards', 1);
    tray.preload(2);
    assertEqual(shown().length, 1);
});
freshTray('with the default, five cards stay', async () => {
    tray.preload(6);
    assertEqual(shown().length, 5);
});
freshTray('a delivered drag makes the card leave by default', async () => {
    tray.preload(1);
    tray.cards[0].dragEnded(Gdk.DragAction.COPY);
    await pause();
    assertEqual(shown(), []);
});
freshTray('Keep after dragging keeps a delivered card', async () => {
    prefs.set_boolean('keep-after-drag', true);
    tray.preload(1);
    tray.cards[0].dragEnded(Gdk.DragAction.COPY);
    await pause();
    assertEqual(shown().length, 1);
});
freshTray('a refused drag always keeps the card', async () => {
    tray.preload(1);
    tray.cards[0].dragEnded(0);
    await pause();
    assertEqual(shown().length, 1);
});

const MINUTE = 60e6;

freshTray('Never hides nothing, however old', async () => {
    tray.preload(1);
    tray.hideOldCards(tray.cards[0].shownAt + 10000 * MINUTE);
    assertEqual(shown().length, 1);
});
freshTray('a card leaves after the chosen time, and only then', async () => {
    prefs.set_int('hide-after-minutes', 5);
    tray.preload(1);
    const {shownAt} = tray.cards[0];
    tray.hideOldCards(shownAt + 4.9 * MINUTE);
    assertEqual(shown().length, 1);
    tray.hideOldCards(shownAt + 5 * MINUTE);
    assertEqual(shown(), []);
});
freshTray('a hidden card can be brought back, and its file stays', async () => {
    prefs.set_int('hide-after-minutes', 5);
    tray.preload(1);
    const {path, shownAt} = tray.cards[0];
    tray.hideOldCards(shownAt + 6 * MINUTE);
    assertEqual(GLib.file_test(path, GLib.FileTest.EXISTS), true);
    assertEqual(tray.restoreLast(), true);
    assertEqual(tray.cards[0].path, path);
    assertEqual(tray.cards[0].shownAt > shownAt, true);
});
freshTray('a card in use is not hidden', async () => {
    prefs.set_int('hide-after-minutes', 5);
    tray.preload(1);
    const [card] = tray.cards;
    const later = card.shownAt + 6 * MINUTE;
    card.dragBegan();
    tray.hideOldCards(later);
    assertEqual(shown().length, 1);
    card.dragEnded(0);
    tray.hideOldCards(later);
    assertEqual(shown(), []);
});
freshTray('a card stays while it is being sent', async () => {
    prefs.set_int('hide-after-minutes', 5);
    tray.preload(1);
    const [card] = tray.cards;
    card.sending = true;
    tray.hideOldCards(card.shownAt + 6 * MINUTE);
    assertEqual(shown().length, 1);
    card.sending = false;
});
freshTray('the right corner lines the cards and buttons up on the right', async () => {
    tray.preload(2);
    assertEqual(tray.gear.get_parent().halign, Gtk.Align.START);
    prefs.set_string('corner', 'bottom-right');
    await pause();
    assertEqual([tray.gear.get_parent().halign, ...tray.cards.map(card => card.widget.halign)],
        [Gtk.Align.END, Gtk.Align.END, Gtk.Align.END]);
    tray.preload(3);
    assertEqual(tray.cards.every(card => card.widget.halign === Gtk.Align.END), true);
    prefs.reset('corner');
    await pause();
    assertEqual(tray.cards.every(card => card.widget.halign === Gtk.Align.START), true);
});

// Right-click the app icon › Settings ------------------------------------------------

test('main.js --settings asks the running tray to open Settings, and ends', async () => {
    const running = new Gio.Application({application_id: 'com.zincoo.ScreenshotTray', flags: Gio.ApplicationFlags.DEFAULT_FLAGS});
    let asked = 0;
    const action = new Gio.SimpleAction({name: 'settings'});
    action.connect('activate', () => asked++);
    running.add_action(action);
    running.register(null);
    const launch = Gio.Subprocess.new(['timeout', '20', 'gjs', '-m', `${TEST_DIR}/../extension/app/main.js`, '--settings'],
        Gio.SubprocessFlags.STDERR_SILENCE);
    let ended = false;
    launch.wait_async(null, () => {
        ended = true;
    });
    for (let i = 0; i < 100 && (!ended || asked === 0); i++)
        await pause(100);
    assertEqual([asked, ended, launch.get_if_exited() && launch.get_exit_status()], [1, true, 0]);
});

resetAll();
await finish();
