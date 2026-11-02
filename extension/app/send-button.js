// SPDX-License-Identifier: GPL-3.0-or-later
// The server button on a card: one click with one server, a short list with several,
// hidden with none. update() lets a card that is already showing follow a change.

import Gtk from 'gi://Gtk?version=4.0';

export class SendButton {
    constructor({onSend}) {
        this._onSend = onSend;
        this._targets = [];
        this._popover = null;
        this.widget = new Gtk.Button({
            icon_name: 'network-server-symbolic',
            visible: false,
            css_classes: ['osd', 'circular', 'card-button'],
        });
        this.widget.connect('clicked', () => {
            if (this._targets.length === 1)
                this._onSend(this._targets[0]);
            else
                this._popover?.popup();
        });
    }

    update(targets) {
        this._targets = targets;
        this._removeList();
        this.widget.visible = targets.length > 0;
        this.widget.tooltip_text = targets.length === 1 ? `Send to ${targets[0].name}` : 'Send to a server';
        if (targets.length > 1)
            this._makeList(targets);
    }

    setBusy(busy) {
        this.widget.sensitive = !busy;
    }

    destroy() {
        this._removeList();
    }

    _makeList(targets) {
        const list = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        this._popover = new Gtk.Popover({child: list});
        this._popover.set_parent(this.widget);
        for (const target of targets) {
            const item = new Gtk.Button({label: target.name, css_classes: ['flat']});
            item.connect('clicked', () => {
                this._popover.popdown();
                this._onSend(target);
            });
            list.append(item);
        }
    }

    _removeList() {
        this._popover?.unparent();
        this._popover = null;
    }
}
