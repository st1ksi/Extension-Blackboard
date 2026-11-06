import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollBlackboardDice, validateBlackboardDiceArguments, DiceValidationError, DiceExecutionError, DICE_LIMITS, DICE_PARAMETERS } from '../dice-engine.js';

const words = (...values) => {
    let index = 0;
    const draw = () => { assert.ok(index < values.length, 'Unexpected extra random draw'); return values[index++]; };
    draw.used = () => index;
    return draw;
};
const roll = (args, ...values) => rollBlackboardDice(args, { randomUint32: words(...values) });

test('standard and mixed signed formulas retain every real face and sum the declared terms', () => {
    const input = { formula: ' 2d6 + 1d4 − 2 ', label: 'Attack damage' };
    const result = roll(input, 0, 5, 2);
    assert.equal(result.formula, '2d6+1d4-2');
    assert.equal(result.total, 8);
    assert.deepEqual(result.rolls, [1, 6, 3]);
    assert.deepEqual(result.face_values, [1, 6, 3]);
    assert.deepEqual(result.groups.map(g => g.subtotal), [7, 3]);
    assert.equal(result.modifier, -2);
    assert.equal(result.status, 'success');
    assert.equal(input.formula, ' 2d6 + 1d4 − 2 ');
    const signed = roll({ formula: 'd8-2d4+7-1' }, 7, 1, 2);
    assert.equal(signed.total, 9);
    assert.deepEqual(signed.groups.map(g => g.sign), [1, -1]);
});

test('all formula/request validation completes before any random value is consumed', () => {
    const invalid = [
        null, [], {}, { formula: '' }, { formula: '20' }, { formula: '2d6+1d0' },
        { formula: '1d20;Math.random()' }, { formula: '1d6*2' }, { formula: '(1d6)' },
        { formula: '1 2d6' }, { formula: '0d6' }, { formula: '101d6' }, { formula: '60d6+41d6' },
        { formula: '1d1000000001' }, { formula: '1d1!' }, { formula: '2d6kh3' }, { formula: '2d6dl2' },
        { formula: '2d6kh0' }, { formula: '1d6++2' }, { formula: '1d6-+2' }, { formula: '1d6d4' },
        { formula: 'd6', faces: [1, 2] }, { formula: 'd6', count: 1 }, { formula: 'd6', modifier: 0 },
        { formula: 'd6', mode: null }, { formula: 'd6', mode: 'both' }, { formula: 'd6', label: '\nHidden actor' },
        { formula: 'd6', execute: 'anything' }, { formula: 'd6+1000000000+1' },
        { faces: [] }, { faces: [1, 'hit'] }, { faces: [NaN] }, { faces: [Infinity] },
        { faces: [''] }, { faces: ['a\nb'] }, { faces: ['a'.repeat(161)] },
        { faces: [1, 2], count: -1 }, { faces: ['hit', 'miss'], modifier: 1 },
        { faces: [1, 2], count: null }, { faces: [1, 2], modifier: null },
        { faces: [1, 2], modifier: 0.5 }, { faces: [1, 2], facesExtra: true },
    ];
    for (const args of invalid) {
        let calls = 0;
        assert.throws(() => rollBlackboardDice(args, { randomUint32: () => { calls++; return 0; } }), DiceValidationError, JSON.stringify(args));
        assert.equal(calls, 0, JSON.stringify(args));
    }
});

test('rejection sampling does not modulo-bias non-power-of-two dice', () => {
    const rng = words(0xffff_ffff, 0xffff_fffe, 0xffff_fffd, 0xffff_fffc, 5);
    const result = rollBlackboardDice({ formula: 'd6' }, { randomUint32: rng });
    assert.equal(result.total, 6);
    assert.equal(rng.used(), 5);
    assert.deepEqual(result.rolls, [6]);
    assert.equal(roll({ formula: 'd1000000000' }, 0).total, 1);
    assert.equal(roll({ formula: 'd1000000000' }, 999999999).total, 1000000000);
});

