// These fixtures verify frozen configuration, routing and request counts, not
// a real model's semantic ability to identify a social or genre discrepancy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecovery } from '../recovery.js';
import { runPrivateTurn } from '../transaction.js';
import { reviewProtocol } from '../review.js';
import { freezeCampaignLayers, getCampaignReviewCriteria } from '../campaign-layers.js';
import { browserEnvironment } from './browser-fixtures.mjs';
import { payload, pass, report } from './review-fixtures.mjs';

const baseline = `[MISC #world_clock]
Time: Day 1, 01:00:00
[MISC #simulation_processes]
{"version":1,"through":"Day 1, 01:00:00","processes":[]}
[ENTITIES #guard]
Location: hall. Waiting by the door. Trusts the established signed letter.
[SCENE #hall]
Guard waits by the door. Desk contains a letter.`;
const selected = { simulationFidelity: 'mid', simulationFocus: 'relationships_social', campaignStyle: 'deductive', campaignTone: 'hopeful', narrativeStyle: 'concise' };
const defaults = { simulationFocus: 'general', campaignStyle: 'inherit', campaignTone: 'inherit', narrativeStyle: 'inherit' };

function recoveryHarness(initial = {}) {
    const settings = { privateReview: true, ...initial };
    const ctx = { chatId: 'campaign', characterId: 0, characters: [{ avatar: 'hero.png' }],
        chat: [{ is_user: true, mes: 'Wait.' }], chatMetadata: {}, chatCompletionSettings: { model: 'fixture' } };
    const records = new Map();
    const recovery = createRecovery({ getContext: () => ctx, getBoard: () => baseline, settings: () => settings,
        getAccount: async () => 'tester', environment: browserEnvironment(),
        store: { get: async key => structuredClone(records.get(key)), put: async record => records.set(record.key, structuredClone(record)), delete: async key => records.delete(key) } });
    return { settings, ctx, recovery, create: async () => recovery.create(ctx, 'normal', [], await recovery.key()) };
}

test('pre-separation recovery remains blocked even with General and inherited defaults, preserving the saved draft', async () => {
    for (const previousVersion of [null, 1]) {
        const h = recoveryHarness(), record = await h.create();
        if (previousVersion === null) delete record.campaignLayers;
        else record.campaignLayers.version = previousVersion;
        Object.assign(h.settings, defaults);
        const original = JSON.stringify(record);
        const boardBefore = baseline;
        await assert.rejects(h.recovery.validate(record, h.ctx), /predates the separated.*draft is preserved.*original extension version and settings/);
        assert.equal(JSON.stringify(record), original, 'A blocked migration must not erase or rewrite checkpoint evidence.');
        assert.equal(baseline, boardBefore);
        assert.ok(await h.recovery.load(record.key), 'Checkpoint stays available for export or the original extension copy.');
    }
});

test('a separation migration marker cannot be stripped as a harmless legacy setting', async () => {
    const h = recoveryHarness(defaults), record = await h.create();
    h.settings.qualitySeparationVersion = 1;
    await assert.rejects(h.recovery.validate(record, h.ctx), /settings.*changed/);
    delete h.settings.qualitySeparationVersion;
    await h.recovery.validate(record, h.ctx);
});

test('new recovery records freeze exact campaign instructions and reject changed text or conflicting inner snapshots', async () => {
    const h = recoveryHarness(selected), record = JSON.parse(JSON.stringify(await h.create()));
    assert.deepEqual(record.campaignLayers, freezeCampaignLayers(h.settings));
    assert.equal(record.campaignLayers.version, 2);
    assert.equal(record.campaignLayers.qualitySeparationVersion, 1);
    assert.ok(record.campaignLayers.qualitySource.text.trim());
    assert.ok(record.campaignLayers.gameProfile.text.trim());
    await h.recovery.validate(record, h.ctx);
    record.checkpoint = { draft: { campaignLayers: structuredClone(record.campaignLayers) } };
    record.checkpoint.draft.campaignLayers.instructions += '\nChanged prompt text.';
    await assert.rejects(h.recovery.validate(record, h.ctx), /Campaign settings or instructions changed/);
    record.checkpoint = null;
    record.campaignLayers.instructions += '\nPrevious instruction revision.';
    await assert.rejects(h.recovery.validate(record, h.ctx), /instruction version/);
});

test('equal campaign selectors cannot hide changed quality or game-profile instructions', async () => {
    for (const source of ['qualitySource', 'gameProfile']) {
        const h = recoveryHarness(defaults), record = JSON.parse(JSON.stringify(await h.create()));
        record.campaignLayers[source].text += '\nEarlier instruction revision.';
        const original = JSON.stringify(record);
        await assert.rejects(h.recovery.validate(record, h.ctx), /Campaign settings or instructions changed/);
        await assert.rejects(runPrivateTurn({ baseline, context: [], campaignLayers: freezeCampaignLayers(defaults),
            checkpoint: { version: 4, draft: { baseline, campaignLayers: record.campaignLayers } },
            request: () => assert.fail('An old quality/profile source must not call the provider'),
        }), /instruction version/);
        assert.equal(JSON.stringify(record), original);
    }
});

