import { pass } from './review-fixtures.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diceResult, normalizeDiceArguments } from '../dice.js';
import { runPrivateTurn, DraftTurn } from '../transaction.js';
import { publicJournal, renderJournal } from '../tool-journal.js';

const board = '[MISC #world_clock]\nTime: Day 1, 01:00:00\n[MISC #simulation_processes]\n{"version":1,"through":"Day 1, 01:00:00","processes":[]}';
const empty = 'Hero rolls a 1d20 + 5. The result is: . Individual rolls: ';
const success = 'Hero rolls a 1d20+5. The result is: 17. Individual rolls: 12';
const roll = (formula = '1d20 + 5') => ({ name: 'RollTheDice', arguments: { who: 'Hero', formula } });
const payload = messages => JSON.parse(messages.at(-1).content.split('\n').slice(1).join('\n'));

test('cosmetic whitespace and minus normalize without mutating requested arguments', () => {
    for (const [input, expected] of [['1d20 + 5', '1d20+5'], ['2d20kh1 + 5', '2d20kh1+5'], [' 2d20kl1\u00a0− 2 ', '2d20kl1-2'], ['d20', 'd20']]) {
        const args = { who: 'Secret actor', formula: input };
        assert.deepEqual(normalizeDiceArguments(args), { ...args, formula: expected });
        assert.equal(args.formula, input);
    }
    for (const args of [{}, null, { formula: '' }, { formula: 20 }, { formula: '1 2d6' }]) assert.throws(() => normalizeDiceArguments(args));
});

test('native and structured dice results distinguish real zero, explicit rejection and uncertainty', () => {
    assert.deepEqual(diceResult(success), { status: 'success', total: '17', rolls: ['12'] });
    assert.deepEqual(diceResult('The result or a 1d4-1 roll is: 0. Individual rolls: 1'), { status: 'success', total: '0', rolls: ['1'] });
    assert.deepEqual(diceResult(JSON.stringify({ total: -2, rolls: [1, 2] })), { status: 'success', total: '-2', rolls: ['1', '2'] });
    assert.equal(diceResult(empty).status, 'empty');
    assert.equal(diceResult({ total: '', rolls: [] }).status, 'empty');
    for (const value of [null, '', '17', 'Error', { total: null, rolls: [] }, { total: '', rolls: [12] }, { total: 17, rolls: [] }, { total: NaN, rolls: [12] }]) {
        assert.equal(diceResult(value).status, 'unknown');
    }
});

test('private cycle invokes normalized formula once and preserves the raw requested arguments', async () => {
    let step = 0, invoked = 0;
    const result = await runPrivateTurn({ baseline: board, context: [],
        invoke: async (name, args) => { invoked++; assert.equal(args.formula, '1d20+5'); return success; },
        request: async messages => { const p = payload(messages); return p.phase === 'review' ? pass(p) : step++ ? { text: 'Candidate' } : { calls: [roll()] }; },
    });
    assert.equal(invoked, 1);
    assert.equal(result.draft.rolls[0].arguments.formula, '1d20+5');
    assert.equal(result.draft.rolls[0].requested_arguments.formula, '1d20 + 5');
    assert.equal(result.draft.rolls[0].result, success);
});

test('empty dice return defers dependent edits and is corrected without recording a fake roll', async () => {
    let step = 0, invoked = 0;
    const result = await runPrivateTurn({ baseline: board, context: [],
        invoke: async () => ++invoked === 1 ? empty : success,
        request: async messages => {
            const p = payload(messages);
            if (p.phase === 'review') return pass(p);
            if (!step++) return { calls: [roll('unsupported'), { name: 'UpdateBlackboard', arguments: { base_revision: 0, content: '[MISC #bad]\nMust not be saved' } }] };
            if (step === 2) {
                assert.equal(p.rolls.length, 0);
                assert.equal(p.receipts[0].result.code, 'DICE_NO_RESULT');
                assert.match(p.receipts[1].result.message, /dependent tools deferred/);
                return { calls: [roll()] };
            }
            return { text: 'Candidate' };
        },
    });
    assert.equal(invoked, 2);
    assert.equal(result.draft.rolls.length, 1);
    assert.equal(result.draft.head, board);
    const journal = publicJournal(result.draft.rolls, { status: 'not_requested' }, result.draft.receipts);
    assert.equal(journal.diceErrors, 1);
    assert.equal(journal.rolls[0].total, '17');
    assert.match(renderJournal(journal), /do not count as rolls/);
});

