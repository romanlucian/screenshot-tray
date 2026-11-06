// SPDX-License-Identifier: GPL-3.0-or-later
// The tray's settings, shared with the add-on, GNOME's own screenshot shortcuts, and the
// rules for what counts as a keyboard shortcut. Nothing here goes online.

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const APP_DIR = GLib.path_get_dirname(Gio.File.new_for_uri(import.meta.url).get_path());
const SCHEMA = 'org.gnome.shell.extensions.screenshot-tray';
const GNOME_SCHEMA = 'org.gnome.shell.keybindings';
const ADDON_UUID = 'screenshot-tray@zincoo.com';

// The add-on version that reads these settings: "version" in ../metadata.json.
export const ADDON_VERSION = 2;

export const TRAY_SHORTCUTS = [
    ['shortcut-restore-last', 'Bring back the last closed'],
    ['shortcut-show-recent', 'Show the newest screenshots'],
    ['shortcut-clear', 'Clear the tray'],
    ['shortcut-settings', 'Open Settings'],
];
export const GNOME_SHORTCUTS = [
    ['show-screenshot-ui', 'Open the screenshot tool'],
    ['screenshot', 'Whole screen'],
    ['screenshot-window', 'Current window'],
];

let settings = null;

export function traySettings() {
    if (!settings) {
        const source = Gio.SettingsSchemaSource.new_from_directory(
            GLib.build_filenamev([APP_DIR, '..', 'schemas']), Gio.SettingsSchemaSource.get_default(), false);
        settings = new Gio.Settings({settings_schema: source.lookup(SCHEMA, false)});
    }
    return settings;
}

// GNOME's own settings for taking a screenshot, or null on a desktop without them.
export function gnomeShortcuts() {
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup(GNOME_SCHEMA, true);
    if (!schema || !GNOME_SHORTCUTS.every(([key]) => schema.has_key(key)))
        return null;
    return new Gio.Settings({settings_schema: schema});
}

// GNOME Shell loads an add-on at login, so a newer one on disk isn't running until then.
export function addOnIsUpToDate() {
    return new Promise(resolve => {
        Gio.DBus.session.call('org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions',
            'org.gnome.Shell.Extensions', 'GetExtensionInfo', new GLib.Variant('(s)', [ADDON_UUID]),
            new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE, 3000, null, (bus, result) => {
                try {
                    const [info] = bus.call_finish(result).recursiveUnpack();
                    resolve(info.version >= ADDON_VERSION);
                } catch {
                    resolve(false);     // no GNOME Shell to ask
                }
            });
    });
}

const MODIFIER_KEYS = new Set([
    Gdk.KEY_Shift_L, Gdk.KEY_Shift_R, Gdk.KEY_Control_L, Gdk.KEY_Control_R, Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
    Gdk.KEY_Meta_L, Gdk.KEY_Meta_R, Gdk.KEY_Super_L, Gdk.KEY_Super_R, Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
    Gdk.KEY_Caps_Lock, Gdk.KEY_Shift_Lock, Gdk.KEY_Num_Lock, Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_ISO_Level5_Shift,
    Gdk.KEY_Mode_switch, Gdk.KEY_Multi_key,
]);
// Keys that move around a window. Alone, they still do that while a shortcut is asked for.
const MOVING_KEYS = new Set([
    Gdk.KEY_Tab, Gdk.KEY_ISO_Left_Tab, Gdk.KEY_Return, Gdk.KEY_KP_Enter, Gdk.KEY_space,
    Gdk.KEY_Up, Gdk.KEY_Down, Gdk.KEY_Left, Gdk.KEY_Right,
]);
const STRONG = Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK | Gdk.ModifierType.SUPER_MASK |
    Gdk.ModifierType.HYPER_MASK | Gdk.ModifierType.META_MASK;

function cleanModifiers(state) {
    let mods = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;
    // Some keyboards report Super together with Hyper or Meta, and Alt together with Meta.
    if (mods & Gdk.ModifierType.SUPER_MASK)
        mods &= ~(Gdk.ModifierType.HYPER_MASK | Gdk.ModifierType.META_MASK);
    if (mods & Gdk.ModifierType.ALT_MASK)
        mods &= ~Gdk.ModifierType.META_MASK;
    return mods;
}

