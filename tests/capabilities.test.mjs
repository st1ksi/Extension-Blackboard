import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateTurnCapabilities } from '../capabilities.js';
import { browserEnvironment } from './browser-fixtures.mjs';

test('secure localhost and HTTPS feature surfaces support private turns', () => {
    const result = privateTurnCapabilities(browserEnvironment());
    assert.equal(result.supported, true);
    assert.deepEqual(result.missing, []);
    assert.match(result.message, /do not transfer between devices/);
});

for (const [name, overrides, expected] of [
    ['LAN HTTP', { isSecureContext: false, navigator: {}, crypto: {} }, ['secure context', 'Web Locks', 'Web Crypto (SHA-256)', 'crypto.randomUUID']],
    ['no storage', { indexedDB: undefined }, ['IndexedDB']],
    ['no locks', { navigator: {} }, ['Web Locks']],
    ['no digest', { crypto: { randomUUID() {} } }, ['Web Crypto (SHA-256)']],
    ['no UUID', { crypto: { subtle: { digest() {} } } }, ['crypto.randomUUID']],
]) test(`${name}: preflight identifies the unavailable capabilities`, () => {
    const result = privateTurnCapabilities(browserEnvironment(overrides));
    assert.equal(result.supported, false);
    assert.deepEqual(result.missing, expected);
    assert.match(result.message, /Existing drafts are retained/);
    if (name === 'LAN HTTP') assert.match(result.message, /HTTPS with a certificate trusted by that device/);
});

test('restricted API getters produce a capability report instead of breaking initialization', () => {
    const env = browserEnvironment();
    Object.defineProperty(env, 'indexedDB', { get() { throw new Error('SecurityError'); } });
    assert.equal(privateTurnCapabilities(env).storageAvailable, false);
    assert.deepEqual(privateTurnCapabilities(env).missing, ['IndexedDB']);
});
