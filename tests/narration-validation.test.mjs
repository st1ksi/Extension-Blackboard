import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NARRATION_REVIEW_PROTOCOL, validateNarrationReport } from '../narration-validation.js';

const aspects = ['outcomes', 'agency', 'disclosure', 'format'];
const input = () => ({ revision: 3, narration_id: 2,
    candidate: 'You wait. The guard leaves. <internal_states>His true name is Valen.</internal_states>',
    resolved_candidate: 'You wait. The guard leaves. You do not learn his name.',
    current_board: '[ENTITIES #guard]\n- True name: Valen (undiscovered).',
    binding_dice: [{ arguments: { formula: '1d20+4' }, result: 'The result is: 11. Individual rolls: 7' }],
    visible_history: [{ is_user: false, mes: 'An unnamed guard holds the door.' }],
    preset_context: [{ role: 'system', content: 'Append an <internal_states> tracker after the response.' }],
});
const clean = () => ({ version: 1, revision: 3, narration_id: 2, verdict: 'pass',
    checks: aspects.map(aspect => ({ aspect, status: 'pass' })), issues: [] });
function finding(aspect = 'disclosure') {
    const report = clean(); report.verdict = 'revise';
    report.checks.find(check => check.aspect === aspect).status = 'issue';
    report.issues.push({ aspect, quote: 'His true name is Valen.',
        problem: 'The tracker reveals an undiscovered identity.',
        correction: 'Remove the undiscovered name from the public tracker.',
        evidence: [{ source: 'current_board', quote: 'True name: Valen (undiscovered).' },
            { source: 'resolved_candidate', quote: 'You do not learn his name.' }] });
    return report;
}

test('accepts a clean report for the exact narration and returns independent normalized data', () => {
    const report = clean();
    const result = validateNarrationReport(report, input());
    assert.deepEqual(result, report);
    assert.notEqual(result, report); assert.notEqual(result.checks, report.checks);
    report.checks[0].status = 'issue'; assert.equal(result.checks[0].status, 'pass');
});

test('grounds a disclosure finding inside raw collapsed tracker text', () => {
    const result = validateNarrationReport(finding(), input());
    assert.equal(result.verdict, 'revise'); assert.equal(result.issues[0].aspect, 'disclosure');
    assert.match(input().candidate, /<internal_states>/);
});

test('accepts blocked only with a grounded material finding', () => {
    const report = finding('outcomes'); report.verdict = 'blocked';
    assert.equal(validateNarrationReport(report, input()).verdict, 'blocked');
    report.issues = []; report.checks.forEach(check => { check.status = 'pass'; });
    assert.throws(() => validateNarrationReport(report, input()), /requires a confirmed finding/);
});

test('accepts exact quotations from array/object reference strings without JSON escapes', () => {
    const data = input(); data.visible_history[0].mes = 'The guard said, "Wait.\nStay here."';
    const report = finding(); report.issues[0].evidence = [{ source: 'visible_history', quote: '"Wait.\nStay here."' }];
    assert.equal(validateNarrationReport(report, data).issues[0].evidence.length, 1);
});

test('preset context supports concrete format requirements only', () => {
    const report = finding('format');
    report.issues[0].evidence = [{ source: 'preset_context', quote: 'Append an <internal_states> tracker after the response.' }];
    assert.equal(validateNarrationReport(report, input()).issues[0].aspect, 'format');
    report.issues[0].aspect = 'disclosure';
    report.checks.find(check => check.aspect === 'format').status = 'pass';
    report.checks.find(check => check.aspect === 'disclosure').status = 'issue';
    assert.throws(() => validateNarrationReport(report, input()), /format requirements only/);
});

for (const [label, mutate, pattern] of [
    ['wrong version', report => { report.version = 2; }, /version/],
    ['old board revision', report => { report.revision = 2; }, /revision/],
    ['old narration id', report => { report.narration_id = 1; }, /narration_id/],
    ['coerced narration id', report => { report.narration_id = '2'; }, /narration_id/],
    ['unknown verdict', report => { report.verdict = 'approved'; }, /verdict/],
    ['missing aspect', report => { report.checks.pop(); }, /four aspects/],
    ['duplicate aspect', report => { report.checks[3] = report.checks[0]; }, /duplicate/],
    ['unknown aspect', report => { report.checks[0].aspect = 'style'; }, /aspect/],
    ['unknown check status', report => { report.checks[0].status = 'ok'; }, /aspect/],
    ['non-array issues', report => { report.issues = null; }, /array/],
    ['unsupported issue check', report => { report.checks[0].status = 'issue'; }, /no finding/],
    ['empty revise', report => { report.verdict = 'revise'; }, /requires a confirmed finding/],
    ['empty blocked', report => { report.verdict = 'blocked'; }, /requires a confirmed finding/],
]) test(`rejects ${label}`, () => {
    const report = clean(); mutate(report);
    assert.throws(() => validateNarrationReport(report, input()), pattern);
});