// GNOME Settings' own rule (gnome-control-center, keyboard shortcuts), so that what it
// takes is taken here too. With no modifier or only Shift, it refuses letters and digits
// of every alphabet, the space bar alone, and the keys that move around. Every other key
// is allowed, also alone or with Shift, such as Shift+± or Delete.
const LETTERS_AND_DIGITS = [
    [Gdk.KEY_a, Gdk.KEY_z], [Gdk.KEY_A, Gdk.KEY_Z], [Gdk.KEY_0, Gdk.KEY_9],
    [Gdk.KEY_kana_fullstop, Gdk.KEY_semivoicedsound], [Gdk.KEY_Arabic_comma, Gdk.KEY_Arabic_sukun],
    [Gdk.KEY_Serbian_dje, Gdk.KEY_Cyrillic_HARDSIGN], [Gdk.KEY_Greek_ALPHAaccent, Gdk.KEY_Greek_omega],
    [Gdk.KEY_hebrew_doublelowline, Gdk.KEY_hebrew_taf], [Gdk.KEY_Thai_kokai, Gdk.KEY_Thai_lekkao],
    [Gdk.KEY_Hangul_Kiyeog, Gdk.KEY_Hangul_J_YeorinHieuh],
];
const REFUSED_WITHOUT_MODIFIER = new Set([
    Gdk.KEY_Home, Gdk.KEY_Left, Gdk.KEY_Up, Gdk.KEY_Right, Gdk.KEY_Down, Gdk.KEY_Page_Up, Gdk.KEY_Page_Down,
    Gdk.KEY_End, Gdk.KEY_Tab, Gdk.KEY_KP_Enter, Gdk.KEY_Return, Gdk.KEY_Mode_switch,
]);

function gnomeRefuses(key, mods) {
    if (mods !== 0 && mods !== Gdk.ModifierType.SHIFT_MASK)
        return false;
    return LETTERS_AND_DIGITS.some(([first, last]) => key >= first && key <= last) ||
        (key === Gdk.KEY_space && mods === 0) || REFUSED_WITHOUT_MODIFIER.has(key);
}

// True when this key press should go on moving around the window instead of being a shortcut.
export function passesThrough(keyval, state) {
    return MOVING_KEYS.has(keyval) && (cleanModifiers(state) & STRONG) === 0;
}

// Reads a key press. Returns null to keep waiting (only a modifier so far), {clear} for
// Backspace alone, as in GNOME Settings, {error} when it can't be a shortcut, or {accelerator}.
export function readShortcut(keyval, state) {
    if (MODIFIER_KEYS.has(keyval))
        return null;
    let key = Gdk.keyval_to_lower(keyval);
    if (key === Gdk.KEY_ISO_Left_Tab)
        key = Gdk.KEY_Tab;
    if (key === Gdk.KEY_Sys_Req)    // what Alt+Print reports
        key = Gdk.KEY_Print;
    const mods = cleanModifiers(state);
    if (key === Gdk.KEY_BackSpace && mods === 0)
        return {clear: true};
    if (gnomeRefuses(key, mods))
        return {error: 'That key is needed for typing. Add Ctrl, Alt or Super to it.'};
    return {accelerator: Gtk.accelerator_name(key, mods)};
}

// The same shortcut can be written in different ways, such as <Ctrl> and <Control>.
export function sameShortcut(one, other) {
    const [, keyOne, modsOne] = Gtk.accelerator_parse(one);
    const [, keyOther, modsOther] = Gtk.accelerator_parse(other);
    return keyOne !== 0 && keyOne === keyOther && modsOne === modsOther;
}

// The key caps for a shortcut, as GNOME Settings shows them: <Shift>plusminus is Shift and ±.
// An empty list when there is no shortcut, or one that can't be read.
export function keyCaps(accelerator) {
    const [ok, key, mods] = Gtk.accelerator_parse(accelerator ?? '');
    if (!ok || key === 0)
        return [];
    const keyLabel = Gtk.accelerator_get_label(key, 0);
    const full = Gtk.accelerator_get_label(key, mods);
    // The modifiers come first, each followed by "+". Cutting the key off the end keeps a
    // "+" key whole.
    const modifiers = full.slice(0, full.length - keyLabel.length).split('+').filter(Boolean);
    return [...modifiers, keyLabel];
}
