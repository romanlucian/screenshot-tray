// SPDX-License-Identifier: GPL-3.0-or-later
// The General tab of Settings: how the tray and its cards behave.

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

import {traySettings} from './preferences.js';

const CORNERS = [['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']];
const HIDE_AFTER = [[0, 'Never'], [5, 'After 5 minutes'], [15, 'After 15 minutes'], [60, 'After 1 hour']];

function choiceRow(title, subtitle, choices, current, save) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
        selected: Math.max(0, choices.findIndex(([value]) => value === current)),
    });
    row.connect('notify::selected', () => save(choices[row.selected][0]));
    return row;
}

export function generalPage() {
    const settings = traySettings();
    const page = new Adw.PreferencesPage({
        name: 'general',
        title: 'General',
        icon_name: 'emblem-system-symbolic',
    });

    const tray = new Adw.PreferencesGroup({title: 'Tray'});
    const cards = Adw.SpinRow.new_with_range(1, 5, 1);
    cards.title = 'Cards to keep';
    cards.subtitle = 'How many float at once. The oldest go to Bring back.';
    cards.value = settings.get_int('max-cards');
    cards.connect('notify::value', () => settings.set_int('max-cards', cards.value));
    tray.add(cards);
    tray.add(choiceRow('Screen corner', '', CORNERS, settings.get_string('corner'),
        corner => settings.set_string('corner', corner)));
    page.add(tray);

    const behaviour = new Adw.PreferencesGroup({title: 'Cards'});
    const keep = new Adw.SwitchRow({
        title: 'Keep after dragging',
        subtitle: 'Stays in the tray after you drop it into an app',
    });
    settings.bind('keep-after-drag', keep, 'active', Gio.SettingsBindFlags.DEFAULT);
    behaviour.add(keep);
    behaviour.add(choiceRow('Hide old cards', 'They go to Bring back. Your screenshot files are never deleted.',
        HIDE_AFTER, settings.get_int('hide-after-minutes'),
        minutes => settings.set_int('hide-after-minutes', minutes)));
    page.add(behaviour);
    return page;
}