test('keep/drop operations select by rolled totals and preserve dropped faces with stable ties', () => {
    for (const [selection, total, kept] of [
        ['kh2', 11, [false, true, true, false]], ['kl2', 3, [true, false, false, true]],
        ['dh1', 8, [true, false, true, true]], ['dl1', 13, [false, true, true, true]],
    ]) {
        const result = roll({ formula: '4d6' + selection }, 0, 5, 4, 1);
        assert.equal(result.total, total);
        assert.deepEqual(result.rolls, [1, 6, 5, 2]);
        assert.deepEqual(result.groups[0].dice.map(d => d.kept), kept);
    }
    const tied = roll({ formula: '2d20kh1' }, 9, 9);
    assert.deepEqual(tied.groups[0].dice.map(d => d.kept), [true, false]);
});

test('advantage and disadvantage draw two real dice once and add the modifier after selection', () => {
    for (const [mode, total] of [['advantage', 22], ['disadvantage', 8]]) {
        const rng = words(2, 16);
        const result = rollBlackboardDice({ formula: 'd20+5', mode }, { randomUint32: rng });
        assert.equal(result.total, total);
        assert.equal(result.requested_formula, '1d20+5');
        assert.equal(result.formula, mode === 'advantage' ? '2d20kh1+5' : '2d20kl1+5');
        assert.equal(rng.used(), 2);
        assert.deepEqual(result.rolls, [3, 17]);
    }
    for (const formula of ['2d20', '1d20kh1', '1d6!', '-1d20', '1d20+1d4']) {
        assert.throws(() => validateBlackboardDiceArguments({ formula, mode: 'advantage' }), DiceValidationError);
    }
    assert.throws(() => validateBlackboardDiceArguments({ faces: ['hit','miss'], mode: 'advantage' }), DiceValidationError);
});

test('explosions retain every face, sum each chain and select after explosion', () => {
    const result = roll({ formula: '2d6!kh1+2' }, 5, 5, 0, 4);
    assert.deepEqual(result.rolls, [6, 6, 1, 5]);
    assert.equal(result.total, 15);
    assert.deepEqual(result.groups[0].dice, [
        { values: [6,6,1], total: 13, kept: true },
        { values: [5], total: 5, kept: false },
    ]);
});

test('unfinished explosions stop with an incomplete partial receipt, never a truncated success', () => {
    let calls = 0;
    assert.throws(() => rollBlackboardDice({ formula: '1d6!' }, { randomUint32: () => { calls++; return 5; } }), error => {
        assert.ok(error instanceof DiceExecutionError);
        assert.equal(error.uncertain, true);
        assert.equal(error.partialReceipt.status, 'incomplete');
        assert.equal(error.partialReceipt.total, null);
        assert.equal(error.partialReceipt.rolls.length, DICE_LIMITS.chainLength);
        assert.ok(error.partialReceipt.rolls.every(v => v === 6));
        return true;
    });
    assert.equal(calls, DICE_LIMITS.chainLength);
});

test('custom numeric faces use their actual values, duplicate weighting and immutable source', () => {
    const args = { faces: [-1, 0, 1, 1], count: 3, modifier: 2 };
    const result = roll(args, 0, 2, 3);
    assert.equal(result.total, 3);
    assert.deepEqual(result.rolls, [-1, 1, 1]);
    assert.deepEqual(result.face_values, [-1, 1, 1]);
    assert.deepEqual(result.groups[0].dice.map(d => d.indices[0]), [1,3,4]);
    assert.deepEqual(args, { faces: [-1,0,1,1], count: 3, modifier: 2 });
    const adv = roll({ faces: [-2, 2, 9], mode: 'advantage', modifier: -1 }, 0, 2);
    assert.equal(adv.total, 8);
    assert.deepEqual(adv.groups[0].dice.map(d => d.kept), [false, true]);
});