test('missing formula cannot silently fall back to d6 or execute dependent tools', async () => {
    let step = 0;
    const result = await runPrivateTurn({ baseline: board, context: [], invoke: () => assert.fail('No valid dice arguments'),
        request: async messages => {
            const p = payload(messages);
            if (p.phase === 'review') return pass(p);
            return step++ ? { text: 'No action resolved.' } : { calls: [{ name: 'RollTheDice', arguments: {} }, roll()] };
        },
    });
    assert.equal(result.draft.rolls.length, 0);
    assert.equal(result.draft.receipts.length, 2);
});

test('uncertain result is saved and cannot be automatically rolled again after resume', async () => {
    let checkpoint, invoked = 0;
    const options = { baseline: board, context: [], saveCheckpoint: async value => { checkpoint = structuredClone(value); },
        invoke: async () => { invoked++; return 'Dice may have rolled, result unavailable'; }, request: async () => ({ calls: [roll()] }) };
    await assert.rejects(runPrivateTurn(options), /unrecognized result/);
    assert.equal(checkpoint.inFlightTool.result, 'Dice may have rolled, result unavailable');
    assert.equal(checkpoint.draft.rolls.length, 0);
    await assert.rejects(runPrivateTurn({ ...options, checkpoint }), /uncertain/);
    assert.equal(invoked, 1);
});

async function legacyCheckpoint({ changed = false } = {}) {
    let saved;
    await assert.rejects(runPrivateTurn({ baseline: board, context: [{ role: 'user', content: 'Original attempt' }],
        request: async () => { throw new Error('stop fixture'); }, invoke: () => assert.fail('fixture'),
        saveCheckpoint: async value => { saved = structuredClone(value); },
    }), /stop fixture/);
    saved.draft.rolls = [{ at_revision: 0, arguments: { formula: '1d20+5' }, result: success },
        ...Array.from({ length: 11 }, () => ({ at_revision: 0, arguments: { formula: '1d20 + 5' }, result: empty }))];
    saved.draft.receipts = saved.draft.rolls.map(r => ({ tool: 'RollTheDice', revision: 0, result: r.result }));
    saved.pending.messages.at(-1).content = 'stale payload with empty rolls';
    if (changed) { saved.draft.head += '\n[MISC #changed]\nOutcome'; saved.draft.versions.push({ revision: 1, text: saved.draft.head }); }
    return saved;
}

test('legacy empty-roll loop resumes with fresh packet, preserving existing successful roll and snapshots', async () => {
    const checkpoint = await legacyCheckpoint(), before = structuredClone(checkpoint);
    let step = 0;
    const result = await runPrivateTurn({ baseline: board, context: [], checkpoint,
        invoke: () => assert.fail('Successful dice must not be repeated'), request: async messages => {
            const p = payload(messages);
            if (p.phase === 'review') return pass(p);
            assert.equal(p.rolls.length, 1);
            assert.equal(p.rolls[0].result, success);
            assert.equal(p.receipts.filter(r => r.result.code === 'DICE_NO_RESULT').length, 11);
            assert.equal(messages[0].content, 'Original attempt');
            step++; return { text: 'Recovered candidate' };
        },
    });
    assert.equal(step, 1);
    assert.equal(result.stats.recoveredEmptyDice, 11);
    assert.deepEqual(result.draft.versions, before.draft.versions);
    assert.deepEqual(checkpoint, before, 'Do not mutate the supplied export');
});

test('legacy migration refuses to alter work that may already depend on empty dice', async () => {
    const checkpoint = await legacyCheckpoint({ changed: true });
    await assert.rejects(runPrivateTurn({ baseline: board, context: [], checkpoint,
        request: () => assert.fail('No model request'), invoke: () => assert.fail('No roll'),
    }), /later work/);
});

test('mechanical checks reject an empty legacy result even when reviewer says pass', () => {
    const draft = new DraftTurn(board);
    draft.rolls.push({ arguments: { formula: '1d20 + 5' }, result: empty });
    assert.match(draft.checks().join(), /Unconfirmed dice result/);
    assert.match(draft.checks().join(), /Unconfirmed dice result/);
});
