// SPDX-License-Identifier: GPL-3.0-or-later
// Draws the "How to use" and "About" windows, whole and at 2x, into PNG files for
// the README pictures. Run it through tools/render-app-parts.sh, never on the desktop.
//     gjs -m render_windows.js OUTPUT_FOLDER

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const TOOLS_DIR = GLib.path_get_dirname(Gio.File.new_for_uri(import.meta.url).get_path());
const APP_DIR = GLib.build_filenamev([TOOLS_DIR, '..', 'extension', 'app']);
const {showAbout, showHelp} = await import(`file://${APP_DIR}/help.js`);
const {renderToPng} = await import(`file://${APP_DIR}/render.js`);
const [out] = System.programArgs;

// Waits until the window has been laid out (up to 10 seconds), then draws it.
function drawWhenReady(widget, path) {
    return new Promise(resolve => {
        let tries = 0;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            tries++;
            const root = widget.get_root();
            if (root && root.get_width() > 0 && tries > 6) {
                try {
                    renderToPng(root, path, 2);
                    print(`drew ${path}`);
                    resolve();
                    return GLib.SOURCE_REMOVE;
                } catch (e) {
                    if (tries < 40)
                        return GLib.SOURCE_CONTINUE;
                    print(`could not draw ${path}: ${e.message}`);
                }
            }
            if (tries >= 40) {
                resolve();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    });
}

const app = new Adw.Application({
    application_id: 'com.zincoo.ScreenshotTrayPictures',
    flags: Gio.ApplicationFlags.NON_UNIQUE,
});
app.connect('activate', async () => {
    app.hold();
    const help = showHelp();
    await drawWhenReady(help, `${out}/help.png`);
    help.close();
    const about = showAbout();
    await drawWhenReady(about, `${out}/about.png`);
    app.quit();
});
await app.runAsync([System.programInvocationName]);
