// These tests exercise orchestration, evidence routing and recovery, not LLM judgement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DraftTurn, runPrivateTurn } from '../transaction.js';
import { REVIEW_STAGES, affectedReviewStages } from '../review.js';
import { citations, payload, report } from './review-fixtures.mjs';

const stages = REVIEW_STAGES.map(s => s.id);
const board = `[MISC #world_clock]
Time: Day 1, 01:00:00
[MISC #simulation_processes]
{"version":1,"through":"Day 1, 01:00:00","processes":[]}
[ENTITIES #guard]
Location: hall. Waiting at door.
[SCENE #hall]
Guard waits at door. Desk contains a letter.
[LORE #history]
Founded in year 100.`;
// Evidence independent of wording in the candidate, to distinguish a text edit
// from a change to the material relied on by an earlier review.
function response(p, bad = false) {
    const r = report(p, bad ? 'repair' : 'pass');
    for (const c of r.checks) if (c.evidence[0]?.source === 'candidate') {
        c.evidence = citations(p, [{ source: 'current', block_id: 'misc #world_clock' }]);
    }
    return { text: JSON.stringify(r) };
}
const update = (p, content) => ({ calls: [{ name: 'UpdateBlackboard', arguments: { base_revision: p.head_revision, content } }] });
const label = p => `${p.phase === 'review' ? p.review_kind : p.phase}:${p.audit?.stage ?? p.stage ?? ''}`;

for (const mode of ['diff', 'full']) for (const focus of stages) test(`${mode}: ${focus} detection -> stage repair -> independent verification -> next aspect`, async () => {
    let found = false, checkpoint;
    const sequence = [], progress = [];
    const result = await runPrivateTurn({ baseline: board, mode, context: [{ role: 'system', content: 'Campaign rules.' }],
        saveCheckpoint: async s => { checkpoint = s; }, onProgress: phase => progress.push(phase),
        invoke: () => assert.fail('Repair must not invoke external tools'), request: async (messages, allowed) => {
            const p = payload(messages); sequence.push(label(p));
            if (p.phase === 'simulate') return { text: 'Original.' };
            assert.equal(messages.length, 2, 'Repair and audit use an independent assignment');
            assert.deepEqual(p.reference_context, [{ role: 'system', content: 'Campaign rules.' }]);
            if (p.phase === 'repair') {
                assert.equal(p.stage, focus); assert.deepEqual(allowed, ['UpdateBlackboard']);
                assert.equal(p.issues_to_fix.length, 1); assert.equal(p.issues_to_fix[0].stage, focus);
                assert.match(messages[0].content, /repair component/);
                return { text: 'Corrected.' };
            }
            assert.deepEqual(allowed, []);
            if (p.review_kind === 'verify') {
                assert.equal(p.audit.stage, focus); assert.equal(p.issue_ledger.length, 1);
                assert.equal(p.repair_before.candidate, 'Original.'); assert.equal(p.repair_before.board, board);
                assert.deepEqual(p.repair_changes, []);
                assert.match(messages[0].content, /VERIFY RECORDED REPAIRS/);
            } else assert.match(messages[0].content, /DETECT AND RECORD/);
            if (p.audit.stage === focus && !found) { found = true; return response(p, true); }
            return response(p);
        } });
    const expected = ['simulate:'];
    for (const stage of stages) {
        expected.push(`detect:${stage}`);
        if (stage === focus) expected.push(`repair:${stage}`, `verify:${stage}`);
    }
    assert.deepEqual(sequence, expected);
    assert.equal(result.stats.reviews, 5); assert.equal(result.stats.repairs, 1);
    assert.deepEqual(Object.keys(result.stageFindings), stages);
    assert.equal(result.stageFindings[focus][0].status, 'resolved');
    assert.equal(checkpoint.version, 4); assert.deepEqual(checkpoint.stageFindings, result.stageFindings);
    assert.ok(progress.includes('verify')); assert.ok(progress.includes('detect'));
    for (const stage of stages.filter(s => s !== focus)) assert.deepEqual(result.stageFindings[stage], []);
});

test('late actor/scene repair verifies reach first, then invalidates time and continuity, preserving no stale approval', async () => {
    let found = false, changed = false;
    const sequence = [];
    const result = await runPrivateTurn({ baseline: board, context: [], request: async messages => {
        const p = payload(messages); sequence.push(label(p));
        if (p.phase === 'simulate') return { text: 'Guard by desk.' };
        if (p.phase === 'repair') {
            if (!changed) { changed = true; return update(p, '[ENTITIES #guard]\nLocation: hall. Waiting at desk.\n[SCENE #hall]\nGuard waits at desk. Desk contains a letter.'); }
            return { text: 'Guard by desk.' };
        }
        if (p.review_kind === 'verify') assert.equal(p.repair_changes.length, 2);
        if (p.audit.stage === 'reach' && !found) { found = true; return response(p, true); }
        return response(p);
    } });
    assert.deepEqual(sequence, ['simulate:', 'detect:time', 'detect:continuity', 'detect:reach', 'repair:reach', 'repair:reach',
        'verify:reach', 'detect:time', 'detect:continuity', 'detect:narration']);
    assert.deepEqual(result.invalidationLog[0].stages, ['time', 'continuity']);
    assert.ok(result.review.stages.every(s => s.revision === 1));
});

