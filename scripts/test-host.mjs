// Verifies the stock host API and native tool schema with the extension transport.
// No network or paid model calls.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createPrivateRequest } from '../private-api.js';
const root = process.argv[2];
if (!root) throw new Error('Usage: node scripts/test-host.mjs <SillyTavern root>');
const core = await readFile(path.join(root, 'public/script.js'), 'utf8');
const api = await readFile(path.join(root, 'public/scripts/openai.js'), 'utf8');
assert.doesNotMatch(core + api, /blackboardPrivate|blackboard-private-bridge/);
assert.match(api, /export async function createGenerationParameters/);
assert.match(core, /export async function saveReply/);
assert.match(core, /await runGenerationInterceptors/);
// Exercise the actual host conversion, including its enumerable toString function.
const toolSource = (await readFile(path.join(root, 'public/scripts/tool-calling.js'), 'utf8')).replace(/\r\n/g, '\n');
const toolStart = toolSource.indexOf('    toFunctionOpenAI() {');
const toolEnd = toolSource.indexOf('\n    /**', toolStart);
assert.ok(toolStart > 0 && toolEnd > toolStart);
const NativeTool = vm.runInNewContext(`(class {
    #name; #description = 'test'; #parameters;
    constructor(name, parameters) { this.#name = name; this.#parameters = parameters; }
    ${toolSource.slice(toolStart, toolEnd)}
})`);
const originalSchema = { properties: {}, required: [] };
const registeredTools = [
    new NativeTool('UpdateBlackboard', originalSchema).toFunctionOpenAI(),
    new NativeTool('RollTheDice', {}).toFunctionOpenAI(),
    new NativeTool('UnrelatedExternalAction', {}).toFunctionOpenAI(),
];
assert.equal(typeof registeredTools[0].toString, 'function');
assert.throws(() => structuredClone(registeredTools), { name: 'DataCloneError' });


let wire;
const settings = { stream_openai: true, n: 4 };
const request = createPrivateRequest({ settings, getModel: () => 'test',
    createParameters: async s => {
        assert.notEqual(s, settings);
        assert.equal(s.stream_openai, false);
        return { generate_data: { tools: registeredTools } };
    },
    context: {
        eventSource: { emit: async () => {} }, eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'settings' },
        getRequestHeaders: () => ({}), extractMessageFromData: d => d.choices[0].message.content,
    },
    fetchRequest: async (_, init) => {
        wire = JSON.parse(init.body);
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) };
    },
});
assert.equal((await request([], ['UpdateBlackboard','RollTheDice'])).text, 'OK');
assert.deepEqual(wire.tools.map(t => t.function.name), ['UpdateBlackboard','RollTheDice']);
assert.deepEqual(originalSchema, { properties: {}, required: [] });
assert.ok(wire.tools[0].function.parameters.required.includes('base_revision'));
assert.equal(wire.stream, false); assert.equal(wire.n, 1);
assert.deepEqual(settings, { stream_openai: true, n: 4 });
await request([], []);
assert.equal(wire.tools, undefined);
console.log('Stock host exports and native ToolDefinition compatibility PASS. No core Blackboard hooks, network or model calls.');
