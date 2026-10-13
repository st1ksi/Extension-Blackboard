import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DraftTurn, runPrivateTurn } from '../transaction.js';
import { REVIEW_STAGES, makeAudit, validateAudit } from '../review.js';
import { pass, repair, report, payload } from './review-fixtures.mjs';

const board = `[MISC #world_clock]
- Time: Day 1, 00:32:12
[MISC #simulation_processes]
{"version":1,"through":"Day 1, 00:32:12","processes":[]}
[ENTITIES #hero]
HP 20. In SCENE #study. Can teleport 30 ft.
[ENTITIES #butler]
Preparing tea in kitchen; arrives at 00:38:00.
[ENTITIES #body]
Dead. Missing finger. Ink-stained quill in hand.
[SCENE #study]
East door leads to SCENE #gallery. Unlocked drawer holds letter.
[NARRATIVE #plan]
Butler will bring tea; patrol returns at 00:34:00.`;
const stages = REVIEW_STAGES.map(s => s.id);
const update = (revision, content) => ({ name: 'UpdateBlackboard', arguments: { base_revision: revision, content } });

test('attention index finds unchanged unscheduled actors, erased clues and missing reachable scenes', () => {
    const d = new DraftTurn(board);
    d.update({ base_revision: 0, content: '[ENTITIES #body]\nDead.' });
    const time = makeAudit(d, 'time', 1);
    assert.ok(time.targets.some(t => t.id === 'actor:entities #butler'));
    assert.ok(time.targets.some(t => t.id === 'actor:entities #body'));
    const continuity = makeAudit(d, 'continuity', 1);
    assert.match(continuity.removed_line_cues[0].sample.join(), /Missing finger.*quill/);
    const reach = makeAudit(d, 'reach', 1);
    assert.ok(reach.targets.some(t => t.id === 'scene:scene #study'));
    assert.deepEqual(reach.references.find(r => r.to === 'scene #gallery'), { from: 'scene #study', to: 'scene #gallery', exists: false });
});

test('facts introduced and erased inside one turn remain explicit review targets', () => {
    const d = new DraftTurn(board);
    d.update({ base_revision: 0, content: '[ENTITIES #visitor]\nCarries sealed letter. Waiting at door.' });
    d.update({ base_revision: 1, action: 'delete', block_id: 'ENTITIES #visitor' });
    assert.ok(makeAudit(d, 'time', 1).targets.some(t => t.block_id === 'entities #visitor'));
    const audit = makeAudit(d, 'continuity', 1);
    assert.ok(audit.targets.some(t => t.block_id === 'entities #visitor'));
    const cue = audit.removed_line_cues.find(c => c.block_id === 'entities #visitor');
    assert.equal(cue.base_revision, 1); assert.equal(cue.revision, 2);
    assert.match(cue.sample.join(), /sealed letter/);
});

test('audits validate revision/candidate identity, target coverage and literal source evidence', () => {
    const d = new DraftTurn(board), audit = makeAudit(d, 'time', 1);
    const p = { audit, ...d.packet(), current_board: d.head, candidate_id: 1, candidate: 'Wait.' };
    const good = report(p);
    assert.equal(validateAudit(good, audit, d, 'Wait.', []), good);
    for (const mutate of [
        r => { r.stage = 'narration'; }, r => { r.revision++; }, r => { r.candidate_id++; },
        r => { r.checks.pop(); }, r => { r.checks.push(r.checks[0]); },
        r => { r.checks[0].evidence = []; },
        r => { r.checks[0].evidence = [{ source: 'current', block_id: 'ENTITIES #butler', quote: 'Arrived at door' }]; },
        r => { r.checks[0].evidence[0].source = 'revision:99'; },
        r => { r.verdict = 'repair'; },
    ]) {
        const bad = structuredClone(good); mutate(bad);
        assert.throws(() => validateAudit(bad, audit, d, 'Wait.', []));
    }
    for (const source of ['current', 'baseline', 'revision:0']) {
        const valid = structuredClone(good);
        valid.checks[0].evidence = [{ source, block_id: 'ENTITIES #butler', quote: 'Preparing  tea\nin kitchen;' }];
        assert.doesNotThrow(() => validateAudit(valid, audit, d, 'Wait.', []));
    }
});

