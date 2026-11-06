// These fixtures exercise policy isolation, stage routing and checkpoint safety.
// They do not establish a model's ability to estimate unbiased NPC probabilities.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choiceResolutionInstructions, freezeChoiceResolution, validateChoiceResolution, choiceReviewCriteria } from '../choice-resolution.js';
import { composeGamePrompt, GAME_SYSTEMS } from '../game-profiles.js';
import { freezeCampaignLayers, campaignLayersFingerprint, getCampaignReviewCriteria } from '../campaign-layers.js';
import { createRecovery } from '../recovery.js';
import { runPrivateTurn } from '../transaction.js';
import { browserEnvironment } from './browser-fixtures.mjs';
import { payload, pass, report } from './review-fixtures.mjs';
import { markCompatibilityInjection, runPresetCompatibleTurn } from '../preset-compatibility.js';
import { rollBlackboardDice } from '../dice-engine.js';

const baseline = `[MISC #world_clock]
Time: Day 1, 01:00:00
[MISC #simulation_processes]
{"version":1,"through":"Day 1, 01:00:00","processes":[]}
[ENTITIES #guard]
Location: hall. Cautious and curious; heard the actual proposal. No decision yet.
[SCENE #hall]
Guard waits by a closed door.`;
const defaults = { simulationFidelity: 'mid', gameSystem: 'dnd5e', simulationFocus: 'general',
    campaignStyle: 'inherit', campaignTone: 'inherit', narrativeStyle: 'inherit' };

function recoveryHarness(initial = {}) {
    const settings = { privateReview: true, ...defaults, ...initial };
    const ctx = { chatId: 'choices', characterId: 0, characters: [{ avatar: 'hero.png' }],
        chat: [{ is_user: true, mes: 'I make an unexpected offer.' }], chatMetadata: {}, chatCompletionSettings: { model: 'fixture' } };
    const records = new Map();
    const recovery = createRecovery({ getContext: () => ctx, getBoard: () => baseline, settings: () => settings,
        getAccount: async () => 'tester', environment: browserEnvironment(),
        store: { get: async key => structuredClone(records.get(key)), put: async record => records.set(record.key, structuredClone(record)), delete: async key => records.delete(key) } });
    return { settings, ctx, recovery, create: async () => recovery.create(ctx, 'normal', [], await recovery.key()) };
}

test('contextual choices are opt-in and default-off frozen records preserve the previous shape', () => {
    const off = freezeCampaignLayers(defaults);
    assert.equal(Object.hasOwn(off, 'choiceResolution'), false);
    for (const contextualChoices of [undefined, false, null, 0, 1, 'true']) {
        const settings = { ...defaults, contextualChoices };
        assert.equal(choiceResolutionInstructions(settings), '');
        assert.equal(freezeChoiceResolution(settings), undefined);
        assert.deepEqual(freezeCampaignLayers(settings), off);
        assert.equal(campaignLayersFingerprint(settings), campaignLayersFingerprint(defaults));
        for (const aspect of ['time', 'continuity', 'reach', 'narration', 'light']) assert.equal(getCampaignReviewCriteria(settings, aspect), '');
    }
});

test('optional choice policy composes once after independent campaign layers for every quality and game profile', () => {
    for (const simulationFidelity of ['low', 'mid', 'high', 'ultra', 'custom']) {
        for (const gameSystem of Object.keys(GAME_SYSTEMS)) {
            const settings = { ...defaults, simulationFidelity, gameSystem, simulationFocus: 'relationships_social',
                campaignStyle: 'deductive', ...(simulationFidelity === 'custom' ? { customPrompt: 'Exact custom quality source. {{getvar::world_blackboard}}' } : {}) };
            const off = composeGamePrompt(settings), on = composeGamePrompt({ ...settings, contextualChoices: true });
            assert.equal(on.rawBase, off.rawBase, 'Quality source remains verbatim');
            assert.equal(on.profile, off.profile, 'Game rules remain independent');
            assert.equal(on.campaignLayers.instructions, off.campaignLayers.instructions, 'Campaign preview remains independent');
            assert.equal(on.choiceInstructions, choiceResolutionInstructions({ contextualChoices: true }));
            assert.equal(on.text, off.text + '\n---\n\n' + on.choiceInstructions + '\n');
            assert.equal(on.text.split(on.choiceInstructions).length, 2, 'One optional section only');
        }
    }
});

