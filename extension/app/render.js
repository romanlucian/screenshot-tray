// SPDX-License-Identifier: GPL-3.0-or-later
// Draws a widget into a PNG file, without taking a screenshot. Used only to make
// the README images (tools/make-readme-images.sh); the tray never calls it otherwise.

import Graphene from 'gi://Graphene';
import Gsk from 'gi://Gsk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

export function renderToPng(widget, path, scale = 2) {
    const width = widget.get_width();
    const height = widget.get_height();
    const snapshot = new Gtk.Snapshot();
    snapshot.scale(scale, scale);
    new Gtk.WidgetPaintable({widget}).snapshot(snapshot, width, height);

    const renderer = new Gsk.CairoRenderer();
    renderer.realize_for_display(widget.get_display());
    const texture = renderer.render_texture(snapshot.to_node(),
        new Graphene.Rect().init(0, 0, width * scale, height * scale));
    renderer.unrealize();
    texture.save_to_png(path);
}