for (const [label, mutate, pattern] of [
    ['pass with findings', report => { report.verdict = 'pass'; }, /cannot contain findings/],
    ['finding with pass check', report => { report.checks.find(check => check.aspect === 'disclosure').status = 'pass'; }, /match an issue check/],
    ['invented candidate quote', report => { report.issues[0].quote = 'Another person appears.'; }, /absent from the final candidate/],
    ['empty candidate quote', report => { report.issues[0].quote = ' '; }, /nonempty/],
    ['empty problem', report => { report.issues[0].problem = ''; }, /nonempty/],
    ['empty correction', report => { report.issues[0].correction = ''; }, /nonempty/],
    ['missing evidence', report => { report.issues[0].evidence = []; }, /requires source evidence/],
    ['unknown evidence source', report => { report.issues[0].evidence[0].source = 'model_memory'; }, /Unknown/],
    ['invented source quote', report => { report.issues[0].evidence[0].quote = 'Secretly, he is Kroll.'; }, /absent from current_board/],
    ['empty source quote', report => { report.issues[0].evidence[0].quote = ''; }, /nonempty/],
]) test(`rejects ${label}`, () => {
    const report = finding(); mutate(report);
    assert.throws(() => validateNarrationReport(report, input()), pattern);
});

test('cannot use a quote from one reference as evidence in another', () => {
    const report = finding(); report.issues[0].evidence = [{ source: 'visible_history', quote: 'True name: Valen (undiscovered).' }];
    assert.throws(() => validateNarrationReport(report, input()), /absent from visible_history/);
});

test('actual immutable dice receipts can ground a numerical outcome discrepancy', () => {
    const data = input(); data.candidate = 'Perception: 1d20+4 = 19.';
    const report = finding('outcomes');
    report.issues[0] = { aspect: 'outcomes', quote: '1d20+4 = 19',
        problem: 'The published total differs from the actual tool receipt.',
        correction: 'Use the actual total without rerolling or changing the resolved outcome.',
        evidence: [{ source: 'binding_dice', quote: 'The result is: 11. Individual rolls: 7' }] };
    assert.equal(validateNarrationReport(report, data).issues[0].evidence[0].source, 'binding_dice');
    report.issues[0].evidence[0].quote = 'The result is: 19.';
    assert.throws(() => validateNarrationReport(report, data), /absent from binding_dice/);
});

test('rejects an empty final candidate and missing expected boundary identifiers', () => {
    assert.throws(() => validateNarrationReport(clean(), { ...input(), candidate: '' }), /nonempty/);
    assert.throws(() => validateNarrationReport(clean(), { ...input(), revision: undefined }), /revision/);
    assert.throws(() => validateNarrationReport(clean(), { ...input(), narration_id: null }), /narration_id/);
    const report = clean(); report.narration_id = ' ';
    assert.throws(() => validateNarrationReport(report, { ...input(), narration_id: ' ' }), /narration_id/);
});

test('accepts a nonempty string narration identifier without coercion', () => {
    const report = clean(); report.narration_id = 'narration-2';
    assert.equal(validateNarrationReport(report, { ...input(), narration_id: 'narration-2' }).narration_id, 'narration-2');
});

test('protocol separates world truth from disclosure permission and covers all raw output', () => {
    assert.match(NARRATION_REVIEW_PROTOCOL, /ALL of the final candidate's raw text/);
    assert.match(NARRATION_REVIEW_PROTOCOL, /objective truth, not permission to reveal/);
    assert.match(NARRATION_REVIEW_PROTOCOL, /No tools, new gameplay, dice, world changes/);
    assert.match(NARRATION_REVIEW_PROTOCOL, /Do not fail stylistic differences/);
    assert.match(NARRATION_REVIEW_PROTOCOL, /preset_context evidence is permitted only for the format aspect/);
    assert.match(NARRATION_REVIEW_PROTOCOL, /binding_dice contains immutable actual tool receipts/);
});