test('choice descriptors are independent serializable values and reject malformed or unsupported enabled versions', () => {
    const first = freezeChoiceResolution({ contextualChoices: true }), second = freezeChoiceResolution({ contextualChoices: true });
    first.reviewCriteria.time = 'Caller changed its own value.';
    assert.notEqual(first.reviewCriteria.time, second.reviewCriteria.time);
    assert.deepEqual(validateChoiceResolution(JSON.parse(JSON.stringify(second))), second);
    assert.equal(validateChoiceResolution(undefined), undefined);
    for (const malformed of [null, false, {}, { ...second, version: 99 }, { ...second, enabled: false },
        { ...second, instructions: '' }, { ...second, reviewCriteria: { ...second.reviewCriteria, time: null } },
        { ...second, unexpected: 'unknown field' }]) {
        assert.throws(() => validateChoiceResolution(malformed), /contextual-choice instruction snapshot/);
        const snapshot = { ...freezeCampaignLayers(defaults), choiceResolution: malformed };
        assert.throws(() => campaignLayersFingerprint(snapshot), /contextual-choice instruction snapshot/);
    }
});

test('choice criteria follow their current review aspect while inherited campaign instructions remain empty', () => {
    const snapshot = freezeCampaignLayers({ ...defaults, contextualChoices: true });
    assert.equal(snapshot.instructions, '');
    for (const aspect of ['time', 'continuity', 'reach', 'narration', 'combined', 'light']) {
        assert.equal(getCampaignReviewCriteria(snapshot, aspect), choiceReviewCriteria(snapshot.choiceResolution, aspect));
    }
    assert.notEqual(getCampaignReviewCriteria(snapshot, 'time'), getCampaignReviewCriteria(snapshot, 'continuity'));
    assert.equal(choiceReviewCriteria(snapshot.choiceResolution, 'unrecognized'), '');
});

test('older checkpoints lacking the opt-in setting resume with off only and retain their exact frozen context', async () => {
    const h = recoveryHarness(), record = await h.create(), originalMessages = structuredClone(record.messages);
    assert.equal(Object.hasOwn(record.campaignLayers, 'choiceResolution'), false);
    h.settings.contextualChoices = false;
    await h.recovery.validate(record, h.ctx);
    assert.deepEqual(record.messages, originalMessages);
    h.settings.contextualChoices = true;
    const before = JSON.stringify(record);
    await assert.rejects(h.recovery.validate(record, h.ctx), /Campaign settings or instructions changed/);
    assert.equal(JSON.stringify(record), before, 'A blocked resume preserves its saved work');
    assert.ok(await h.recovery.load(record.key));
});

test('changing an enabled option or its frozen prompt text cannot reinterpret a paused turn', async () => {
    const h = recoveryHarness({ contextualChoices: true }), record = await h.create();
    await h.recovery.validate(record, h.ctx);
    h.settings.contextualChoices = false;
    await assert.rejects(h.recovery.validate(record, h.ctx), /Campaign settings or instructions changed/);
    h.settings.contextualChoices = true;
    record.campaignLayers.choiceResolution.instructions += '\nPrevious choice policy revision.';
    await assert.rejects(h.recovery.validate(record, h.ctx), /Campaign settings or instructions changed/);
});

test('Heavy adds focused frozen choice criteria to its existing four audits without another request or dice permission', async () => {
    const snapshot = freezeCampaignLayers({ ...defaults, contextualChoices: true });
    const original = structuredClone(snapshot), stages = [];
    const result = await runPrivateTurn({ baseline, context: [], campaignLayers: snapshot,
        request: async (messages, allowed) => {
            const p = payload(messages);
            if (p.phase === 'simulate') {
                snapshot.choiceResolution.reviewCriteria.time = 'Mutated caller snapshot.';
                return { text: 'The guard considers your offer.' };
            }
            stages.push(p.audit.stage);
            assert.ok(messages[0].content.endsWith(getCampaignReviewCriteria(original, p.audit.stage)));
            assert.equal(allowed.includes('RollBlackboardDice'), false);
            return pass(p);
        } });
    assert.deepEqual(stages, ['time', 'continuity', 'reach', 'narration']);
    assert.equal(result.stats.requests, 5);
    assert.deepEqual(result.draft.campaignLayers, original);
});

test('Light uses its existing detect/correct pair with choice criteria and no new repair rolls', async () => {
    const snapshot = freezeCampaignLayers({ ...defaults, contextualChoices: true }), phases = [];
    const result = await runPrivateTurn({ baseline, context: [], campaignLayers: snapshot, reviewMode: 'light',
        request: async (messages, allowed) => {
            const p = payload(messages); phases.push(p.phase);
            if (p.phase === 'simulate') return { text: 'The guard considers your offer.' };
            assert.ok(messages[0].content.endsWith(getCampaignReviewCriteria(snapshot, 'light')));
            assert.equal(allowed.includes('RollBlackboardDice'), false);
            if (p.phase === 'review') return { text: JSON.stringify(report(p)) };
            return { text: JSON.stringify({ revision: p.head_revision, candidate_id: p.candidate_id,
                candidate: 'The guard considers your offer.', issue_resolutions: [] }) };
        } });
    assert.deepEqual(phases, ['simulate', 'review', 'repair']);
    assert.equal(result.stats.requests, 3);
});