for (const mode of ['diff', 'full']) test(`${mode}: four distinct assignments, full current board and versioned original evidence`, async () => {
    const seen = [], protocols = []; let simulated = false;
    const r = await runPrivateTurn({ baseline: board, mode, context: [], request: async (messages, allowed) => {
        const p = payload(messages);
        if (p.phase !== 'review') {
            if (!simulated) { simulated = true; return { calls: [update(0, '[ENTITIES #hero]\nHP 19. In SCENE #study. Can teleport 30 ft.')] }; }
            return { text: 'You wait.' };
        }
        seen.push(p.audit.stage); protocols.push(messages.at(-2).content);
        assert.deepEqual(allowed, []);
        assert.match(p.current_board, /HP 19/);
        assert.equal(p.versions[0].text, board);
        assert.equal(p.format, mode);
        assert.equal(p.versions[1].text !== undefined, mode === 'full');
        return pass(p);
    } });
    assert.deepEqual(seen, stages); assert.equal(new Set(protocols).size, 4);
    assert.equal(r.review.stages.length, 4); assert.equal(r.auditLog.length, 4);
    assert.equal(r.candidateVersions.length, 1);
});

for (const textOnly of [false, true]) test(`verify current repair before revisiting prior passes whose evidence changed (${textOnly})`, async () => {
    let needsRepair = true, wrote = false;
    const seen = [];
    const r = await runPrivateTurn({ baseline: board, context: [], request: async (messages, allowed) => {
        const p = payload(messages);
        if (p.phase === 'simulate') return { text: 'Original candidate.' };
        if (p.phase === 'repair') {
            assert.deepEqual(allowed, ['UpdateBlackboard']);
            assert.equal(p.feedback.review.stage, 'narration');
            if (!textOnly && !wrote) { wrote = true; return { calls: [update(0, '[ENTITIES #body]\nDead. Missing finger. Ink-stained quill in hand. Status confirmed.')] }; }
            return { text: 'Corrected candidate.' };
        }
        seen.push([p.audit.stage, p.candidate_id]);
        if (p.audit.stage === 'narration' && needsRepair) { needsRepair = false; return repair(p); }
        return pass(p);
    } });
    assert.deepEqual(seen, [...stages.map(s => [s, 1]), ['narration', 2], ...stages.slice(0, 3).map(s => [s, 2])]);
    assert.equal(r.stats.repairs, 1); assert.equal(r.auditLog.length, 8);
    assert.equal(r.review.candidate_id, 2);
    assert.ok(r.review.stages.every(a => a.candidate_id === 2 && a.revision === r.draft.revision));
    assert.equal(r.draft.revision, textOnly ? 0 : 1);
    assert.deepEqual(r.candidateVersions.map(c => c.text), ['Original candidate.', 'Corrected candidate.']);
});

for (const failedStage of stages) test(`429 in ${failedStage} resumes exact request without repeating prior audits`, async () => {
    let checkpoint, fail = true, pending;
    const completed = [];
    const options = { baseline: board, context: [], saveCheckpoint: async s => { checkpoint = structuredClone(s); }, request: async messages => {
        const p = payload(messages);
        if (p.phase === 'simulate') return { text: 'Wait.' };
        if (p.audit.stage === failedStage && fail) { fail = false; pending = structuredClone(messages); throw new Error('429'); }
        if (p.audit.stage === failedStage) assert.deepEqual(messages, pending);
        completed.push(p.audit.stage); return pass(p);
    } };
    await assert.rejects(runPrivateTurn(options), /429/);
    const r = await runPrivateTurn({ ...options, checkpoint });
    assert.deepEqual(completed, stages);
    assert.equal(r.stats.requests, 5); assert.equal(r.auditLog.length, 4);
});

test('received audit survives cancellation without a second API call for it', async () => {
    let checkpoint, cancelled = false;
    const controller = new AbortController(), requested = [];
    const options = { baseline: board, context: [],
        saveCheckpoint: async s => { checkpoint = structuredClone(s); },
        request: async messages => {
            const p = payload(messages);
            if (p.phase === 'simulate') return { text: 'Wait.' };
            requested.push(p.audit.stage);
            if (p.audit.stage === 'continuity' && !cancelled) { cancelled = true; controller.abort(); }
            return pass(p);
        } };
    await assert.rejects(runPrivateTurn({ ...options, signal: controller.signal }));
    assert.ok(checkpoint.answer);
    await runPrivateTurn({ ...options, checkpoint });
    assert.deepEqual(requested, stages);
});

test('malformed audit retries only the report; explicit Resume preserves gameplay and bounded budget', async () => {
    let checkpoint, bad = true;
    const options = { baseline: board, context: [], saveCheckpoint: async s => { checkpoint = structuredClone(s); },
        request: async (messages, allowed) => {
            const p = payload(messages);
            if (p.phase === 'simulate') return { text: 'Wait.' };
            assert.equal(p.phase, 'review'); assert.deepEqual(allowed, []);
            if (bad) return { text: '{}' };
            assert.ok(p.audit.stage !== 'time' || p.format_feedback.error);
            return pass(p);
        } };
    await assert.rejects(runPrivateTurn(options), /invalid report/);
    assert.equal(checkpoint.stats.repairs, 0); assert.equal(checkpoint.auditLog.length, 2);
    bad = false;
    const r = await runPrivateTurn({ ...options, checkpoint });
    assert.equal(r.draft.revision, 0); assert.equal(r.stats.requests, 7);
    assert.equal(r.candidateVersions.length, 1); assert.equal(r.auditLog.length, 6);
});

