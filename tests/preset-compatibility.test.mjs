import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendCompatibilityJournal, captureCompatibilityContext, captureDisplayedHistory, markCompatibilityInjection, narrationMessages, runPresetCompatibleTurn, validateNarrationText } from '../preset-compatibility.js';
import { pass } from './review-fixtures.mjs';
import { processRegister } from '../transaction.js';
import { freezeCampaignLayers } from '../campaign-layers.js';
import { CAMPAIGN_PROMPTS } from '../prompts/campaign-bundle.js';

const clock = seconds => `[MISC #world_clock]\n- Time: Day 1, 02:15:${String(seconds).padStart(2, '0')}`;
const register = seconds => '[MISC #simulation_processes]\n' + JSON.stringify({ version: 1, through: `Day 1, 02:15:${String(seconds).padStart(2, '0')}`, processes: [] });
const board = seconds => `${clock(seconds)}\n${register(seconds)}\n[ENTITIES #hero]\nHP 20/20; gold 200.\n[SCENE #room]\nA closed door.\n[NARRATIVE #secret]\nThe unseen assassin is Valen.`;
const tracker = '<!-- GFX_START -->\n<internal_states>\n<details><summary>Internal States</summary>Door: closed; ct: 4</details>\n</internal_states>\n<!-- GFX_END -->';
const ffTemplate = `<internal_states_module>Append the full tracker at the absolute end.\n${tracker.replace('Door: closed; ct: 4', 'Door: [state]; ct: [ct]')}\n</internal_states_module>`;
const nativeContext = ({ ff = false, media = false } = {}) => [
    { role: 'system', content: 'NATIVE_PRESET: use spare prose.' + (ff ? '\n' + ffTemplate : '') },
    { role: 'system', content: markCompatibilityInjection('QUALITY: prepare next contacts.\n' + board(0), 'world') },
    { role: 'system', content: markCompatibilityInjection('BACKGROUND: request scenery only through its tool.', 'background') },
    { role: 'assistant', content: 'You are beside the closed door.' },
    { role: 'user', content: media ? [{ type: 'text', text: 'Attempt the lock for six seconds.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }] : 'Attempt the lock for six seconds.' },
];
function textContent(message) {
    return Array.isArray(message.content) ? message.content.find(part => part.type === 'text').text : message.content;
}
function dataOf(messages) {
    const text = textContent(messages.at(-1));
    return JSON.parse(text.startsWith('{') ? text : text.split('\n').slice(1).join('\n'));
}
function phaseOf(messages) {
    const text = textContent(messages.at(-1));
    if (text.startsWith('BLACKBOARD RESOLVED TURN')) return 'narrate';
    const data = dataOf(messages);
    return data.phase ?? 'narration_check';
}
const narrativePass = packet => ({ text: JSON.stringify({ version: 1, revision: packet.revision,
    narration_id: packet.narration_id, verdict: 'pass',
    checks: ['outcomes', 'agency', 'disclosure', 'format'].map(aspect => ({ aspect, status: 'pass' })), issues: [] }) });

function harness({ ff = false, media = false, request, invoke, signal, reviewEnabled = false } = {}) {
    let checkpoint, requests = [], invocations = [], worldStep = 0;
    const resolved = 'Six seconds pass. The lock resists; the door remains closed.';
    const narration = ff ? resolved + '\n\n' + tracker : resolved;
    const options = { baseline: board(0), context: nativeContext({ ff, media }), chat: [
        { is_user: false, mes: 'You are beside the closed door.' + (ff ? '\n\n' + tracker : '') },
        { is_user: true, mes: 'Attempt the lock for six seconds.' },
    ], type: 'normal', reviewEnabled, signal,
    saveCheckpoint: async value => { checkpoint = structuredClone(value); },
    invoke: async (name, args) => {
        invocations.push({ name, args });
        return invoke ? invoke(name, args) : 'The result is: 7. Individual rolls: 7';
    },
    request: async (messages, allowed) => {
        const phase = phaseOf(messages), packet = dataOf(messages);
        requests.push({ phase, messages: structuredClone(messages), allowed: structuredClone(allowed), packet });
        if (request) {
            const custom = await request({ phase, packet, messages, allowed, requests, checkpoint });
            if (custom !== undefined) return custom;
        }
        if (phase === 'simulate') {
            if (!worldStep++) return { calls: [
                { name: 'RollTheDice', arguments: { formula: '1d20' } },
                { name: 'UpdateBlackboard', arguments: { base_revision: 0, content: clock(6) + '\n' + register(6) } },
            ] };
            return { text: resolved };
        }
        if (phase === 'review') return pass(packet);
        if (phase === 'narrate') return { text: narration };
        if (phase === 'narration_check') return narrativePass(packet);
        throw new Error('Unexpected fixture phase ' + phase);
    } };
    return { options, requests, invocations, get checkpoint() { return checkpoint; }, resolved, narration,
        run: overrides => runPresetCompatibleTurn({ ...options, ...overrides }),
        resume: overrides => runPresetCompatibleTurn({ ...options, checkpoint, signal: undefined, ...overrides }) };
}

test('capture removes exactly marked own injections, preserves arbitrary native preset and never mutates the assembled context', () => {
    const context = nativeContext({ ff: true, media: true });
    const original = structuredClone(context);
    const sources = captureCompatibilityContext(context);
    assert.deepEqual(context, original);
    assert.match(sources.simulationInstructions, /QUALITY: prepare next contacts/);
    assert.match(sources.simulationInstructions, /BACKGROUND: request scenery only through its tool/);
    assert.match(sources.simulationInstructions, /The unseen assassin is Valen/);
    assert.ok(sources.native.some(message => textContent(message).includes('NATIVE_PRESET')));
    assert.doesNotMatch(JSON.stringify(sources.native), /BLACKBOARD_COMPAT_|QUALITY: prepare|BACKGROUND: request/);
    assert.equal(sources.requiredInternalStates, true);
    assert.equal(sources.native.at(-1).content[1].type, 'image_url');
    assert.throws(() => markCompatibilityInjection('text', 'unknown'), /Unknown/);
    assert.throws(() => captureCompatibilityContext([{ role: 'system', content: 'Unmarked preset' }]), /could not identify/);
    assert.throws(() => captureCompatibilityContext([...context, context[1]]), /could not identify/);
    assert.throws(() => captureCompatibilityContext([...context, context[2]]), /could not identify/);
});

test('capture restores only last complete tracker from actual saved assistant history and omits tool receipts or superseded swipe', () => {
    const previous = tracker.replace('ct: 4', 'ct: 3');
    const latest = tracker.replace('ct: 4', 'ct: 5');
    const chat = [
        { is_user: false, mes: 'Old scene.\n' + previous },
        { is_user: true, mes: 'Continue.' },
        { is_user: false, mes: '<think>Private text</think>Current scene.\n' + tracker },
        { is_system: true, extra: { tool_invocations: [] }, mes: latest },
        { is_user: true, mes: 'Attempt the lock.' },
    ];
    const restored = captureCompatibilityContext(nativeContext({ ff: true }), chat);
    assert.equal(restored.priorTracker, tracker);
    assert.doesNotMatch(JSON.stringify(restored.visibleHistory), /internal_states|GFX_START|Private text|ct: 5/);
    assert.match(JSON.stringify(restored.visibleHistory), /Current scene/);
    const alreadyPresent = captureCompatibilityContext([...nativeContext({ ff: true }), { role: 'assistant', content: tracker }], chat);
    assert.equal(alreadyPresent.priorTracker, null);
    const swipe = captureCompatibilityContext(nativeContext({ ff: true }), [...chat, { is_user: false, mes: latest }], 'swipe');
    assert.equal(swipe.priorTracker, tracker);
});

test('supplemental public history never grants disclosure from FF forced reasoning or an interrupted private reasoning tail', () => {
    const privateSections = [
        '<think>SECRET: The assassin is Valen.</think>\nPublic end.',
        '<internal_monologue>SECRET: The assassin is Valen.</internal_monologue>\nPublic end.',
        '<reasoning type="private">SECRET: The assassin is Valen.</reasoning>\nPublic end.',
        '### Internal Monologue\nSECRET: The assassin is Valen.\n### Response\nPublic end.',
        '<think>SECRET: The assassin is Valen.',
        '### Internal Monologue\nSECRET: The assassin is Valen.',
    ];
    for (const section of privateSections) {
        const context = nativeContext();
        const original = structuredClone(context);
        const captured = captureCompatibilityContext(context, [{ is_user: false, mes: 'Public start.\n' + section }]);
        assert.doesNotMatch(JSON.stringify(captured.visibleHistory), /SECRET|Valen/, section);
        assert.match(JSON.stringify(captured.visibleHistory), /Public start/);
        if (section.includes('Public end.')) assert.match(JSON.stringify(captured.visibleHistory), /Public end/, section);
        assert.deepEqual(context, original, 'Only supplemental visibility evidence may be filtered');
    }
});

test('displayed history reads already rendered text without rerendering raw source or invoking macros, excludes tools and pending swipe', () => {
    const chat = [
        { is_user: false, mes: '{{roll::1d20}} RAW_PRIVATE_SOURCE' },
        { is_user: true, mes: 'Player source.' },
        { is_system: true, mes: 'System receipt source.' },
        { is_user: false, extra: { tool_invocations: [] }, mes: 'Tool receipt source.' },
        { is_user: false, mes: 'Pending swipe source.' },
    ];
    const original = structuredClone(chat), reads = [];
    const element = (id, text) => ({
        getAttribute(name) { assert.equal(name, 'mesid'); return id; },
        querySelector(selector) {
            assert.equal(selector, '.mes_text');
            return text === null ? null : { get innerText() { reads.push(id); return text; } };
        },
    });
    const elements = [
        element('0', 'Public display.\n<internal_monologue>PRIVATE_REASONING</internal_monologue>'),
        element('1', 'Player display.'), element('2', 'SYSTEM_HIDDEN'), element('3', 'TOOL_HIDDEN'),
        element('4', 'New displayed swipe.'), element('99', 'OUT_OF_RANGE'), element('NaN', 'INVALID_INDEX'),
    ];
    const document = { querySelectorAll(selector) { assert.equal(selector, '#chat .mes[mesid]'); return elements; } };
    const result = captureDisplayedHistory(chat, 'swipe', document);
    assert.deepEqual(result, [{ role: 'assistant', content: 'Public display.\n' }, { role: 'user', content: 'Player display.' }]);
    assert.deepEqual(reads, ['0', '1']);
    assert.deepEqual(chat, original);
    assert.doesNotMatch(JSON.stringify(result), /RAW_PRIVATE|PRIVATE_REASONING|HIDDEN|roll/);
    assert.deepEqual(captureDisplayedHistory(chat, 'normal', null), []);
});

test('expanded Internal States DOM sections stay outside public disclosure evidence while ordinary displayed details survive', () => {
    const secretText = 'INTERNAL STATES\nSecret: Valen is the assassin.';
    const ordinaryText = 'Public quest status: The watch requested help.';
    const section = (tagName, innerText, summary = '') => ({ tagName, innerText,
        querySelector(selector) { assert.equal(selector, ':scope > summary'); return { textContent: summary }; } });
    for (const trackerSections of [
        [section('INTERNAL_STATES', secretText)],
        [section('DETAILS', secretText, '🎬 INTERNAL STATES (Turn: 4)')],
    ]) {
        const source = 'Public narration before.\n' + secretText + '\n' + ordinaryText + '\nPublic narration after.';
        const body = { innerText: source,
            querySelectorAll(selector) {
                assert.equal(selector, 'internal_states, details');
                return [...trackerSections, section('DETAILS', ordinaryText, 'Known quest')];
            } };
        const element = { getAttribute: () => '0', querySelector(selector) { assert.equal(selector, '.mes_text'); return body; } };
        const displayed = captureDisplayedHistory([{ is_user: false, mes: '<raw>UNSEEN_SOURCE</raw>' }], 'normal',
            { querySelectorAll: () => [element] });
        assert.doesNotMatch(JSON.stringify(displayed), /Valen|assassin|INTERNAL STATES|UNSEEN_SOURCE/);
        assert.match(displayed[0].content, /Public narration before/);
        assert.match(displayed[0].content, /Public narration after/);
        assert.match(displayed[0].content, /Public quest status/);
        assert.equal(body.innerText, source, 'Reading evidence must not edit rendered DOM text');
    }
});

test('provided displayed history is cloned, ordered and authoritative without mutating or supplementing it from raw messages', () => {
    const displayed = Object.freeze([
        Object.freeze({ role: 'assistant', content: 'Displayed first.' }),
        Object.freeze({ role: 'user', content: 'Displayed second.' }),
    ]);
    const chat = [{ is_user: false, mes: 'RAW_SECRET_NOT_DISPLAYED' }, { is_user: true, mes: 'Raw player source.' }];
    const result = captureCompatibilityContext(nativeContext(), chat, 'normal', displayed);
    assert.deepEqual(result.visibleHistory, displayed);
    assert.notEqual(result.visibleHistory, displayed);
    assert.notEqual(result.visibleHistory[0], displayed[0]);
    result.visibleHistory[0].content = 'Changed result only.';
    assert.equal(displayed[0].content, 'Displayed first.');
    assert.doesNotMatch(JSON.stringify(result.visibleHistory), /RAW_SECRET/);
    const empty = captureCompatibilityContext(nativeContext(), chat, 'normal', []);
    assert.deepEqual(empty.visibleHistory, []);
    assert.equal(empty.historyWindowLimited, true);
});

test('narrator construction preserves the native preset and media, disables live world instructions and states single-owner rules', () => {
    const sources = captureCompatibilityContext(nativeContext({ media: true }));
    const messages = narrationMessages(sources, { resolved_candidate: 'Already resolved.', current_board: board(6) });
    assert.deepEqual(messages.slice(0, -2), sources.native);
    assert.match(messages.at(-2).content, /Do not call or print tools, reroll/);
    assert.match(messages.at(-2).content, /DISPLAY PROJECTIONS/);
    assert.match(messages.at(-2).content, /collapsed HTML/);
    assert.equal(messages.find(message => Array.isArray(message.content)).content[1].type, 'image_url');
    assert.equal(dataOf(messages).resolved_candidate, 'Already resolved.');
    assert.doesNotMatch(JSON.stringify(messages), /BLACKBOARD_COMPAT_WORLD|QUALITY: prepare/);
});

test('required Internal States output needs one complete trailing tracker; generic presets remain unconstrained', () => {
    assert.equal(validateNarrationText({ text: 'Normal narration.' }, { requiredInternalStates: false }), 'Normal narration.');
    assert.equal(validateNarrationText({ text: 'Normal narration.\n' + tracker }, { requiredInternalStates: true }), 'Normal narration.\n' + tracker);
    for (const text of ['Normal narration.', tracker + '\nAfterword.', tracker + '\n' + tracker,
        tracker.replace('</internal_states>', ''), tracker.replace('<!-- GFX_END -->', '')]) {
        assert.throws(() => validateNarrationText({ text }, { requiredInternalStates: true }), /complete trailing HTML/);
    }
    assert.throws(() => validateNarrationText({ text: 'partial', finishReason: 'max_tokens' }, {}), /did not complete/);
    assert.throws(() => validateNarrationText({ calls: [{ name: 'UpdateBlackboard' }] }, {}), /tool calls/);
});

test('public tool journal precedes an exact mandatory trailing tracker and keeps default append behavior for generic prose', () => {
    const journal = '<details><summary>Tool journal</summary>Roll: 7.</details>';
    const joined = appendCompatibilityJournal('Normal narration.\n\n' + tracker + '\n ', journal);
    assert.equal(joined, 'Normal narration.\n\n' + journal + '\n\n' + tracker);
    assert.equal(joined.endsWith(tracker), true);
    assert.equal(validateNarrationText({ text: joined }, { requiredInternalStates: true }), joined);
    assert.equal(appendCompatibilityJournal('Normal narration.', journal), 'Normal narration.\n\n' + journal);
    const nonTrailing = tracker + '\nAn ordinary afterword.';
    assert.equal(appendCompatibilityJournal(nonTrailing, journal), nonTrailing + '\n\n' + journal);
});

test('unreviewed world execution gets exactly one tool-free narration plus an independent read-only check', async () => {
    const h = harness({ ff: true });
    const result = await h.run();
    assert.deepEqual(h.requests.map(request => request.phase), ['simulate', 'simulate', 'narrate', 'narration_check']);
    assert.equal(h.invocations.length, 1);
    assert.equal(h.invocations[0].name, 'RollTheDice');
    for (const request of h.requests.filter(request => request.phase !== 'simulate')) assert.deepEqual(request.allowed, []);
    assert.match(h.requests[0].messages[0].content, /QUALITY: prepare next contacts/);
    assert.doesNotMatch(h.requests[0].messages[0].content, /NATIVE_PRESET/);
    assert.match(h.requests[0].packet.reference_context[0].content, /NATIVE_PRESET/);
    assert.match(h.requests[2].messages[0].content, /NATIVE_PRESET/);
    assert.match(h.requests[3].messages[0].content, /INDEPENDENT FINAL NARRATION REVIEW/);
    assert.equal(result.candidate, h.narration);
    assert.equal(result.narration.resolvedCandidate, h.resolved);
    assert.equal(result.narration.priorTrackerRestored, true);
    assert.equal(result.narration.review.verdict, 'pass');
    assert.equal(result.stats.reviews, 0);
    assert.equal(result.stats.requests, 4);
    assert.equal(result.draft.rolls.length, 1);
    assert.equal(result.draft.versions.length, 2);
    assert.equal(processRegister(result.draft.head).through, 'Day 1, 02:15:06');
});

test('separate narration retains all four Heavy world audits before its independent final narration check', async () => {
    const h = harness({ reviewEnabled: true });
    const result = await h.run();
    assert.deepEqual(h.requests.map(request => request.phase), ['simulate', 'simulate', 'review', 'review', 'review', 'review', 'narrate', 'narration_check']);
    assert.equal(result.stats.reviews, 4);
    assert.equal(result.stats.repairs, 0);
    assert.equal(result.stats.requests, 8);
    assert.equal(result.narration.requests, 2);
    assert.equal(result.review.stages.length, 4);
    assert.equal(result.narration.review.verdict, 'pass');
    assert.equal(h.invocations.length, 1);
});

test('separate narration retains Light detection and correction before its independent final narration check', async () => {
    const h = harness({ reviewEnabled: true, request: async ({ phase, packet }) => {
        if (phase === 'repair') return { text: JSON.stringify({ revision: packet.head_revision,
            candidate_id: packet.candidate_id, candidate: packet.previous_candidate, issue_resolutions: [] }) };
    } });
    const result = await h.run({ reviewMode: 'light' });
    assert.deepEqual(h.requests.map(request => request.phase), ['simulate', 'simulate', 'review', 'repair', 'narrate', 'narration_check']);
    assert.equal(result.stats.reviews, 1);
    assert.equal(result.stats.repairs, 1);
    assert.equal(result.stats.requests, 6);
    assert.equal(result.narration.requests, 2);
    assert.equal(result.review.review_mode, 'light');
    assert.equal(result.review.independent_verification, false);
    assert.equal(result.narration.review.verdict, 'pass');
    assert.equal(h.invocations.length, 1);
});

test('selected concise presentation survives removal of the live world injection and reaches the narrator as its own instructions', async () => {
    const h = harness();
    const layers = freezeCampaignLayers({ narrativeStyle: 'concise' });
    const result = await h.run({ campaignLayers: layers });
    const narration = h.requests.find(request => request.phase === 'narrate');
    assert.equal(narration.packet.presentation_instructions, CAMPAIGN_PROMPTS['narration-concise']);
    assert.ok(narration.packet.presentation_instructions.trim());
    assert.doesNotMatch(JSON.stringify(narration.messages.slice(0, -2)), /BLACKBOARD_COMPAT_WORLD|QUALITY: prepare/);
    assert.equal(result.draft.campaignLayers.narrativeStyle, 'concise');
    const check = h.requests.find(request => request.phase === 'narration_check');
    assert.equal(check.packet.presentation_instructions, narration.packet.presentation_instructions);
});

test('a grounded narration discrepancy rewrites presentation only, retaining exact world revisions and dice', async () => {
    let narratives = 0, checks = 0;
    const h = harness({ request: async ({ phase, packet, allowed }) => {
        if (phase === 'narrate') {
            assert.deepEqual(allowed, []);
            if (!narratives++) return { text: 'The lock opens.' };
            assert.equal(packet.previous_narration, 'The lock opens.');
            assert.equal(packet.findings_to_correct[0].aspect, 'outcomes');
            assert.equal(packet.binding_dice.length, 1);
            return { text: 'Six seconds pass. The lock resists; the door remains closed.' };
        }
        if (phase === 'narration_check' && !checks++) return { text: JSON.stringify({ version: 1,
            revision: packet.revision, narration_id: packet.narration_id, verdict: 'revise',
            checks: ['outcomes', 'agency', 'disclosure', 'format'].map(aspect => ({ aspect, status: aspect === 'outcomes' ? 'issue' : 'pass' })),
            issues: [{ aspect: 'outcomes', quote: 'The lock opens.', problem: 'A failed attempt became a success.',
                correction: 'Preserve the failed attempt and closed door.', evidence: [{ source: 'resolved_candidate', quote: 'The lock resists' }] }] }) };
    } });
    const result = await h.run();
    assert.equal(result.narration.rewrites, 1);
    assert.equal(result.narration.requests, 4);
    assert.equal(h.invocations.length, 1);
    assert.equal(h.requests.filter(request => request.phase === 'simulate').length, 2);
    assert.equal(result.draft.versions.length, 2);
    assert.equal(result.candidate, h.resolved);
});

test('a format error during narration repair cannot erase substantive findings or repeat world execution', async () => {
    let narratives = 0, checks = 0;
    const h = harness({ request: async ({ phase, packet }) => {
        if (phase === 'narrate') {
            narratives++;
            if (narratives === 1) return { text: 'The lock opens.' };
            assert.ok(packet.findings_to_correct.some(issue => issue.aspect === 'outcomes' && issue.problem === 'Failed attempt became success.'));
            if (narratives === 2) return { text: '', calls: [{ name: 'UpdateBlackboard', arguments: {} }] };
            assert.equal(packet.findings_to_correct.filter(issue => issue.output_format_error).length, 1);
            assert.equal(packet.findings_to_correct.length, 2);
            return { text: 'Six seconds pass. The lock resists; the door remains closed.' };
        }
        if (phase === 'narration_check' && !checks++) return { text: JSON.stringify({ version: 1,
            revision: packet.revision, narration_id: packet.narration_id, verdict: 'revise',
            checks: ['outcomes', 'agency', 'disclosure', 'format'].map(aspect => ({ aspect, status: aspect === 'outcomes' ? 'issue' : 'pass' })),
            issues: [{ aspect: 'outcomes', quote: 'The lock opens.', problem: 'Failed attempt became success.',
                correction: 'Retain failure.', evidence: [{ source: 'resolved_candidate', quote: 'The lock resists' }] }] }) };
    } });
    const result = await h.run();
    assert.equal(result.narration.rewrites, 1);
    assert.equal(narratives, 3);
    assert.equal(h.invocations.length, 1);
    assert.equal(result.draft.versions.length, 2);
    assert.equal(result.narration.log.filter(entry => entry.status === 'invalid_output').length, 1);
    assert.equal(result.narration.review.verdict, 'pass');
});

test('final review accepts literal prior dialogue and multiline evidence without requiring JSON escape sequences', async () => {
    let narratives = 0, checks = 0;
    const prior = 'The guard said, "Stay here."\nHe locked the door.';
    const h = harness({ request: async ({ phase, packet }) => {
        if (phase === 'narrate' && !narratives++) return { text: 'The guard never spoke.' };
        if (phase === 'narration_check' && !checks++) return { text: JSON.stringify({ version: 1,
            revision: packet.revision, narration_id: packet.narration_id, verdict: 'revise',
            checks: ['outcomes', 'agency', 'disclosure', 'format'].map(aspect => ({ aspect, status: aspect === 'outcomes' ? 'issue' : 'pass' })),
            issues: [{ aspect: 'outcomes', quote: 'never spoke', problem: 'The narration contradicts the prior public warning.',
                correction: 'Preserve the established warning.', evidence: [{ source: 'visible_history', quote: prior }] }] }) };
    } });
    h.options.chat[0].mes = prior;
    const result = await h.run();
    assert.equal(result.narration.rewrites, 1);
    assert.equal(result.narration.log.some(entry => entry.status === 'invalid_output'), false);
});

for (const failPhase of ['narrate', 'narration_check']) test(`API failure at ${failPhase} resumes its saved presentation request without reexecuting world or dice`, async () => {
    let failed = false;
    const h = harness({ request: async ({ phase }) => {
        if (phase === failPhase && !failed) { failed = true; throw new Error('429 fixture'); }
    } });
    await assert.rejects(h.run(), /429 fixture/);
    const worldBefore = structuredClone(h.checkpoint.world.draft);
    assert.equal(h.checkpoint.phase, failPhase);
    assert.ok(h.checkpoint.pending);
    const result = await h.resume();
    assert.equal(h.invocations.length, 1);
    assert.deepEqual(result.draft.versions, worldBefore.versions);
    assert.deepEqual(result.draft.rolls, worldBefore.rolls);
    assert.equal(h.requests.filter(request => request.phase === 'simulate').length, 2);
    assert.equal(result.narration.review.verdict, 'pass');
});

for (const abortPhase of ['narrate', 'narration_check']) test(`cancellation after ${abortPhase} response saves the received answer and Resume processes it without another request`, async () => {
    const controller = new AbortController();
    let aborted = false;
    const h = harness({ signal: controller.signal, request: async ({ phase, packet }) => {
        if (phase === abortPhase && !aborted) {
            aborted = true; controller.abort(new Error('Stop fixture'));
            return phase === 'narrate' ? { text: 'Six seconds pass. The lock resists; the door remains closed.' } : narrativePass(packet);
        }
    } });
    await assert.rejects(h.run(), /Stop fixture/);
    assert.equal(h.checkpoint.phase, abortPhase);
    assert.ok(h.checkpoint.answer);
    const result = await h.resume();
    assert.equal(result.narration.review.verdict, 'pass');
    assert.equal(h.requests.filter(request => request.phase === abortPhase).length, 1);
    assert.equal(h.invocations.length, 1);
});

test('a completed checkpoint resumes without any request, new version or dice invocation', async () => {
    const h = harness();
    const result = await h.run();
    const before = h.requests.length;
    const resumed = await h.resume({ request: () => assert.fail('No request after completed presentation'), invoke: () => assert.fail('No tool replay') });
    assert.equal(h.requests.length, before);
    assert.equal(resumed.candidate, result.candidate);
    assert.deepEqual(resumed.narration.log, result.narration.log);
    assert.deepEqual(resumed.draft.versions, result.draft.versions);
});

test('malformed or fabricated final check cannot publish and preserves the same narration on format-only Resume', async () => {
    let invalid = true;
    const h = harness({ request: async ({ phase }) => phase === 'narration_check' && invalid ? { text: '{"verdict":"pass"}' } : undefined });
    await assert.rejects(h.run(), /invalid output twice/);
    assert.equal(h.checkpoint.phase, 'narration_check');
    assert.equal(h.checkpoint.haltKind, 'format');
    assert.equal(h.requests.filter(request => request.phase === 'narrate').length, 1);
    assert.equal(h.invocations.length, 1);
    invalid = false;
    const result = await h.resume();
    assert.equal(result.narration.review.verdict, 'pass');
    assert.equal(h.requests.filter(request => request.phase === 'narrate').length, 1);
});

for (const failure of ['error', 'safety']) test(`a final check carrying ${failure} cannot pass using otherwise valid-looking JSON`, async () => {
    const h = harness({ request: async ({ phase, packet }) => {
        if (phase === 'narration_check') return { ...narrativePass(packet),
            ...(failure === 'error' ? { error: 'upstream fixture' } : { finishReason: 'safety' }) };
    } });
    await assert.rejects(h.run(), /invalid output twice/);
    assert.equal(h.checkpoint.haltKind, 'format');
    assert.equal(h.checkpoint.phase, 'narration_check');
    assert.equal(h.checkpoint.finalReview, undefined);
    assert.equal(h.invocations.length, 1);
});

test('narrator tool calls are never invoked or converted to output; repeated missing FF tracker halts safely', async () => {
    const h = harness({ ff: true, request: async ({ phase }) => phase === 'narrate'
        ? { text: 'Incomplete narration.', calls: [{ name: 'RollTheDice', arguments: { formula: '1d20' } }] } : undefined });
    await assert.rejects(h.run(), /invalid output twice/);
    assert.equal(h.invocations.length, 1, 'Only the world roll may be invoked');
    assert.equal(h.requests.filter(request => request.phase === 'narration_check').length, 0);
    assert.equal(h.checkpoint.world.phase, 'done');
    assert.ok(h.checkpoint.log.some(entry => entry.error?.includes('tool calls')));
});

test('media reaches isolated preparation, native narrator and independent checker without modifying the source context', async () => {
    const h = harness({ media: true });
    const original = structuredClone(h.options.context);
    await h.run();
    for (const phase of ['simulate', 'narrate', 'narration_check']) {
        const messages = h.requests.find(request => request.phase === phase).messages;
        const parts = messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
        assert.ok(parts.some(part => part.type === 'image_url' && part.image_url.url === 'data:image/png;base64,fixture'), phase);
    }
    assert.deepEqual(h.options.context, original);
});

test('saved separate mode rejects execution or review changes without requests and retains ordinary completed checkpoint behavior', async () => {
    let outage = true;
    const h = harness({ request: async ({ phase }) => { if (outage && phase === 'narrate') throw new Error('outage fixture'); } });
    await assert.rejects(h.run(), /outage fixture/);
    const before = h.requests.length;
    await assert.rejects(h.resume({ reviewEnabled: true }), /review setting changed/);
    await assert.rejects(h.resume({ checkpoint: h.checkpoint.world }), /different execution mode/);
    await assert.rejects(h.resume({ reviewMode: 'light' }), /review mode changed/);
    assert.equal(h.requests.length, before);
    outage = false;
    const result = await h.resume();
    assert.equal(result.narration.review.verdict, 'pass');
});