test('a choice policy mismatch rejects transaction resume before any provider or checkpoint write', async () => {
    const snapshot = freezeCampaignLayers({ ...defaults, contextualChoices: true });
    let checkpoint;
    await assert.rejects(runPrivateTurn({ baseline, context: [], campaignLayers: snapshot,
        saveCheckpoint: async saved => { checkpoint = structuredClone(saved); },
        request: async () => { throw new Error('429 fixture'); } }), /429 fixture/);
    const before = JSON.stringify(checkpoint);
    for (const replacement of [freezeCampaignLayers(defaults), (() => {
        const copy = structuredClone(snapshot); copy.choiceResolution.reviewCriteria.continuity += '\nDifferent review revision.'; return copy;
    })()]) {
        await assert.rejects(runPrivateTurn({ baseline, context: [], campaignLayers: replacement, checkpoint,
            request: () => assert.fail('No paid request with mismatched choice policy'),
            saveCheckpoint: () => assert.fail('No overwrite of original checkpoint'),
        }), /instruction version/);
    }
    assert.equal(JSON.stringify(checkpoint), before);
});

test('Separate narration receives a binding weighted symbolic choice from preparation without executing the option again', async () => {
    const settings = { ...defaults, contextualChoices: true }, phases = [], invocations = [];
    const instructions = composeGamePrompt(settings).text;
    const outcome = 'The guard offers a limited trial under supervision.';
    const choices = ['The guard declines while leaving later discussion possible.', outcome, outcome];
    let step = 0;
    const result = await runPresetCompatibleTurn({ baseline, campaignLayers: freezeCampaignLayers(settings), reviewEnabled: false,
        context: [{ role: 'system', content: 'Native preset presentation instructions.' },
            { role: 'system', content: markCompatibilityInjection(instructions, 'world') },
            { role: 'user', content: 'I make an unexpected offer.' }],
        invoke: async (name, args) => {
            invocations.push({ name, args });
            assert.equal(name, 'RollBlackboardDice');
            return rollBlackboardDice(args, { randomUint32: () => 1 });
        },
        request: async (messages, allowed) => {
            const text = messages.at(-1).content;
            const p = JSON.parse(text.startsWith('{') ? text : text.split('\n').slice(1).join('\n'));
            const phase = p.phase ?? (text.startsWith('BLACKBOARD RESOLVED TURN') ? 'narrate' : 'narration_check');
            phases.push(phase);
            if (phase === 'simulate') {
                assert.ok(messages[0].content.includes(choiceResolutionInstructions(settings)));
                if (step++ === 0) return { calls: [{ name: 'RollBlackboardDice', arguments: {
                    face_type: 'symbol', count: 1, faces: choices,
                    label: 'Guard: refusal 1, supervised trial 2; cautious but curious about the proposal.',
                } }] };
                if (step === 2) return { calls: [{ name: 'UpdateBlackboard', arguments: {
                    action: 'upsert', block_id: 'ENTITIES #guard', base_revision: 0,
                    content: 'Location: hall. Cautious and curious; heard the actual proposal. ' + outcome,
                } }] };
                return { text: outcome };
            }
            assert.deepEqual(allowed, [], 'Presentation stages have no tools');
            assert.equal(messages[0].content.includes(choiceResolutionInstructions(settings)), false);
            assert.deepEqual(p.binding_dice[0].result.face_values, [outcome]);
            assert.equal(p.binding_dice[0].result.total, null);
            if (phase === 'narrate') return { text: outcome };
            return { text: JSON.stringify({ version: 1, revision: p.revision, narration_id: p.narration_id,
                verdict: 'pass', checks: ['outcomes', 'agency', 'disclosure', 'format'].map(aspect => ({ aspect, status: 'pass' })), issues: [] }) };
        } });
    assert.deepEqual(phases, ['simulate', 'simulate', 'simulate', 'narrate', 'narration_check']);
    assert.equal(invocations.length, 1);
    assert.deepEqual(invocations[0].args.faces, choices, 'Weights were supplied before randomness');
    assert.equal(result.draft.rolls.length, 1);
    assert.match(result.draft.head, /offers a limited trial/);
    assert.equal(result.candidate, outcome);
});