test('a lore correction revisits cross-record aspects while keeping unrelated time evidence', async () => {
    let found = false, changed = false;
    const sequence = [];
    const result = await runPrivateTurn({ baseline: board, context: [], request: async messages => {
        const p = payload(messages); sequence.push(label(p));
        if (p.phase === 'simulate') return { text: 'Year 101.' };
        if (p.phase === 'repair') {
            if (!changed) { changed = true; return update(p, '[LORE #history]\nFounded in year 101.'); }
            return { text: 'Year 101.' };
        }
        if (p.audit.stage === 'narration' && !found) { found = true; return response(p, true); }
        return response(p);
    } });
    assert.deepEqual(result.invalidationLog[0].stages, ['continuity', 'reach']);
    assert.equal(sequence.filter(s => s === 'detect:time').length, 1);
    assert.equal(result.review.stages[0].revision, 0, 'Retained report must not pretend to examine a later revision');
    assert.deepEqual(sequence.slice(-3), ['verify:narration', 'detect:continuity', 'detect:reach']);
});

test('routing invalidates evidence on other data and changed candidate quotations', () => {
    const draft = new DraftTurn(board);
    const approvals = [{ stage: 'time', checks: [{ evidence: [{ source: 'current', block_id: 'LORE #history', quote: 'Founded in year 100.' }] }] }];
    assert.deepEqual(affectedReviewStages(approvals, [{ id: 'lore #history' }], 'Same.', draft, []), ['time']);
    approvals[0].checks[0].evidence = [{ source: 'candidate', quote: 'Original.' }];
    assert.deepEqual(affectedReviewStages(approvals, [], 'Corrected.', draft, []), ['time']);
    assert.deepEqual(affectedReviewStages(approvals, [], 'Original. More detail.', draft, []), []);
});

for (const boundary of ['repair', 'verify']) test(`429 at ${boundary} resumes identical request, queues and budget without replaying simulation`, async () => {
    let found = false, outage = true, checkpoint, frozen;
    const options = { baseline: board, context: [], saveCheckpoint: async s => { checkpoint = s; }, request: async messages => {
        const p = payload(messages);
        if (p.phase === 'simulate') return { text: 'Original.' };
        if ((p.phase === boundary || p.review_kind === boundary) && outage) {
            outage = false; frozen = structuredClone(messages); throw new Error('429');
        }
        if (p.phase === 'repair') return { text: 'Fixed.' };
        if (p.audit.stage === 'continuity' && !found) { found = true; return response(p, true); }
        return response(p);
    } };
    await assert.rejects(runPrivateTurn(options), /429/);
    const used = checkpoint.stats.requests;
    assert.equal(checkpoint.stageFindings.continuity[0].status, 'open');
    let first = true;
    const result = await runPrivateTurn({ ...options, checkpoint, request: async messages => {
        if (first) { first = false; assert.deepEqual(messages, frozen); }
        assert.notEqual(payload(messages).phase, 'simulate');
        return options.request(messages);
    } });
    assert.equal(result.stats.requests, 7); assert.ok(used <= 7);
    assert.equal(result.stageFindings.continuity[0].status, 'resolved');
});

test('failed correction returns only to its own repair queue and blocks publication at the existing budget', async () => {
    let checkpoint;
    const sequence = [];
    await assert.rejects(runPrivateTurn({ baseline: board, context: [], saveCheckpoint: async s => { checkpoint = s; }, request: async messages => {
        const p = payload(messages); sequence.push(label(p));
        if (p.phase !== 'review') return { text: 'Still wrong.' };
        return response(p, p.audit.stage === 'reach');
    } }), /Repair limit/);
    assert.deepEqual(sequence, ['simulate:', 'detect:time', 'detect:continuity', 'detect:reach', 'repair:reach', 'verify:reach', 'repair:reach', 'verify:reach']);
    assert.equal(checkpoint.stats.repairs, 2); assert.equal(checkpoint.stageFindings.reach[0].status, 'open');
    assert.ok(!sequence.includes('detect:narration'));
});

