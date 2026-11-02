// SPDX-License-Identifier: GPL-3.0-or-later
// The Add a server dialog: one short form, then a checklist of what Connect is doing.

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {addServer, InputError, parseServerInput} from './servers.js';
import {checkTarget, forgetServerId, removeServerKey, setUpServer, SetupCancelled} from './ssh.js';

// The SSH calls these windows make. Tests hand in stand-ins.
export const realDeps = {setUpServer, checkTarget, removeServerKey, forgetServerId};

const STEPS = [
    ['found', 'Found the server'],
    ['logged-in', 'Logged in'],
    ['key', 'Installed a secure key'],
    ['works', 'Sending works'],
];

const WIDTH = 440;
const NOTE = 'Used once to set up a secure key, then forgotten. It is never saved. Leave it ' +
    'empty if this computer already logs in to this server with a key.';

// Marks up a short success text in the green that suits the current style.
export function inGreen(text) {
    const color = Adw.StyleManager.get_default().dark ? '#57d68d' : '#1b8553';
    return `<span foreground="${color}">${GLib.markup_escape_text(text, -1)}</span>`;
}

function stateIcon(state) {
    if (state === 'running')
        return new Adw.Spinner();
    if (state === 'done')
        return new Gtk.Image({icon_name: 'object-select-symbolic', css_classes: ['success']});
    if (state === 'failed')
        return new Gtk.Image({icon_name: 'dialog-error-symbolic', css_classes: ['error']});
    return new Gtk.Image({icon_name: 'content-loading-symbolic', css_classes: ['dim-label']});
}

function boxedList(...rows) {
    const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
    rows.forEach(row => list.append(row));
    return list;
}

function page(...children) {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 6,
        margin_bottom: 18,
        margin_start: 18,
        margin_end: 18,
    });
    children.forEach(child => box.append(child));
    return box;
}

// max_width_chars keeps a long note from widening the window: it wraps instead.
const noteLabel = (label, css_classes) => new Gtk.Label({
    label,
    wrap: true,
    xalign: 0,
    max_width_chars: 40,
    css_classes,
});

