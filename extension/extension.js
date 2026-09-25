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

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const MARGIN = 16;              // logical pixels from the screen edges
const QUICK_EXIT_MS = 10000;    // a tray that stops sooner than this counts as a crash
const MAX_CRASHES = 5;          // after that, leave it off until the next login

export default class ScreenshotTray extends Extension {
    enable() {
        this._windows = new Map();      // MetaWindow -> its signal ids
        this._crashes = 0;
        this._restartId = 0;
        this._client = null;
        this._cancellable = null;

        this._displayIds = [
            global.display.connect('window-created', (_display, window) => this._adopt(window)),
            global.display.connect('workareas-changed', () => this._placeAll()),
        ];
        this._start();
    }

    disable() {
        if (this._restartId)
            GLib.source_remove(this._restartId);
        this._restartId = 0;

        this._displayIds.forEach(id => global.display.disconnect(id));
        this._displayIds = null;

        for (const [window, ids] of this._windows)
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

    _adopt(window) {
        if (!this._client?.owns_window(window))
            return;
        try {
            window.set_type(Meta.WindowType.UTILITY);   // never takes the keyboard when it appears
            window.hide_from_window_list();             // not in Alt+Tab or the dock
            window.stick();                             // on every workspace
            window.make_above();                        // above ordinary windows
        } catch (e) {
            console.error(`Screenshot Tray: ${e.message}`);
        }
        this._windows.set(window, [
            window.connect('shown', () => this._place(window)),
            window.connect('size-changed', () => this._place(window)),
            window.connect('unmanaged', () => this._windows?.delete(window)),
        ]);
    }

    _placeAll() {
        for (const window of this._windows.keys())
            this._place(window);
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