test('blocked finding preserves diagnostics and cannot invent a new roll on Resume', async () => {
    let checkpoint;
    await assert.rejects(runPrivateTurn({ baseline: board, context: [], saveCheckpoint: async s => { checkpoint = structuredClone(s); },
        invoke: () => assert.fail('No new roll'), request: async messages => {
            const p = payload(messages);
            return p.phase === 'simulate' ? { text: 'Unresolved attack.' } : { text: JSON.stringify(report(p, 'blocked', 'Attack needs an unrolled damage result.')) };
        } }), /new dice roll/);
    assert.equal(checkpoint.auditLog[0].report.verdict, 'blocked');
    await assert.rejects(runPrivateTurn({ baseline: board, checkpoint, request: () => assert.fail('Do not bypass blocker') }), /new dice roll/);
});

test('repeated substantive failures stop after two repairs of the same focus', async () => {
    let checkpoint;
    await assert.rejects(runPrivateTurn({ baseline: board, context: [], saveCheckpoint: async s => { checkpoint = structuredClone(s); },
        request: async messages => { const p = payload(messages); return p.phase === 'review' ? repair(p) : { text: 'Candidate.' }; } }), /Repair limit/);
    assert.equal(checkpoint.stats.repairs, 2); assert.equal(checkpoint.auditLog.length, 3);
    assert.equal(checkpoint.candidateVersions.length, 3);
});

for (const phase of ['simulate', 'review', 'done', 'repair']) test(`v1 ${phase} checkpoints retain work but never reuse legacy broad approval`, async () => {
    const checkpoint = { version: 1, draft: new DraftTurn(board), context: [], phase, step: 0,
        candidate: phase === 'simulate' ? '' : 'Old candidate.', feedback: null, answer: null, pending: null,
        callIndex: 0, failedUpdate: false, inFlightTool: null, review: { verdict: 'pass', checked_blocks: [] }, maxRepairs: 2,
        stats: { requests: 1, reviews: 0, repairs: 0, inputChars: 0, outputChars: 0, started: Date.now() } };
    const requested = [];
    const r = await runPrivateTurn({ baseline: board, checkpoint, request: async messages => {
        const p = payload(messages);
        if (p.phase === 'review') { requested.push(p.audit.stage); return pass(p); }
        return { text: 'Candidate.' };
    } });
    assert.deepEqual(requested, stages); assert.equal(r.review.stages.length, 4);
    assert.equal(r.draft.baseline, board);
});

test('mechanical contradictions cannot be approved by four positive model reports', async () => {
    const invalid = board.replace('"through":"Day 1, 00:32:12"', '"through":"Day 1, 00:32:13"');
    await assert.rejects(runPrivateTurn({ baseline: invalid, context: [], request: async messages => {
        const p = payload(messages); return p.phase === 'review' ? pass(p) : { text: 'Unchanged.' };
    } }), /Repair limit/);
});

test('total repair budget survives resets between different focuses', async () => {
    let checkpoint;
    const failures = ['time', 'time', 'continuity', 'continuity', 'reach'];
    let next = 0;
    await assert.rejects(runPrivateTurn({ baseline: board, context: [], saveCheckpoint: async s => { checkpoint = structuredClone(s); },
        request: async messages => {
            const p = payload(messages);
            if (p.phase !== 'review') return { text: 'Candidate.' };
            if (p.audit.stage === failures[next]) { next++; return repair(p); }
            return pass(p);
        } }), /Repair limit/);
    assert.equal(checkpoint.stats.repairs, 4); assert.equal(next, 5);
    assert.equal(checkpoint.draft.versions.length, 1);
});

test('v1 pending simulation is replayed exactly, not rebuilt by the audit migration', async () => {
    let checkpoint;
    await assert.rejects(runPrivateTurn({ baseline: board, context: [], saveCheckpoint: async s => { checkpoint = structuredClone(s); },
        request: async () => { throw new Error('429'); } }), /429/);
    checkpoint.version = 1;
    const frozen = structuredClone(checkpoint.pending.messages);
    let first = true;
    const r = await runPrivateTurn({ baseline: board, checkpoint, request: async messages => {
        if (first) { first = false; assert.deepEqual(messages, frozen); return { text: 'Wait.' }; }
        return pass(payload(messages));
    } });
    assert.equal(r.stats.requests, 5); assert.equal(r.auditLog.length, 4);
});
