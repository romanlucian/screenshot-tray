// SPDX-License-Identifier: GPL-3.0-or-later
// The Shortcuts tab of Settings: GNOME's own shortcuts for taking a screenshot, and the
// tray's, which the add-on listens for.
//
// Only GNOME's own Settings app can catch every key without a permission prompt. So a
// combination GNOME already uses just does its usual job here, and this window keeps
// waiting. That is why the question says so, and why it refuses only what it can see.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

import {
    GNOME_SHORTCUTS, TRAY_SHORTCUTS, gnomeShortcuts, passesThrough, readShortcut, sameShortcut, traySettings,
} from './preferences.js';

const PROMPT = 'Press the keys you want. A combination GNOME already uses will just do its ' +
    'usual job, so choose another one. Esc cancels, Backspace clears it.';

function current(settings, key) {
    return settings.get_strv(key)[0] ?? '';
}

// The first row, of everything on this tab, that already has this shortcut.
function usedBy(accelerator, skipKey, places) {
    for (const {settings, shortcuts} of places) {
        for (const [key, title] of shortcuts) {
            if (key !== skipKey && settings.get_strv(key).some(other => sameShortcut(other, accelerator)))
                return title;
        }
    }
    return null;
}

function askForKeys(dialog, title, key, place, places) {
    const {settings, offersDefault} = place;
    const question = new Adw.AlertDialog({heading: `New shortcut: ${title}`, body: PROMPT});
    question.add_response('cancel', 'Cancel');
    question.add_response('clear', 'Clear');
    if (offersDefault)
        question.add_response('default', "Use GNOME's default");
    question.default_response = 'cancel';
    question.close_response = 'cancel';

    const keys = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
    keys.connect('key-pressed', (_keys, keyval, _keycode, state) => {
        if (keyval === Gdk.KEY_Escape) {
            question.close();
            return true;
        }
        if (passesThrough(keyval, state))
            return false;
        const pressed = readShortcut(keyval, state);
        if (pressed?.clear) {
            settings.set_strv(key, []);
            question.close();
        } else if (pressed?.error) {
            question.body = pressed.error;
        } else if (pressed) {
            const other = usedBy(pressed.accelerator, key, places);
            if (other) {
                question.body = `That is already the shortcut for ${other}. Clear it there first, or press other keys.`;
            } else {
                settings.set_strv(key, [pressed.accelerator]);
                question.close();
            }
        }
        return true;
    });
    question.add_controller(keys);

    question.connect('response', (_question, response) => {
        if (response === 'clear')
            settings.set_strv(key, []);
        else if (response === 'default')
            settings.reset(key);
    });
    question.present(dialog);
}

function shortcutRow(dialog, title, key, place, places) {
    const {settings} = place;
    const row = new Adw.ActionRow({title, activatable: true});
    const label = new Adw.ShortcutLabel({
        accelerator: current(settings, key),
        disabled_text: 'Not set',
        valign: Gtk.Align.CENTER,
    });
    row.add_suffix(label);
    row.connect('activated', () => askForKeys(dialog, title, key, place, places));
    const changed = settings.connect(`changed::${key}`, () => {
        label.accelerator = current(settings, key);
    });
    dialog.connect('closed', () => settings.disconnect(changed));
    return row;
}

export function shortcutsPage(dialog) {
    const page = new Adw.PreferencesPage({
        name: 'shortcuts',
        title: 'Shortcuts',
        icon_name: 'input-keyboard-symbolic',
    });
    const tray = {settings: traySettings(), shortcuts: TRAY_SHORTCUTS, offersDefault: false};
    const gnomeSettings = gnomeShortcuts();
    const gnome = gnomeSettings && {settings: gnomeSettings, shortcuts: GNOME_SHORTCUTS, offersDefault: true};
    const places = [gnome, tray].filter(Boolean);

    const groups = [
        gnome && [gnome, 'Take a screenshot', "GNOME's own shortcuts. A change here also shows in GNOME Settings."],
        [tray, 'Tray', 'Click a row, then press the keys you want.'],
    ].filter(Boolean);
    for (const [place, title, description] of groups) {
        const group = new Adw.PreferencesGroup({title, description});
        for (const [key, rowTitle] of place.shortcuts)
            group.add(shortcutRow(dialog, rowTitle, key, place, places));
        page.add(group);
    }
    return page;
}