test('unsupported frozen instruction versions reject before recovery or any provider call', async () => {
    const h = recoveryHarness(selected), record = await h.create();
    record.campaignLayers.version = 99;
    const original = JSON.stringify(record);
    await assert.rejects(h.recovery.validate(record, h.ctx), /unsupported.*version/i);
    assert.equal(JSON.stringify(record), original, 'A rejected resume must retain its checkpoint evidence.');
    await assert.rejects(runPrivateTurn({ baseline, context: [], campaignLayers: freezeCampaignLayers(selected),
        checkpoint: { version: 4, draft: { baseline, campaignLayers: record.campaignLayers } },
        request: () => assert.fail('No provider request for an incompatible instruction version'),
    }), /unsupported.*version/i);
    await assert.rejects(runPrivateTurn({ baseline, context: [], campaignLayers: record.campaignLayers,
        request: () => assert.fail('No first provider request for an unsupported fresh instruction version'),
    }), /unsupported.*version/i);
});

test('each Heavy audit gets only its frozen current-aspect criteria without additional model requests', async () => {
    const snapshot = freezeCampaignLayers(selected), before = structuredClone(snapshot), seen = [];
    let saved;
    const result = await runPrivateTurn({ baseline, context: [{ role: 'user', content: 'Wait.' }], campaignLayers: snapshot,
        saveCheckpoint: async state => { saved = structuredClone(state); }, request: async messages => {
            const p = payload(messages);
            if (p.phase === 'simulate') {
                // Caller-side changes after start must not alter this turn.
                snapshot.instructions = 'Mutated caller value';
                return { text: 'You wait.' };
            }
            seen.push(p.audit.stage);
            const criteria = getCampaignReviewCriteria(before, p.audit.stage);
            assert.ok(criteria.trim());
            assert.ok(messages[0].content.endsWith(criteria));
            assert.match(messages[0].content, /DETECT AND RECORD/);
            return pass(p);
        } });
    assert.deepEqual(seen, ['time', 'continuity', 'reach', 'narration']);
    assert.equal(result.stats.requests, 5);
    assert.equal(result.stats.reviews, 4);
    assert.deepEqual(saved.draft.campaignLayers, before);
    assert.deepEqual(result.draft.campaignLayers, before);
});

test('Light gets combined frozen criteria in its existing detection/correction pair', async () => {
    const snapshot = freezeCampaignLayers(selected), phases = [];
    const criteria = getCampaignReviewCriteria(snapshot, 'light');
    assert.ok(criteria.trim());
    const result = await runPrivateTurn({ baseline, context: [], campaignLayers: snapshot, reviewMode: 'light', request: async messages => {
        const p = payload(messages); phases.push(p.phase);
        if (p.phase === 'simulate') return { text: 'You wait.' };
        assert.ok(messages[0].content.endsWith(criteria));
        if (p.phase === 'review') return { text: JSON.stringify(report(p)) };
        return { text: JSON.stringify({ revision: p.head_revision, candidate_id: p.candidate_id, candidate: 'You wait.', issue_resolutions: [] }) };
    } });
    assert.deepEqual(phases, ['simulate', 'review', 'repair']);
    assert.equal(result.stats.requests, 3);
    assert.equal(result.stats.reviews, 1);
    assert.equal(result.stats.repairs, 1);
});

test('inherit defaults leave audit protocol byte-identical, including no criteria heading', () => {
    const snapshot = freezeCampaignLayers(defaults);
    for (const stage of ['time', 'continuity', 'reach', 'narration', 'light']) {
        assert.equal(reviewProtocol(stage, 'detect', snapshot), reviewProtocol(stage));
        assert.equal(getCampaignReviewCriteria(snapshot, stage), '');
    }
});

test('transaction resumes exact frozen text but never reinterprets a pre-separation transaction', async () => {
    const snapshot = freezeCampaignLayers(selected);
    let checkpoint, outage = true, first = true, frozen;
    const options = { baseline, context: [], campaignLayers: snapshot,
        saveCheckpoint: async state => { checkpoint = structuredClone(state); },
        request: async messages => {
            const p = payload(messages);
            if (p.phase === 'simulate') return { text: 'You wait.' };
            if (outage) { outage = false; frozen = structuredClone(messages); throw new Error('429 fixture'); }
            return pass(p);
        } };
    await assert.rejects(runPrivateTurn(options), error => {
        assert.deepEqual(error.privateTurn.campaignLayers, snapshot);
        return /429/.test(error.message);
    });
    const changed = structuredClone(snapshot); changed.reviewCriteria.time += '\nChanged reviewer text.';
    await assert.rejects(runPrivateTurn({ ...options, checkpoint, campaignLayers: changed }), /instruction version/);
    const result = await runPrivateTurn({ ...options, checkpoint, request: async messages => {
        if (first) { first = false; assert.deepEqual(messages, frozen); }
        return pass(payload(messages));
    } });
    assert.equal(result.stats.requests, 5);
    for (const previousVersion of [null, 1]) {
        const legacy = structuredClone(checkpoint);
        if (previousVersion === null) delete legacy.draft.campaignLayers;
        else legacy.draft.campaignLayers.version = previousVersion;
        const before = JSON.stringify(legacy);
        for (const campaignLayers of [freezeCampaignLayers(defaults), snapshot]) {
            await assert.rejects(runPrivateTurn({ ...options, checkpoint: legacy, campaignLayers,
                request: () => assert.fail('An incompatible prompt snapshot must not call the provider'),
                saveCheckpoint: () => assert.fail('An incompatible prompt snapshot must not overwrite the checkpoint'),
            }), /predates the separated.*draft is preserved/);
        }
        assert.equal(JSON.stringify(legacy), before);
    }
});
