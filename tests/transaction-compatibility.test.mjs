import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPrivateTurn, processRegister } from '../transaction.js';
import { pass } from './review-fixtures.mjs';

const time = seconds => `Day 1, 02:15:${String(seconds).padStart(2, '0')}`;
const clock = seconds => `[MISC #world_clock]\n- Time: ${time(seconds)}`;
const register = seconds => '[MISC #simulation_processes]\n' + JSON.stringify({ version: 1, through: time(seconds), processes: [] });
const board = seconds => `${clock(seconds)}\n${register(seconds)}\n[ENTITIES #hero]\nHP 20/20; gold 200.\n[SCENE #room]\nA closed door.`;
const payload = messages => {
    const content = messages.at(-1).content;
    const text = Array.isArray(content) ? content.find(part => part.type === 'text').text : content;
    return JSON.parse(text.split('\n').slice(1).join('\n'));
};
const update = (revision, content) => ({ name: 'UpdateBlackboard', arguments: { base_revision: revision, content } });
const instructions = 'Quality: prepare all next contacts. System: Universal campaign rules.';

test('separate preparation without model audits still stages, validates and returns only the resolved interval', async () => {
    let requests = 0;
    const result = await runPrivateTurn({ baseline: board(0), context: [{ role: 'user', content: 'Wait six seconds.' }],
        reviewEnabled: false, simulationInstructions: instructions, invoke: () => assert.fail('No external tools expected'),
        request: async (messages, allowed) => {
            const p = payload(messages);
            assert.equal(p.phase, 'simulate');
            assert.ok(allowed.includes('UpdateBlackboard'));
            if (!requests++) return { calls: [update(0, clock(6) + '\n' + register(6))] };
            assert.equal(p.head_revision, 1);
            return { text: 'Six seconds pass. The door remains closed.' };
        },
    });
    assert.equal(result.stats.requests, 2);
    assert.equal(result.stats.reviews, 0);
    assert.equal(result.stats.repairs, 0);
    assert.equal(result.stats.reviewEnabled, false);
    assert.equal(result.stats.isolatedSimulation, true);
    assert.equal(result.review.review_mode, 'local');
    assert.equal(result.review.independent_verification, false);
    assert.equal(result.review.verdict, 'pass');
    assert.equal(processRegister(result.draft.head).through, time(6));
    assert.equal(result.draft.versions.length, 2);
});

test('separate preparation receives native instructions as reference data and preserves multimodal evidence', async () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } };
    const context = [
        { role: 'system', content: 'PRESET_ONLY: tick NPC agenda per response and output <internal_states>.' },
        { role: 'assistant', content: 'Earlier answer with a tracker.' },
        { role: 'user', content: [{ type: 'text', text: 'Look at this map.' }, image] },
    ];
    const original = structuredClone(context);
    await runPrivateTurn({ baseline: board(0), context, reviewEnabled: false, simulationInstructions: instructions,
        invoke: () => assert.fail('No tools expected'),
        request: async messages => {
            assert.equal(messages.length, 2);
            assert.equal(messages[0].role, 'system');
            assert.match(messages[0].content, /Quality: prepare all next contacts/);
            assert.match(messages[0].content, /Do not execute procedural tasks/);
            assert.doesNotMatch(messages[0].content, /PRESET_ONLY/);
            assert.deepEqual(payload(messages).reference_context, context);
            assert.ok(messages[1].content.some(part => part.type === 'image_url' && part.image_url.url === image.image_url.url));
            return { text: 'The map matches the established room.' };
        },
    });
    assert.deepEqual(context, original);
});

test('isolation still supports the selected Light detection and correction pipeline', async () => {
    let detections = 0, corrections = 0;
    const result = await runPrivateTurn({ baseline: board(0), context: [{ role: 'system', content: 'PRESET_ONLY' }],
        reviewMode: 'light', simulationInstructions: instructions, invoke: () => assert.fail('No tools expected'),
        request: async messages => {
            const p = payload(messages);
            assert.equal(messages.length, 2);
            assert.doesNotMatch(messages[0].content, /PRESET_ONLY/);
            if (p.phase === 'review') { detections++; return pass(p); }
            if (p.phase === 'repair') {
                corrections++;
                return { text: JSON.stringify({ revision: p.head_revision, candidate_id: p.candidate_id,
                    candidate: p.previous_candidate, issue_resolutions: [] }) };
            }
            return { text: 'The door remains closed.' };
        },
    });
    assert.equal(detections, 1);
    assert.equal(corrections, 1);
    assert.equal(result.stats.reviews, 1);
});

