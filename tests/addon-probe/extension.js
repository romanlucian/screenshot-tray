// SPDX-License-Identifier: GPL-3.0-or-later
// For tests/addon.sh only, and only ever loaded inside its invisible GNOME Shell: turns on
// the Shell's Eval call there, and gives the test eyes, a keyboard and a mouse.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const now = () => GLib.get_monotonic_time();

export default class Probe extends Extension {
    enable() {
        global.context.unsafe_mode = true;
        const seat = global.stage.get_context().get_backend().get_default_seat();
        const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const mouse = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);

        globalThis.trayProbe = {
            ready: () => !Main.layoutManager._startingUp && Main.sessionMode.currentMode !== undefined,
            leaveOverview: () => Main.overview.hide(),
            hasKeybinding: name => Boolean(Main.wm._allowedKeybindings[name]),
            notices: () => Main.messageTray.getSources().flatMap(source => source.notifications.map(notice => notice.title)),
            place: (title, x, y, width, height) => global.get_window_actors()
                .find(item => item.meta_window.get_title() === title).meta_window
                .move_resize_frame(false, x, y, width, height),
            openFromAppIconMenu: () => Shell.AppSystem.get_default().lookup_app('com.zincoo.ScreenshotTray.desktop')
                .launch_action('settings', global.get_current_time(), -1),
            focus: title => {
                const actor = global.get_window_actors().find(item => item.meta_window.get_title() === title);
                Main.activateWindow(actor.meta_window);
            },
            onTop: () => global.display.sort_windows_by_stacking(
                global.get_window_actors().map(actor => actor.meta_window)).map(window => window.get_title()),
            saveScreen: path => {
                const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
                new Shell.Screenshot().screenshot(false, stream, () => stream.close(null));
            },
            inOverview: () => Main.overview.visible,
            windows: () => global.get_window_actors().map(actor => {
                const window = actor.meta_window;
                const frame = window.get_frame_rect();
                const area = window.get_work_area_for_monitor(global.display.get_primary_monitor());
                return {
                    title: window.get_title(),
                    x: frame.x,
                    y: frame.y,
                    width: frame.width,
                    height: frame.height,
                    areaX: area.x,
                    areaY: area.y,
                    areaWidth: area.width,
                    areaHeight: area.height,
                    above: window.is_above(),
                    onAllWorkspaces: window.is_on_all_workspaces(),
                    skipsTaskbar: window.is_skip_taskbar(),
                    focused: global.display.get_focus_window() === window,
                };
            }),
            press: (...names) => {
                const keys = names.map(name => Clutter[`KEY_${name}`]);
                keys.forEach(key => keyboard.notify_keyval(now(), key, Clutter.KeyState.PRESSED));
                keys.reverse().forEach(key => keyboard.notify_keyval(now(), key, Clutter.KeyState.RELEASED));
            },
            moveTo: (x, y) => mouse.notify_absolute_motion(now(), x, y),
            click: () => {
                mouse.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
                    mouse.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
                    return GLib.SOURCE_REMOVE;
                });
            },
        };
    }

    disable() {
        delete globalThis.trayProbe;
    }
}
