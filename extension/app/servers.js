// SPDX-License-Identifier: GPL-3.0-or-later
// The servers a screenshot can go to: the ones added in Settings, and the entries of
// ~/.ssh/config that were switched on there. Nothing in this part uses the network.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const ADDRESS = /^(?!-)[A-Za-z0-9._:-]{1,253}$/;
const USER = /^(?!-)[A-Za-z0-9._-]{1,64}$/;
const NAME_LENGTH = 40;

// A problem with what was typed in the form; .field says which box it belongs to.
export class InputError extends Error {
    constructor(field, message) {
        super(message);
        this.field = field;
    }
}

function validPort(port) {
    return /^\d{1,5}$/.test(String(port)) && Number(port) >= 1 && Number(port) <= 65535;
}

function serverFrom(address, user, port, name) {
    const cleanName = String(name ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, NAME_LENGTH);
    return {id: `${user}@${address}:${port}`, name: cleanName || address, address, user, port};
}

// Checks what was typed in the Add a server form and returns the server. The address
// may also hold a pasted username or port. Nothing that gets through can act as an
// SSH option or a shell command.
export function parseServerInput({address = '', user = '', port = 22, name = ''}) {
    let host = String(address).trim();
    let login = String(user).trim();
    let pastedPort = null;

    const at = host.lastIndexOf('@');
    if (at >= 0) {
        login ||= host.slice(0, at);
        host = host.slice(at + 1);
    }
    const bracketed = host.match(/^\[([^\]]*)\](?::(.*))?$/);
    if (bracketed)
        [, host, pastedPort = null] = bracketed;
    else if (host.split(':').length === 2)
        [host, pastedPort] = host.split(':');

    if (!host)
        throw new InputError('address', "Enter the server's address.");
    if (!ADDRESS.test(host))
        throw new InputError('address', "That address has characters a server address can't have.");
    if (!login)
        throw new InputError('user', 'Enter your username on the server.');
    if (!USER.test(login))
        throw new InputError('user', "That username has characters a username can't have.");

    const fieldIsDefault = port === null || port === '' || Number(port) === 22;
    const finalPort = fieldIsDefault ? pastedPort ?? 22 : port;
    if (!validPort(finalPort))
        throw new InputError('port', 'The port must be a number from 1 to 65535.');
    return serverFrom(host, login, Number(finalPort), name);
}

export function configDir() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'screenshot-tray']);
}

// The app's folder, readable by this user only. Returns its path.
export function ensureConfigDir() {
    GLib.mkdir_with_parents(configDir(), 0o700);
    Gio.File.new_for_path(configDir()).set_attribute_uint32('unix::mode', 0o700,
        Gio.FileQueryInfoFlags.NONE, null);
    return configDir();
}

function listPath() {
    return GLib.build_filenamev([configDir(), 'servers.json']);
}

// The list file can be edited by hand, so it gets the same checks as the form.
function validSavedServer(entry) {
    return entry && typeof entry === 'object' && ADDRESS.test(entry.address) &&
        USER.test(entry.user) && Number.isInteger(entry.port) && validPort(entry.port);
}

export function loadList() {
    let contents;
    try {
        [, contents] = GLib.file_get_contents(listPath());
    } catch {
        return {added: [], sshOn: []};      // first run: nothing saved yet
    }
    let saved;
    try {
        saved = JSON.parse(new TextDecoder().decode(contents));
        if (!saved || typeof saved !== 'object' || Array.isArray(saved))
            throw new Error('not a list');
    } catch {
        // Keep the damaged file for whoever wants to look at it, and start again.
        const aside = `${listPath()}.damaged-${Math.floor(GLib.get_real_time() / 1e6)}`;
        Gio.File.new_for_path(listPath()).move(Gio.File.new_for_path(aside),
            Gio.FileCopyFlags.OVERWRITE, null, null);
        return {added: [], sshOn: []};
    }
    const added = Array.isArray(saved.added) ? saved.added.filter(validSavedServer) : [];
    const sshOn = Array.isArray(saved.sshOn) ? saved.sshOn.filter(host => typeof host === 'string') : [];
    return {
        added: added.map(entry => serverFrom(entry.address, entry.user, entry.port, entry.name)),
        sshOn,
    };
}

const listeners = new Set();

export function saveList({added, sshOn}) {
    ensureConfigDir();
    const json = `${JSON.stringify({version: 1, added, sshOn}, null, 2)}\n`;
    // PRIVATE with REPLACE_DESTINATION: a whole new file, readable by this user only.
    Gio.File.new_for_path(listPath()).replace_contents(new TextEncoder().encode(json), null, false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    for (const listener of [...listeners])
        listener();
}

// Calls fn whenever the list changes. Returns the function that stops it.
export function onServersChanged(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function addServer(server) {
    const list = loadList();
    saveList({...list, added: [...list.added.filter(other => other.id !== server.id), server]});
}

export function removeServer(id) {
    const list = loadList();
    saveList({...list, added: list.added.filter(server => server.id !== id)});
}

export function setSshHostOn(host, on) {
    const list = loadList();
    const others = list.sshOn.filter(name => name !== host);
    saveList({...list, sshOn: on ? [...others, host] : others});
}

// What the server button on a card offers.
export function sendTargets() {
    const {added, sshOn} = loadList();
    return [
        ...added.map(server => ({kind: 'added', ...server})),
        ...sshHosts().filter(host => sshOn.includes(host)).map(name => ({kind: 'ssh', name})),
    ];
}

// The servers named on the "Host" lines of ~/.ssh/config (patterns like * are skipped).
export function sshHosts() {
    let contents;
    try {
        [, contents] = GLib.file_get_contents(GLib.build_filenamev([GLib.get_home_dir(), '.ssh', 'config']));
    } catch {
        return [];
    }
    const hosts = [];
    for (const line of new TextDecoder().decode(contents).split('\n')) {
        const match = line.match(/^\s*Host(?:\s*=\s*|\s+)(.+?)\s*$/i);
        for (const name of match ? match[1].split(/\s+/) : []) {
            if (!/[*?!]/.test(name) && !hosts.includes(name))
                hosts.push(name);
        }
    }
    return hosts;
}
