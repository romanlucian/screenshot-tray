// SPDX-License-Identifier: GPL-3.0-or-later
// A tiny test runner for the GJS tests: no framework, nothing to install.

import GLib from 'gi://GLib';
import System from 'system';

const tests = [];

export function test(name, fn) {
    tests.push([name, fn]);
}

function sorted(value) {
    if (Array.isArray(value))
        return value.map(sorted);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort()
            .map(key => [key, sorted(value[key])]));
    }
    return value;
}

export function assertEqual(actual, expected) {
    const [a, b] = [actual, expected].map(value => JSON.stringify(sorted(value)));
    if (a !== b)
        throw new Error(`expected ${b}, got ${a}`);
}

// The function must throw an error whose .field is the given one.
export function assertThrows(fn, field) {
    let caught = null;
    try {
        fn();
    } catch (e) {
        caught = e;
    }
    if (!caught)
        throw new Error(`expected an error on ${field}, none was thrown`);
    if (caught.field !== field)
        throw new Error(`expected an error on ${field}, got ${caught.field}: ${caught.message}`);
}

// These tests write files: refuse to run anywhere near the real home folder.
export function requireMadeUpHome() {
    if (!GLib.get_home_dir().startsWith('/var/tmp/') ||
        !GLib.get_user_config_dir().startsWith('/var/tmp/')) {
        print('Refusing to run: use the scripts in tests/, which set a made-up home folder.');
        System.exit(2);
    }
}

// Runs the tests in order, prints each result, and exits non-zero if any failed.
export async function finish() {
    const loop = new GLib.MainLoop(null, false);
    let failed = 0;
    const run = async () => {
        for (const [name, fn] of tests) {
            try {
                await fn();
                print(`ok    ${name}`);
            } catch (e) {
                failed++;
                print(`FAIL  ${name}\n      ${e.message}`);
            }
        }
        loop.quit();
    };
    run();
    await loop.runAsync();
    print(`${tests.length - failed} of ${tests.length} passed`);
    System.exit(failed ? 1 : 0);
}