export function showAddServer(parent, deps = realDeps) {
    const dialog = new Adw.Dialog({title: 'Add a server', content_width: WIDTH});

    const addressRow = new Adw.EntryRow({title: 'Server address', activates_default: true});
    const userRow = new Adw.EntryRow({title: 'Username', activates_default: true});
    const passwordRow = new Adw.PasswordEntryRow({title: 'Password', activates_default: true});
    const nameRow = new Adw.EntryRow({title: 'Name', activates_default: true});
    const portRow = Adw.SpinRow.new_with_range(1, 65535, 1);
    portRow.title = 'Port';
    portRow.value = 22;
    const more = new Adw.ExpanderRow({title: 'More options', subtitle: 'Name and port'});
    more.add_row(nameRow);
    more.add_row(portRow);
    const formError = noteLabel('', ['error']);
    formError.visible = false;
    const form = page(boxedList(addressRow, userRow, passwordRow), noteLabel(NOTE, ['dim-label']),
        formError, boxedList(more));

    const checklist = new Map();
    for (const [step, title] of STEPS) {
        const row = new Adw.ActionRow({title});
        const holder = new Gtk.Box({width_request: 18, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER});
        row.add_prefix(holder);
        checklist.set(step, {row, holder});
    }
    const outcome = noteLabel('', []);
    outcome.use_markup = true;
    const progress = page(boxedList(...[...checklist.values()].map(item => item.row)), outcome);

    const stack = new Gtk.Stack({vhomogeneous: false, interpolate_size: true});
    stack.add_named(form, 'form');
    stack.add_named(progress, 'progress');

    const cancel = new Gtk.Button({label: 'Cancel'});
    const back = new Gtk.Button({label: 'Back', visible: false});
    const connect = new Gtk.Button({label: 'Connect', sensitive: false, css_classes: ['suggested-action']});
    const done = new Gtk.Button({label: 'Done', visible: false, css_classes: ['suggested-action']});
    const header = new Adw.HeaderBar({show_start_title_buttons: false, show_end_title_buttons: false});
    header.pack_start(cancel);
    header.pack_start(back);
    header.pack_end(connect);
    header.pack_end(done);

    // The clamp holds the width: without it, a new message can stretch the window.
    const clamp = new Adw.Clamp({child: stack, maximum_size: WIDTH, tightening_threshold: WIDTH});
    const view = new Adw.ToolbarView({content: clamp});
    view.add_top_bar(header);
    dialog.child = view;
    dialog.default_widget = connect;

    let closed = false;
    let cancellable = null;
    let openQuestion = null;

    const setStep = (step, state) => {
        const item = checklist.get(step);
        if (!item)
            return;
        for (let child = item.holder.get_first_child(); child; child = item.holder.get_first_child())
            item.holder.remove(child);
        item.holder.append(stateIcon(state));
    };

    const showForm = () => {
        stack.visible_child_name = 'form';
        back.visible = false;
        done.visible = false;
        cancel.visible = true;
        connect.visible = true;
    };

    const showProgress = () => {
        STEPS.forEach(([step]) => setStep(step, 'waiting'));
        outcome.label = '';
        outcome.css_classes = [];
        formError.visible = false;
        for (const row of [addressRow, userRow, portRow])
            row.remove_css_class('error');
        stack.visible_child_name = 'progress';
        connect.visible = false;
    };

    const showFormError = e => {
        ({address: addressRow, user: userRow, port: portRow})[e.field]?.add_css_class('error');
        formError.label = e.message;
        formError.visible = true;
    };

    const askTrust = ({state, fingerprint}, address) => new Promise(resolve => {
        const changed = state === 'changed';
        const question = new Adw.AlertDialog(changed ? {
            heading: "This server's ID has changed",
            body: `${address} has a different ID from the one saved on this computer. Continue only ` +
                `if you reinstalled this server. If you didn't, someone could be listening in. ` +
                `Its new ID is ${fingerprint}.`,
        } : {
            heading: 'Is this your server?',
            body: `This computer hasn't connected to ${address} before. Its ID is ${fingerprint}. ` +
                'Continue only if you expected to connect to this server.',
        });
        question.add_response('cancel', 'Cancel');
        question.add_response('trust', 'Trust and continue');
        question.set_response_appearance('trust',
            changed ? Adw.ResponseAppearance.DESTRUCTIVE : Adw.ResponseAppearance.SUGGESTED);
        question.default_response = 'cancel';
        question.close_response = 'cancel';
        question.connect('response', (_question, response) => {
            openQuestion = null;
            resolve(response === 'trust');
        });
        openQuestion = question;
        question.present(dialog);
    });

    const start = async () => {
        let server;
        try {
            server = parseServerInput({
                address: addressRow.text,
                user: userRow.text,
                port: portRow.value,
                name: nameRow.text,
            });
        } catch (e) {
            if (e instanceof InputError) {
                showFormError(e);
                return;
            }
            throw e;
        }

        showProgress();
        cancellable = new Gio.Cancellable();
        try {
            await deps.setUpServer(server, passwordRow.text, {
                cancellable,
                onStep: (step, state) => {
                    if (!closed)
                        setStep(step, state);
                },
                askTrust: id => askTrust(id, server.address),
            });
            if (closed)
                return;
            addServer(server);
            passwordRow.text = '';
            outcome.label = `<b>${inGreen(`${server.name} is ready.`)}</b> Hover a card in the tray ` +
                'and press the server button to send.';
            cancel.visible = false;
            done.visible = true;
        } catch (e) {
            if (closed)
                return;
            if (e instanceof SetupCancelled) {
                showForm();
                return;
            }
            if (e.field === 'password')
                passwordRow.text = '';
            outcome.css_classes = ['error'];
            outcome.label = GLib.markup_escape_text(e.message, -1);
            cancel.visible = false;
            back.visible = true;
        }
    };

    const updateConnect = () => {
        const address = addressRow.text.trim();
        connect.sensitive = address !== '' && (userRow.text.trim() !== '' || address.includes('@'));
    };
    addressRow.connect('changed', updateConnect);
    userRow.connect('changed', updateConnect);

    connect.connect('clicked', () => {
        start().catch(e => console.error(`Screenshot Tray: ${e.message}`));
    });
    cancel.connect('clicked', () => dialog.close());
    back.connect('clicked', showForm);
    done.connect('clicked', () => dialog.close());

    dialog.connect('closed', () => {
        closed = true;
        cancellable?.cancel();
        openQuestion?.force_close();
        openQuestion = null;
        passwordRow.text = '';
    });

    dialog.present(parent);
    return dialog;
}
