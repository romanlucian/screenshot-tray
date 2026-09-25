// SPDX-License-Identifier: GPL-3.0-or-later
// Screenshot Tray: the floating window of recent screenshots.
//
// Watches the folder where GNOME saves screenshots (~/Pictures/Screenshots) and
// shows the newest ones as cards. Drag a card into any app to hand it the file.
// Hover a card for Copy, Open, Send to a server and Dismiss; "Bring back" returns
// cards that left. Nothing on disk is ever deleted.
//
// The GNOME Shell add-on (../extension.js) starts this with --managed and pins its
// window in the bottom-left corner. Without the add-on it runs as an ordinary
// window with a title bar that stays open, so it can be placed by hand:
//     gjs -m main.js              (add --preload=3 to show the 3 newest at once)

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import Gettext from 'gettext';
import System from 'system';

import {showAbout, showHelp} from './help.js';
import {sshHosts, uploadToServer} from './servers.js';

const APP_ID = 'com.zincoo.ScreenshotTray';
const ADDON_UUID = 'screenshot-tray@zincoo.com';
const MANAGED = System.programArgs.includes('--managed');
const MAX_CARDS = 5;
const MAX_CLOSED = 20;          // how many cards that left "Bring back" remembers
const CARD_MAX_WIDTH = 220;     // logical pixels
const CARD_MAX_HEIGHT = 140;
const CARD_MIN_WIDTH = 120;
const CARD_MIN_HEIGHT = 64;
const RESTORE_MAX_AGE_HOURS = 12;

const APP_DIR = GLib.path_get_dirname(Gio.File.new_for_uri(import.meta.url).get_path());
// The two SCREENSHOT_TRAY_* overrides exist for making the README images.
const SCREENSHOTS_DIR = GLib.getenv('SCREENSHOT_TRAY_DIR') ?? GLib.build_filenamev([
    GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ?? GLib.get_home_dir(),
    // GNOME names this folder in the desktop's language; borrow its translation.
    Gettext.dgettext('gnome-shell', 'Screenshots'),
]);
const STATE_FILE = GLib.getenv('SCREENSHOT_TRAY_STATE') ??
    GLib.build_filenamev([GLib.get_user_cache_dir(), 'screenshot-tray', 'cards.json']);

function log(message) {
    console.log(`Screenshot Tray: ${message}`);
}

function isScreenshotName(name) {
    return !name.startsWith('.') && name.toLowerCase().endsWith('.png');
}

function ageInHours(path) {
    const info = Gio.File.new_for_path(path).query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
    const modified = info.get_modification_date_time().to_unix();
    return (GLib.get_real_time() / 1e6 - modified) / 3600;
}

function enumName(enumeration, value) {
    return Object.keys(enumeration).find(key => enumeration[key] === value) ?? String(value);
}

// Returns a texture with twice the pixels of the on-screen size, so thumbnails
// stay sharp on the 150 % screens, plus that on-screen size.
function loadThumbnail(path) {
    const [format, fullWidth, fullHeight] = GdkPixbuf.Pixbuf.get_file_info(path);
    if (!format || fullWidth <= 0 || fullHeight <= 0)
        throw new Error('not a readable picture yet');

    const scale = Math.min(CARD_MAX_WIDTH / fullWidth, CARD_MAX_HEIGHT / fullHeight, 1);
    const width = Math.max(1, Math.round(fullWidth * scale));
    const height = Math.max(1, Math.round(fullHeight * scale));

    const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path,
        Math.min(width * 2, fullWidth), Math.min(height * 2, fullHeight), true);
    const texture = Gdk.MemoryTexture.new(pixbuf.get_width(), pixbuf.get_height(),
        pixbuf.get_has_alpha() ? Gdk.MemoryFormat.R8G8B8A8 : Gdk.MemoryFormat.R8G8B8,
        pixbuf.read_pixel_bytes(), pixbuf.get_rowstride());
    return {texture, width, height};
}

