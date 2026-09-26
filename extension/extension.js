// SPDX-License-Identifier: GPL-3.0-or-later
// Screenshot Tray: the GNOME Shell side.
//
// Starts the tray app (app/main.js) the same way Ubuntu's desktop-icons add-on
// starts its window, so GNOME trusts it. Then keeps that window in the
// bottom-left corner (where CleanShot puts its thumbnails), above other windows,
// on every workspace, out of Alt+Tab, and never taking the keyboard when it appears.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const APP_ID = 'com.zincoo.ScreenshotTray';
const APP_PATH = '/com/zincoo/ScreenshotTray';
const TRAY_TITLE = 'Screenshot Tray';   // the tray window's title in app/main.js
const MARGIN = 16;              // logical pixels from the screen edges
const QUICK_EXIT_MS = 10000;    // a tray that stops sooner than this counts as a crash
const MAX_CRASHES = 5;          // after that, leave it off until the next login

export default class ScreenshotTray extends Extension {
    enable() {
        this._windows = new Map();      // MetaWindow -> {ids: its signal ids, pinned}
        this._crashes = 0;
        this._restartId = 0;
        this._client = null;
        this._cancellable = null;

        this._displayIds = [
            global.display.connect('window-created', (_display, window) => this._adopt(window)),
            global.display.connect('workareas-changed', () => this._placeAll()),
        ];
        this._addTopBarMenu();
        this._start();
    }