test('mechanical failure creates a nonempty stage queue even when model reports pass', async () => {
    let queued = false;
    const invalid = board.replace('"through":"Day 1, 01:00:00"', '"through":"Day 1, 01:00:01"');
    await assert.rejects(runPrivateTurn({ baseline: invalid, context: [], request: async messages => {
        const p = payload(messages);
        if (p.phase === 'repair') { queued = true; assert.equal(p.issues_to_fix[0].origin, 'mechanical'); return { text: 'Unfixed.' }; }
        return p.phase === 'simulate' ? { text: 'Original.' } : response(p);
    } }), /Repair limit/);
    assert.ok(queued);
});

test('verification can expose a second defect; next repair receives only the open finding', async () => {
    let detections = 0, fixes = 0;
    const result = await runPrivateTurn({ baseline: board, context: [], request: async messages => {
        const p = payload(messages);
        if (p.phase === 'simulate') return { text: 'Original.' };
        if (p.phase === 'repair') {
            assert.equal(p.issues_to_fix.length, 1);
            assert.equal(p.issues_to_fix[0].id, `issue-${++fixes}`);
            return { text: `Fixed ${fixes}.` };
        }
        if (p.audit.stage !== 'continuity') return response(p);
        if (!detections++) return response(p, true);
        if (detections === 2) {
            const r = JSON.parse(response(p).text);
            r.verdict = 'repair';
            r.issues = [{ target: p.audit.targets[1].id, problem: 'Second linked copy still differs.', repair: 'Reconcile the linked copy.' }];
            assert.equal(r.issue_resolutions[0].status, 'resolved');
            return { text: JSON.stringify(r) };
        }
        assert.equal(p.issue_ledger.length, 2, 'Recheck earlier closure within the repaired aspect as well');
        return response(p);
    } });
    assert.equal(result.stats.repairs, 2);
    assert.deepEqual(result.stageFindings.continuity.map(i => i.status), ['resolved', 'resolved']);
});

test('a later state correction reopens an earlier resolved finding and requires an explicit new verdict', async () => {
    const raised = new Set(); let changed = false, firstTimeVerified = false, revisited = false;
    const result = await runPrivateTurn({ baseline: board, context: [], request: async messages => {
        const p = payload(messages);
        if (p.phase === 'simulate') return { text: 'Original.' };
        if (p.phase === 'repair') {
            if (p.stage === 'reach' && !changed) { changed = true; return update(p, '[ENTITIES #guard]\nLocation: hall. Waiting beside desk.'); }
            return { text: 'Corrected.' };
        }
        if (['time', 'reach'].includes(p.audit.stage) && !raised.has(p.audit.stage)) {
            raised.add(p.audit.stage); return response(p, true);
        }
        if (p.audit.stage === 'time' && p.review_kind === 'verify') firstTimeVerified = true;
        if (p.audit.stage === 'time' && p.review_kind === 'detect' && changed) {
            revisited = true; assert.ok(firstTimeVerified);
            assert.equal(p.issue_ledger[0].status, 'unconfirmed');
            assert.equal(p.issue_ledger[0].observed_candidate_text, 'Original.');
            assert.ok(p.issue_ledger[0].first_observation.evidence.length);
        }
        return response(p);
    } });
    assert.ok(revisited);
    assert.equal(result.issueLedger[0].verified_revision, 1);
    assert.equal(result.issueLedger[0].status, 'resolved');
});

for (const phase of ['review', 'repair', 'done']) test(`v3 ${phase} checkpoint migrates without losing findings or repeating tools`, async () => {
    let checkpoint, triggered = false;
    const options = { baseline: board, context: [], saveCheckpoint: async s => {
        checkpoint = s;
        if (phase === 'done' && s.phase === 'done' && !triggered) { triggered = true; throw new Error('Saved'); }
    }, request: async messages => {
        const p = payload(messages);
        if (p.phase === 'simulate') return { text: 'Original.' };
        if (phase === 'review' || p.phase === 'repair') throw new Error('Saved');
        return response(p, phase === 'repair' && p.audit.stage === 'time');
    } };
    await assert.rejects(runPrivateTurn(options), /Saved/);
    checkpoint.version = 3;
    delete checkpoint.reviewKind; delete checkpoint.repairStart;
    delete checkpoint.invalidationLog; delete checkpoint.stageFindings;
    const frozen = structuredClone(checkpoint.pending?.messages);
    let first = true;
    const result = await runPrivateTurn({ baseline: board, checkpoint, invoke: () => assert.fail('No replay'), request: async messages => {
        if (first && frozen) assert.deepEqual(messages, frozen);
        first = false;
        const p = payload(messages);
        assert.notEqual(p.phase, 'simulate');
        return p.phase === 'repair' ? { text: 'Fixed.' } : response(p);
    } });
    assert.equal(result.review.stages.length, 4);
    if (phase === 'repair') assert.equal(result.issueLedger[0].status, 'resolved');
});