test('custom symbolic dice never invent a numeric total; indexes are explicitly distinguished from faces', () => {
    const result = roll({ faces: ['blank', 'hit', 'critical hit', 'hit'], count: 3 }, 2, 0, 3);
    assert.equal(result.total, null);
    assert.equal(result.rolls_kind, 'face_indices');
    assert.deepEqual(result.rolls, [3,1,4]);
    assert.deepEqual(result.face_values, ['critical hit','blank','hit']);
    assert.deepEqual(result.groups[0].dice.map(d => d.values), [['critical hit'],['blank'],['hit']]);
    assert.equal(result.groups[0].subtotal, null);
    assert.ok(result.groups[0].dice.every(d => d.total === null));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('portable model schema uses primitive string face items with explicit numeric interpretation', () => {
    assert.deepEqual(DICE_PARAMETERS.properties.faces.items, { type: 'string' });
    assert.doesNotMatch(JSON.stringify(DICE_PARAMETERS), /anyOf|oneOf/);
    const args = { faces: ['-1', '0', '1', '1.5', '1e2'], face_type: 'number', count: 3, modifier: 2 };
    const normalized = validateBlackboardDiceArguments(args);
    assert.deepEqual(normalized, { faces: [-1,0,1,1.5,100], face_type: 'number', count: 3, modifier: 2, mode: 'normal' });
    const result = roll(normalized, 0, 3, 4);
    assert.equal(result.total, 102.5);
    assert.deepEqual(result.face_values, [-1,1.5,100]);
    assert.equal(result.rolls_kind, 'faces');
    assert.deepEqual(args.faces, ['-1','0','1','1.5','1e2']);
    assert.deepEqual(roll({ faces: [1,2], face_type: 'number' }, 1).face_values, [2]);
    assert.equal(roll({ faces: ['1','2'], face_type: 'symbol' }, 1).total, null);
    assert.equal(roll({ faces: ['1','2'] }, 1).total, null, 'Absent face_type preserves string-as-symbol inference.');
});

test('invalid explicit numeric face encodings and incompatible face_type reject before randomness', () => {
    const invalid = [
        ...[' 1','1 ','0x10','Infinity','NaN','','+1','.5','01','1.','1e309','1000000001'].map(face => ({ faces: [face], face_type: 'number' })),
        { faces: [1], face_type: 'symbol' }, { faces: ['a'], face_type: 'number' },
        { faces: ['a'], face_type: null }, { faces: ['a'], face_type: 'numeric' },
        { formula: '1d6', face_type: 'number' },
    ];
    for (const args of invalid) {
        let calls = 0;
        assert.throws(() => rollBlackboardDice(args, { randomUint32: () => { calls++; return 0; } }), error => {
            assert.ok(error instanceof DiceValidationError);
            assert.equal(error.rolled, false);
            return true;
        });
        assert.equal(calls, 0, JSON.stringify(args));
    }
});

test('random-source exceptions and invalid words preserve the draws already made without completing the request', () => {
    for (const bad of [() => { throw new Error('hardware'); }, () => -1, () => 0x1_0000_0000, () => 0.5]) {
        let draws = 0;
        assert.throws(() => rollBlackboardDice({ formula: '2d6' }, { randomUint32: () => ++draws === 1 ? 3 : bad() }), error => {
            assert.ok(error instanceof DiceExecutionError);
            assert.equal(error.uncertain, true);
            assert.deepEqual(error.partialReceipt.rolls, [4]);
            assert.equal(error.partialReceipt.status, 'incomplete');
            return true;
        });
    }
    let calls = 0;
    assert.throws(() => rollBlackboardDice({ formula: 'd6' }, { randomUint32: () => { calls++; return 0xffff_ffff; } }), DiceExecutionError);
    assert.equal(calls, DICE_LIMITS.rejectionAttempts);
});

test('native crypto path returns bounded integer faces without Math.random', () => {
    const original = Math.random;
    Math.random = () => assert.fail('Math.random must never be used');
    try {
        const result = rollBlackboardDice({ formula: '100d7-3' });
        assert.equal(result.rolls.length, 100);
        assert.ok(result.rolls.every(v => Number.isInteger(v) && v >= 1 && v <= 7));
        assert.equal(result.total, result.rolls.reduce((sum, v) => sum + v, -3));
    } finally { Math.random = original; }
});

test('normalization exposes canonical arguments without changing or freezing user input', () => {
    const request = { formula: 'd20 + 2 - 1', mode: 'advantage', label: '  Public check  ' };
    assert.deepEqual(validateBlackboardDiceArguments(request), { formula: '1d20+1', mode: 'advantage', label: 'Public check' });
    assert.equal(request.formula, 'd20 + 2 - 1');
    assert.throws(() => rollBlackboardDice({ formula: 'd6' }, { randomUint32: 1 }), DiceValidationError);
});