test('disabling model audits cannot commit a clock/register mismatch; blocked checkpoint preserves the candidate', async () => {
    let checkpoint, requests = 0;
    const options = { baseline: board(0), context: [], reviewEnabled: false, simulationInstructions: instructions,
        saveCheckpoint: async state => { checkpoint = structuredClone(state); },
        invoke: () => assert.fail('No tools expected'),
        request: async () => requests++ ? { text: 'Six seconds pass.' } : { calls: [update(0, clock(6))] },
    };
    await assert.rejects(runPrivateTurn(options), /failed local validation.*world_clock and process register/);
    assert.equal(checkpoint.haltKind, 'local_validation');
    assert.equal(checkpoint.review.verdict, 'blocked');
    assert.equal(checkpoint.candidate, 'Six seconds pass.');
    assert.equal(checkpoint.draft.versions.length, 2);
    const count = requests;
    await assert.rejects(runPrivateTurn({ ...options, checkpoint }), /failed local validation/);
    assert.equal(requests, count, 'Resume must not replay the action to bypass failed validation');
});

test('resume after an isolated continuation failure preserves dice and world progress without reopening simulation', async () => {
    let checkpoint, requests = 0, rolls = 0;
    const options = { baseline: board(0), context: [{ role: 'user', content: 'Attempt the lock.' }],
        reviewEnabled: false, simulationInstructions: instructions,
        saveCheckpoint: async state => { checkpoint = structuredClone(state); },
        invoke: async () => { rolls++; return 'The result is: 7. Individual rolls: 7'; },
        request: async messages => {
            const p = payload(messages);
            requests++;
            if (requests === 1) return { calls: [{ name: 'RollTheDice', arguments: { formula: '1d20' } }, update(0, clock(6) + '\n' + register(6))] };
            assert.equal(p.rolls.length, 1);
            assert.equal(p.head_revision, 1);
            if (requests === 2) throw new Error('429 fixture');
            return { text: 'Six seconds pass. The lock resists.' };
        },
    };
    await assert.rejects(runPrivateTurn(options), /429 fixture/);
    const result = await runPrivateTurn({ ...options, checkpoint });
    assert.equal(rolls, 1);
    assert.equal(result.draft.rolls.length, 1);
    assert.equal(result.draft.versions.length, 2);
    assert.equal(processRegister(result.draft.head).through, time(6));
    const before = requests;
    const resumed = await runPrivateTurn({ ...options, checkpoint });
    assert.equal(requests, before, 'Completed checkpoint must not repeat requests');
    assert.equal(resumed.candidate, result.candidate);
});

test('saved preparation refuses changed isolation text and review activation but old default checkpoints still resume', async () => {
    let checkpoint;
    const options = { baseline: board(0), context: [], reviewEnabled: false, simulationInstructions: instructions,
        saveCheckpoint: async state => { checkpoint = structuredClone(state); }, invoke: () => {},
        request: async () => { throw new Error('outage fixture'); },
    };
    await assert.rejects(runPrivateTurn(options), /outage fixture/);
    await assert.rejects(runPrivateTurn({ ...options, checkpoint, simulationInstructions: instructions + ' changed' }), /isolation instructions changed/);
    await assert.rejects(runPrivateTurn({ ...options, checkpoint, reviewEnabled: true }), /review setting changed/);
    await assert.rejects(runPrivateTurn({ ...options, checkpoint, simulationInstructions: null }), /isolation instructions changed/);

    let standardCheckpoint;
    const defaultOptions = { baseline: board(0), context: [], invoke: () => {},
        saveCheckpoint: async state => { standardCheckpoint = structuredClone(state); },
        request: async messages => payload(messages).phase === 'review' ? pass(payload(messages)) : { text: 'The door remains closed.' },
    };
    const expected = await runPrivateTurn(defaultOptions);
    assert.equal(Object.hasOwn(standardCheckpoint, 'reviewEnabled'), false);
    assert.equal(Object.hasOwn(standardCheckpoint, 'simulationInstructions'), false);
    const actual = await runPrivateTurn({ ...defaultOptions, checkpoint: standardCheckpoint,
        request: () => assert.fail('Completed legacy-default checkpoint must not request again') });
    assert.equal(actual.candidate, expected.candidate);
    assert.equal(actual.stats.reviews, 4);
});