class Card {
    constructor(tray, path) {
        this._tray = tray;
        this.path = path;
        this._file = Gio.File.new_for_path(path);
        this._copiedId = 0;
        this._statusId = 0;
        this._destroyed = false;
        this._hotspot = [0, 0];
        this._dragRefused = false;

        const {texture, width, height} = loadThumbnail(path);
        const picture = new Gtk.Picture({
            paintable: texture,
            content_fit: Gtk.ContentFit.CONTAIN,
            can_shrink: true,
        });
        // The texture has twice the pixels; the clamp shows it at its on-screen size.
        const sized = new Adw.Clamp({
            child: picture,
            maximum_size: width,
            tightening_threshold: width,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
        });

        const drag = new Gtk.DragSource({actions: Gdk.DragAction.COPY});
        drag.connect('prepare', (_source, x, y) => {
            this._hotspot = [Math.round(x), Math.round(y)];
            return this._dragContent();
        });
        drag.connect('drag-begin', source => {
            this._dragRefused = false;
            source.set_icon(new Gtk.WidgetPaintable({widget: picture}), ...this._hotspot);
            this.widget.add_css_class('dragging');
        });
        drag.connect('drag-cancel', (_source, _drag, reason) => {
            this._dragRefused = true;
            log(`drag of ${GLib.path_get_basename(this.path)} not accepted: ${enumName(Gdk.DragCancelReason, reason)}`);
            return false;
        });
        drag.connect('drag-end', (_source, gdkDrag) => {
            this.widget.remove_css_class('dragging');
            const action = gdkDrag.get_selected_action();
            log(`drag of ${GLib.path_get_basename(this.path)} ended, action: ${enumName(Gdk.DragAction, action)}`);
            // Delivered: the card has done its job, so it leaves the tray (the file stays).
            // A refused drag can still report an action, so the cancel signal decides.
            if (!this._dragRefused && action !== 0) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._tray.dismiss(this);
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
        picture.add_controller(drag);

        const dismiss = new Gtk.Button({
            icon_name: 'window-close-symbolic',
            tooltip_text: 'Dismiss (the file stays in Screenshots)',
            css_classes: ['osd', 'circular', 'card-button', 'card-reveal'],
            halign: Gtk.Align.END,
            valign: Gtk.Align.START,
            margin_top: 6,
            margin_end: 6,
        });
        dismiss.connect('clicked', () => this._tray.dismiss(this));

        this._copyButton = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: 'Copy the picture',
            css_classes: ['osd', 'circular', 'card-button'],
        });
        this._copyButton.connect('clicked', () => this._copy());

        const open = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            tooltip_text: 'Open',
            css_classes: ['osd', 'circular', 'card-button'],
        });
        open.connect('clicked', () => this._open());

        const actions = new Gtk.Box({
            spacing: 8,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.END,
            margin_bottom: 6,
            css_classes: ['card-reveal'],
        });
        actions.append(this._copyButton);
        actions.append(open);

        // Send to a server: one click with one server, a short list with several.
        const hosts = tray.hosts;
        if (hosts.length > 0) {
            this._sendButton = new Gtk.Button({
                icon_name: 'network-server-symbolic',
                tooltip_text: hosts.length === 1 ? `Send to ${hosts[0]}` : 'Send to a server',
                css_classes: ['osd', 'circular', 'card-button'],
            });
            if (hosts.length === 1) {
                this._sendButton.connect('clicked', () => this._send(hosts[0]));
            } else {
                const list = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
                this._hostsPopover = new Gtk.Popover({child: list});
                this._hostsPopover.set_parent(this._sendButton);
                for (const host of hosts) {
                    const item = new Gtk.Button({label: host, css_classes: ['flat']});
                    item.connect('clicked', () => {
                        this._hostsPopover.popdown();
                        this._send(host);
                    });
                    list.append(item);
                }
                this._sendButton.connect('clicked', () => this._hostsPopover.popup());
            }
            actions.append(this._sendButton);
        }

        // A short message across the top of the card, e.g. "Sending…" or "Path copied".
        this._status = new Gtk.Label({
            visible: false,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            lines: 3,
            ellipsize: Pango.EllipsizeMode.END,
            xalign: 0,
            halign: Gtk.Align.FILL,
            valign: Gtk.Align.START,
            margin_top: 6,
            margin_start: 6,
            margin_end: 42,
            css_classes: ['osd', 'card-status'],
        });

        this.widget = new Gtk.Overlay({
            child: sized,
            halign: Gtk.Align.START,
            width_request: Math.max(CARD_MIN_WIDTH, width),
            height_request: Math.max(CARD_MIN_HEIGHT, height),
            overflow: Gtk.Overflow.HIDDEN,
            css_classes: ['card'],
        });
        this.widget.add_overlay(actions);
        this.widget.add_overlay(this._status);
        this.widget.add_overlay(dismiss);
    }

    destroy() {
        this._destroyed = true;
        for (const id of [this._copiedId, this._statusId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._copiedId = this._statusId = 0;
        this._hostsPopover?.unparent();
        this._hostsPopover = null;
    }

    _say(message, forMs) {
        if (this._destroyed)
            return;
        this._status.label = message;
        this._status.visible = true;
        if (this._statusId)
            GLib.source_remove(this._statusId);
        this._statusId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, forMs, () => {
            this._statusId = 0;
            this._status.visible = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    // Uploads the screenshot to the server and copies its path there, ready to paste
    // into Claude Code or Codex running on that server. The card stays in the tray.
    async _send(host) {
        this._sendButton.sensitive = false;
        this._say(`Sending to ${host}…`, 30000);
        try {
            const remotePath = await uploadToServer(this.path, host);
            Gdk.Display.get_default().get_clipboard().set_text(remotePath);
            log(`sent ${GLib.path_get_basename(this.path)} to ${host}: ${remotePath}`);
            this._say(`On ${host}. Its path is copied: paste it there (Ctrl+Shift+V).`, 4000);
        } catch (e) {
            log(`could not send ${GLib.path_get_basename(this.path)} to ${host}: ${e.message}`);
            this._say(e.message, 8000);
        } finally {
            if (!this._destroyed)
                this._sendButton.sensitive = true;
        }
    }

    // What an app receives when the card is dropped on it: the file's address in
    // the classic format every app reads. Terminals type it as a path; browsers,
    // chats and VS Code take the file itself.
    _dragContent() {
        const uriList = new TextEncoder().encode(`${this._file.get_uri()}\r\n`);
        return Gdk.ContentProvider.new_for_bytes('text/uri-list', new GLib.Bytes(uriList));
    }

    _copy() {
        let contents;
        try {
            [, contents] = this._file.load_contents(null);
        } catch (e) {
            log(`cannot read ${this.path}: ${e.message}`);
            return;
        }
        const png = Gdk.ContentProvider.new_for_bytes('image/png', new GLib.Bytes(contents));
        this._copyButton.get_clipboard().set_content(png);

        this._copyButton.icon_name = 'object-select-symbolic';
        if (this._copiedId)
            GLib.source_remove(this._copiedId);
        this._copiedId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
            this._copiedId = 0;
            this._copyButton.icon_name = 'edit-copy-symbolic';
            return GLib.SOURCE_REMOVE;
        });
    }

    _open() {
        try {
            Gio.AppInfo.launch_default_for_uri(this._file.get_uri(),
                this.widget.get_display().get_app_launch_context());
        } catch (e) {
            log(`cannot open ${this.path}: ${e.message}`);
        }
    }
}

class Tray {
    constructor(app) {
        this._cards = [];                 // oldest first; the newest sits nearest the corner
        this._closed = [];                // paths of cards that left, the latest last
        this._waiting = new Map();        // path -> timeout id, for files still being written

        this._window = new Gtk.ApplicationWindow({
            application: app,
            title: 'Screenshot Tray',
            decorated: !MANAGED,
            resizable: false,
            css_classes: MANAGED ? ['screenshot-tray'] : [],
        });
        this._window.connect('close-request', () => {
            if (MANAGED) {
                this.clear();   // the add-on keeps the tray running; just empty it
                return true;
            }
            app.quit();
            return false;
        });

        this._bringBack = new Gtk.Button({
            label: 'Bring back',
            tooltip_text: 'Bring back the last card that left the tray',
            visible: false,
            css_classes: ['osd', 'pill', 'tray-pill'],
        });
        this._bringBack.connect('clicked', () => this.restoreLast());

        this._clearAll = new Gtk.Button({
            label: 'Clear all',
            visible: false,
            css_classes: ['osd', 'pill', 'tray-pill'],
        });
        this._clearAll.connect('clicked', () => this.clear());

        this._header = new Gtk.Box({spacing: 8, halign: Gtk.Align.START, visible: false});
        this._header.append(this._bringBack);
        this._header.append(this._clearAll);

        this._placeholder = new Gtk.Label({
            label: 'Your next screenshots will appear here',
            visible: false,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
            css_classes: ['dim-label'],
        });

        this._box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            css_classes: ['tray-box'],
        });
        this._box.append(this._header);
        this._box.append(this._placeholder);
        this._window.set_child(this._box);
    }

    // Read fresh for each new card, so a server added to ~/.ssh/config shows up
    // without restarting the tray.
    get hosts() {
        return sshHosts();
    }

    watch() {
        const folder = Gio.File.new_for_path(SCREENSHOTS_DIR);
        this._monitor = folder.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._monitor.connect('changed', (_monitor, file, otherFile, event) => {
            switch (event) {
            case Gio.FileMonitorEvent.CHANGES_DONE_HINT:
            case Gio.FileMonitorEvent.MOVED_IN:
                this._consider(file.get_path());
                break;
            case Gio.FileMonitorEvent.RENAMED:
                this._forget(file.get_path());
                this._consider(otherFile?.get_path());
                break;
            case Gio.FileMonitorEvent.DELETED:
            case Gio.FileMonitorEvent.MOVED_OUT:
                this._forget(file.get_path());
                break;
            }
        });
        log(`watching ${SCREENSHOTS_DIR}`);
    }

    restore() {
        let state = {};
        try {
            const [, contents] = GLib.file_get_contents(STATE_FILE);
            state = JSON.parse(new TextDecoder().decode(contents));
        } catch {
            // first run, or nothing saved
        }
        // Older versions saved just the list of cards.
        const cards = Array.isArray(state) ? state : state?.cards ?? [];
        const closed = Array.isArray(state?.closed) ? state.closed : [];
        this._closed = closed.filter(path => typeof path === 'string').slice(-MAX_CLOSED);
        for (const path of Array.isArray(cards) ? cards : []) {
            try {
                if (typeof path === 'string' && ageInHours(path) < RESTORE_MAX_AGE_HOURS)
                    this._add(new Card(this, path));
            } catch {
                // the file was moved or deleted since: leave it out
            }
        }
        this._update();
    }

    // Testing aid: show the newest few screenshots already in the folder.
    preload(count) {
        const found = [];
        const children = Gio.File.new_for_path(SCREENSHOTS_DIR).enumerate_children(
            'standard::name,time::modified', Gio.FileQueryInfoFlags.NONE, null);
        for (let info = children.next_file(null); info; info = children.next_file(null)) {
            if (isScreenshotName(info.get_name())) {
                found.push([info.get_modification_date_time().to_unix(),
                    GLib.build_filenamev([SCREENSHOTS_DIR, info.get_name()])]);
            }
        }
        children.close(null);
        found.sort((a, b) => a[0] - b[0]);
        for (const [, path] of found.slice(-count))
            this._tryAdd(path, 0);
    }

    // For the README images only: draw the tray into a PNG (the newest card with its
    // buttons showing, as if hovered), then quit.
    renderTo(path) {
        this._cards.at(-1)?.widget.add_css_class('hover-demo');
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            import('./render.js')
                .then(({renderToPng}) => {
                    renderToPng(this._box, path);
                    log(`rendered ${path}`);
                })
                .catch(e => log(`render failed: ${e.message}`))
                .finally(() => this._window.get_application().quit());
            return GLib.SOURCE_REMOVE;
        });
    }

    // Started again from the app list while already running: if the tray is empty,
    // bring back the last card that left (or else the newest screenshots), and show it.
    bringBack() {
        if (this._cards.length === 0 && !this.restoreLast())
            this.preload(3);
        if (!MANAGED)
            this._window.present();
    }

    // Brings back the card that left most recently. Returns false if there is none.
    restoreLast() {
        while (this._closed.length > 0) {
            const path = this._closed.pop();
            if (this._has(path) || !GLib.file_test(path, GLib.FileTest.EXISTS))
                continue;
            try {
                this._add(new Card(this, path));
            } catch {
                continue;
            }
            this._update();
            return true;
        }
        this._update();
        return false;
    }

    openFolder() {
        try {
            Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(SCREENSHOTS_DIR).get_uri(),
                this._window.get_display().get_app_launch_context());
        } catch (e) {
            log(`cannot open ${SCREENSHOTS_DIR}: ${e.message}`);
        }
    }

    dismiss(card) {
        this._remove(card);
        this._update();
    }

    clear() {
        for (const card of [...this._cards])
            this._remove(card);
        this._update();
    }

    _consider(path) {
        if (!path || !isScreenshotName(GLib.path_get_basename(path)) || this._has(path))
            return;
        this._wait(path, 0, 150);
    }

    _wait(path, attempt, delayMs) {
        if (this._waiting.has(path))
            GLib.source_remove(this._waiting.get(path));
        this._waiting.set(path, GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._waiting.delete(path);
            this._tryAdd(path, attempt);
            return GLib.SOURCE_REMOVE;
        }));
    }

    _tryAdd(path, attempt) {
        if (this._has(path))
            return;
        let card;
        try {
            card = new Card(this, path);
        } catch (e) {
            // GNOME may still be writing the file: try again shortly, a few times.
            if (attempt < 5 && GLib.file_test(path, GLib.FileTest.EXISTS))
                this._wait(path, attempt + 1, 300);
            else
                log(`skipped ${path}: ${e.message}`);
            return;
        }
        this._add(card);
        this._update();
    }

    _has(path) {
        return this._cards.some(card => card.path === path);
    }

    _add(card) {
        log(`showing ${GLib.path_get_basename(card.path)}`);
        this._cards.push(card);
        // Pinned in the bottom corner, the newest goes at the bottom, nearest the corner.
        // As an ordinary window it grows downwards, so the newest goes at the top.
        if (MANAGED)
            this._box.append(card.widget);
        else
            this._box.insert_child_after(card.widget, this._placeholder);
        while (this._cards.length > MAX_CARDS)
            this._remove(this._cards[0]);
    }

    // A card that leaves is remembered for "Bring back", unless its file is gone.
    _remove(card, remember = true) {
        const index = this._cards.indexOf(card);
        if (index < 0)
            return;
        this._cards.splice(index, 1);
        this._box.remove(card.widget);
        card.destroy();
        if (remember) {
            this._closed = this._closed.filter(path => path !== card.path);
            this._closed.push(card.path);
            this._closed.splice(0, Math.max(0, this._closed.length - MAX_CLOSED));
        }
    }

    // The file was deleted or moved away: drop its card and forget it entirely.
    _forget(path) {
        if (!path)
            return;
        if (this._waiting.has(path)) {
            GLib.source_remove(this._waiting.get(path));
            this._waiting.delete(path);
        }
        this._closed = this._closed.filter(closedPath => closedPath !== path);
        const card = this._cards.find(c => c.path === path);
        if (card)
            this._remove(card, false);
        this._update();
    }

    _update() {
        this._bringBack.visible = this._closed.length > 0;
        this._clearAll.visible = this._cards.length >= 2;
        this._header.visible = this._bringBack.visible || this._clearAll.visible;
        this._placeholder.visible = !MANAGED && this._cards.length === 0;
        // Pinned: shown without asking for the keyboard, hidden when empty.
        // Ordinary window: always shown, so it stays where it was put.
        this._window.visible = !MANAGED || this._cards.length > 0;
        this._save();
    }

    _save() {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(STATE_FILE), 0o700);
            const json = JSON.stringify({cards: this._cards.map(card => card.path), closed: this._closed});
            GLib.file_set_contents(STATE_FILE, new TextEncoder().encode(json));
        } catch (e) {
            log(`cannot remember the cards: ${e.message}`);
        }
    }
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
    tray = new Tray(app);
    tray.restore();
    tray.watch();
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
});

if (!MANAGED && !renderPath && preloadCount === 0 && switchAddOnOn())
    log('the add-on was switched off; switched it back on, and it starts the tray');
else
    await app.runAsync([System.programInvocationName]);