    // An icon in the top bar, so the tray can be reached even while it is hidden.
    _addTopBarMenu() {
        this._indicator = new PanelMenu.Button(0.0, 'Screenshot Tray', false);
        const icon = new St.Icon({
            gicon: Gio.icon_new_for_string(GLib.build_filenamev([this.path, 'icons', 'screenshot-tray-symbolic.svg'])),
            style_class: 'system-status-icon',
        });
        this._indicator.add_child(icon);
        this._matchNeighbours(icon);
        const menu = this._indicator.menu;
        menu.addAction('Bring back the last closed', () => this._askTray('restore-last'));
        menu.addAction('Show the newest screenshots', () => this._askTray('show-recent'));
        menu.addAction('Clear the tray', () => this._askTray('clear'));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Open the Screenshots folder', () => this._askTray('open-folder'));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('How to use…', () => this._askTray('help'));
        menu.addAction('About Screenshot Tray', () => this._askTray('about'));
        menu.addAction('Quit Screenshot Tray', () => this._quit());
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    // Gives the icon the same spacing as Ubuntu's other top-bar icons (its AppIndicator
    // add-on), so the hover highlight is a circle like theirs, not a wide oval. It
    // follows that add-on's "compact" setting; without it, GNOME's own look stays.
    _matchNeighbours(icon) {
        const schema = Gio.SettingsSchemaSource.get_default()
            ?.lookup('org.gnome.shell.extensions.appindicator', true);
        if (!schema?.has_key('compact-mode-enabled'))
            return;
        this._appIndicatorSettings = new Gio.Settings({settings_schema: schema});
        const apply = () => {
            const compact = this._appIndicatorSettings.get_boolean('compact-mode-enabled');
            this._indicator.set_style(compact ? '-natural-hpadding: 10px' : null);
            icon.set_style(compact ? 'padding: 0; margin: 0' : 'padding: 0');
        };
        this._appIndicatorSettingsId =
            this._appIndicatorSettings.connect('changed::compact-mode-enabled', apply);
        apply();
    }

    // Switches the add-on off, so the tray and this icon go, also after the next
    // login. Starting Screenshot Tray from the app list switches it back on.
    _quit() {
        // Wait until the menu has closed before the icon is taken away.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            Main.extensionManager.disableExtension(this.uuid);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Runs one of the tray's own actions (see app/main.js) over the session bus.
    _askTray(action) {
        try {
            Gio.DBusActionGroup.get(Gio.DBus.session, APP_ID, APP_PATH).activate_action(action, null);
        } catch (e) {
            console.error(`Screenshot Tray: ${e.message}`);
        }
    }

    disable() {
        if (this._appIndicatorSettingsId)
            this._appIndicatorSettings.disconnect(this._appIndicatorSettingsId);
        this._appIndicatorSettingsId = 0;
        this._appIndicatorSettings = null;
        this._indicator?.destroy();
        this._indicator = null;

        if (this._restartId)
            GLib.source_remove(this._restartId);
        this._restartId = 0;

        this._displayIds.forEach(id => global.display.disconnect(id));
        this._displayIds = null;

        for (const [window, {ids}] of this._windows)
            ids.forEach(id => window.disconnect(id));
        this._windows = null;

        this._cancellable?.cancel();
        this._cancellable = null;
        this._client?.get_subprocess()?.force_exit();
        this._client = null;
    }

    _start() {
        const argv = ['/usr/bin/gjs', '-m', GLib.build_filenamev([this.path, 'app', 'main.js']), '--managed'];
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
        launcher.set_cwd(GLib.get_home_dir());
        let subprocess;
        try {
            this._client = Meta.WaylandClient.new_subprocess(global.context, launcher, argv);
            subprocess = this._client.get_subprocess();
        } catch (e) {
            console.error(`Screenshot Tray: could not start the tray: ${e.message}`);
            this._client = null;
            return;
        } finally {
            launcher.close();
        }

        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        const startedAt = GLib.get_monotonic_time();
        subprocess.wait_async(cancellable, (proc, result) => {
            try {
                proc.wait_finish(result);
            } catch {
                return;     // cancelled: the add-on is being switched off
            }
            if (cancellable.is_cancelled())
                return;
            this._client = null;

            const ranMs = (GLib.get_monotonic_time() - startedAt) / 1000;
            this._crashes = ranMs < QUICK_EXIT_MS ? this._crashes + 1 : 0;
            if (this._crashes > MAX_CRASHES) {
                console.error('Screenshot Tray: the tray keeps stopping; leaving it off until next login.');
                return;
            }
            this._restartId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this._restartId = 0;
                this._start();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    // Pins the tray's own window. Its other windows (How to use, About) stay ordinary.
    // The title can arrive just after the window, so it's checked again when it changes.
    _adopt(window) {
        if (!this._client?.owns_window(window))
            return;
        const entry = {ids: [], pinned: false};
        const pinIfTray = () => {
            if (entry.pinned || window.get_title() !== TRAY_TITLE)
                return;
            entry.pinned = true;
            try {
                window.set_type(Meta.WindowType.UTILITY);   // never takes the keyboard when it appears
                window.hide_from_window_list();             // not in Alt+Tab or the dock
                window.stick();                             // on every workspace
                window.make_above();                        // above ordinary windows
            } catch (e) {
                console.error(`Screenshot Tray: ${e.message}`);
            }
            this._place(window);
        };
        entry.ids.push(
            window.connect('notify::title', pinIfTray),
            window.connect('shown', () => entry.pinned && this._place(window)),
            window.connect('size-changed', () => entry.pinned && this._place(window)),
            window.connect('unmanaged', () => this._windows?.delete(window)));
        this._windows.set(window, entry);
        pinIfTray();
    }

    _placeAll() {
        for (const [window, {pinned}] of this._windows) {
            if (pinned)
                this._place(window);
        }
    }

    _place(window) {
        const area = window.get_work_area_for_monitor(global.display.get_primary_monitor());
        const frame = window.get_frame_rect();
        if (frame.width === 0 || frame.height === 0)
            return;
        // Safety net: a tray this big means something went wrong, so never let it cover the screen.
        if (frame.width > area.width / 2 || frame.height > area.height * 0.9) {
            window.unmake_above();
            return;
        }
        const x = area.x + MARGIN;
        const y = area.y + area.height - frame.height - MARGIN;
        if (frame.x !== x || frame.y !== y)
            window.move_frame(true, x, y);
    }
}
