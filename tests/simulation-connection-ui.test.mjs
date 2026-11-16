import test from 'node:test';
import assert from 'node:assert/strict';
import { simulationConnectionOptions, replaceConnectionOptions } from '../simulation-connection-ui.js';

test('connection choices preserve missing selections, skip invalid/duplicate IDs and label unsupported profiles', () => {
    const context = { extensionSettings: { connectionManager: { profiles: [
        { id: 'vertex', name: 'Vertex custom model', mode: 'cc' },
        { id: 'vertex', name: 'Duplicate' },
        { id: 'codex', name: '<img src=x onerror=alert(1)>', mode: 'cc' },
        { id: 'text', name: 'Text backend', mode: 'tc' },
        { name: 'Invalid' },
    ] } } };
    const before = JSON.stringify(context);
    const options = simulationConnectionOptions(context, 'missing-id');
    assert.deepEqual(options.map(option => option.value), ['', 'vertex', 'codex', 'text', 'missing-id']);
    assert.equal(options[2].text, '<img src=x onerror=alert(1)>');
    assert.equal(options[3].disabled, true);
    assert.equal(options[4].disabled, true);
    assert.match(options[4].text, /unavailable/);
    assert.equal(JSON.stringify(context), before);
});

test('missing or disabled Connection Manager leaves current connection usable', () => {
    for (const context of [{}, { extensionSettings: { disabledExtensions: ['connection-manager'], connectionManager: { profiles: [{ id: 'hidden' }] } } }]) {
        assert.deepEqual(simulationConnectionOptions(context), [{ value: '', text: 'Current connection', disabled: false }]);
    }
});

test('rendering uses text nodes and retains unavailable IDs instead of selecting a fallback', () => {
    let replacements = 0;
    const select = { options: [], value: '', ownerDocument: { createElement(tag) { assert.equal(tag, 'option'); return {}; } },
        replaceChildren(...options) { this.options = options; replacements++; } };
    const model = simulationConnectionOptions({}, 'deleted');
    replaceConnectionOptions(select, model, 'deleted');
    assert.equal(select.value, 'deleted');
    assert.equal(select.options[1].disabled, true);
    assert.equal(Object.hasOwn(select.options[1], 'innerHTML'), false);
    replaceConnectionOptions(select, model, 'deleted');
    assert.equal(replacements, 1);
    replaceConnectionOptions(select, [{ value: '', text: 'Current connection' }]);
    assert.equal(select.value, '');
    assert.equal(select.options.length, 1);
});
