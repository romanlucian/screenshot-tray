// SPDX-License-Identifier: GPL-3.0-or-later
// Draws the app's windows, whole and at 2x, into PNG files for the README pictures. The
// servers are made up and no SSH call is made: stand-ins answer for them. Run it through
// tools/render-app-parts.sh, never on the desktop.
//     gjs -m render_windows.js OUTPUT_FOLDER

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const TOOLS_DIR = GLib.path_get_dirname(Gio.File.new_for_uri(import.meta.url).get_path());
const APP_DIR = GLib.build_filenamev([TOOLS_DIR, '..', 'extension', 'app']);
const {showAbout, showHelp} = await import(`file://${APP_DIR}/help.js`);
const {renderToPng} = await import(`file://${APP_DIR}/render.js`);
const {addServer, parseServerInput, setSshHostOn} = await import(`file://${APP_DIR}/servers.js`);
const {showSettings} = await import(`file://${APP_DIR}/settings.js`);
const {showAddServer} = await import(`file://${APP_DIR}/add-server.js`);
const {button, row} = await import(`file://${TOOLS_DIR}/../tests/widgets.js`);
const [out] = System.programArgs;

// Answers in place of SSH: every step works.
const madeUpDeps = {
    setUpServer: async (_server, _password, {onStep}) => {
        for (const step of ['found', 'logged-in', 'key', 'works']) {
            onStep(step, 'running');
            onStep(step, 'done');
        }
    },
    checkTarget: async () => {},
    removeServerKey: async () => true,
    forgetServerId: async () => {},
};

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

async function drawAll() {
    const help = showHelp();
    await drawWhenReady(help, `${out}/help.png`);
    help.close();
    const about = showAbout();
    await drawWhenReady(about, `${out}/about.png`);
    about.close();

    addServer(parseServerInput({address: '203.0.113.10', user: 'lucian', name: 'Studio Pi'}));
    setSshHostOn('my-server', true);
    const settings = showSettings(madeUpDeps);
    button(row(settings, 'Studio Pi'), 'Test').emit('clicked');
    button(row(settings, 'my-server'), 'Test').emit('clicked');
    await drawWhenReady(settings, `${out}/settings.png`);
    settings.close();

    const form = showAddServer(null, madeUpDeps);
    row(form, 'Server address').text = '203.0.113.20';
    row(form, 'Username').text = 'lucian';
    row(form, 'Password').text = 'made-up-password';
    await drawWhenReady(form, `${out}/add-server-form.png`);
    button(form, 'Connect').emit('clicked');
    await drawWhenReady(form, `${out}/add-server-done.png`);
    form.close();
}

const app = new Adw.Application({
    application_id: 'com.zincoo.ScreenshotTrayPictures',
    flags: Gio.ApplicationFlags.NON_UNIQUE,
});
app.connect('activate', () => {
    app.hold();
    drawAll().catch(e => print(`could not draw: ${e.message}`)).finally(() => app.quit());
});
await app.runAsync([System.programInvocationName]);
