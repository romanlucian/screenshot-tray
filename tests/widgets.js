// SPDX-License-Identifier: GPL-3.0-or-later
// Finds widgets in a window by what a person sees, for tests/ui-test.js and for the
// README pictures in tools/render_windows.js.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

export function* walk(widget) {
    yield widget;
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
        yield* walk(child);
}

export function rows(root) {
    return [...walk(root)].filter(widget => widget instanceof Adw.PreferencesRow);
}

export function row(root, title) {
    return rows(root).find(candidate => candidate.title === title) ?? null;
}

export function button(root, label) {
    return [...walk(root)].find(widget => widget instanceof Gtk.Button && widget.label === label) ?? null;
}

export function labels(root) {
    return [...walk(root)].filter(widget => widget instanceof Gtk.Label && widget.get_mapped?.() !== false)
        .map(widget => widget.label);
}
