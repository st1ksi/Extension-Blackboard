import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyUpdate, parseBlocks, serializeBlocks, readProgression, normalizeProgression, validateBoard, reconcileAges, staleBlocks, findSnapshot, writeSnapshot, budget, redactToolLog } from '../state.js';

const initial = () => ({ version: 1, character_id: 'hero', ruleset: '5e-2014', mode: 'xp', base_xp: 900, baseline_reason: 'Existing level 3', level: 3, classes: [{ name: 'Monk', level: 3, subclass: 'Shadow' }], awards: [], pending_choices: [] });
const award = (id, delta, extra = {}) => ({ id, delta, at: 'Day 1 01:20:00', reason: 'Completed objective', ...extra });
const ledger = p => `[MISC #character_progression]\n\`\`\`json\n${JSON.stringify(p)}\n\`\`\``;
const sheet = '[ENTITIES #hero]\nHP 20/20; DEX 16; monk features; no level 4 gains yet.';
const board = p => `${sheet}\n\n${ledger(p)}\n\n[SCENE #study]\nEmpty shelf.`;

test('CRLF input, json fences and a quoted fake header do not corrupt block boundaries', () => {
    const raw = '[SCENE #room]\r\nA note:\r\n```text\r\n[ENTITIES #fake]\r\n```\r\n[ENTITIES #real]\r\nHP 5';
    assert.equal(parseBlocks(raw).blocks.length, 2);
    assert.equal(parseBlocks(serializeBlocks(parseBlocks(raw))).blocks.length, 2);
    assert.equal(parseBlocks('```markdown\n[SCENE #a]\nStone.\n```').blocks.length, 1);
});
test('XP is recalculated from ledger, not the supplied total', () => {
    const p = initial(); p.xp = 999999; p.awards.push(award('one', 100));
    const result = applyUpdate('', { action: 'replace_all', content: board(p) });
    assert.equal(result.progression.xp, 1000);
    assert.equal(result.progression.level, 3);
    assert.equal(result.progression.next_level_xp, 2700);
});
test('same full ledger upsert is idempotent', () => {
    const p = initial(); p.awards.push(award('one', 100));
    const once = applyUpdate('', { content: board(p) }).text;
    const twice = applyUpdate(once, { content: ledger(p) });
    assert.equal(twice.text, once);
    assert.equal(twice.progression.xp, 1000);
});
test('duplicate award cannot double XP', () => {
    const p = initial(); p.awards.push(award('one', 100), award('one', 100));
    assert.throws(() => applyUpdate('', { content: board(p) }), /Duplicate XP/);
});
test('ledger cannot remove, rewrite, reorder or change its baseline', () => {
    const p = initial(); p.awards.push(award('one', 100), award('two', 50));
    const before = board(p);
    for (const mutate of [x => x.awards.pop(), x => x.awards[0].delta++, x => x.awards.reverse(), x => x.base_xp++]) {
        const bad = structuredClone(p); mutate(bad);
        assert.throws(() => applyUpdate(before, { content: ledger(bad) }));
    }
});
test('signed correction is bounded and preserves already earned level', () => {
    const p = initial(); p.level = 4; p.classes[0].level = 4; p.awards.push(award('level', 1800));
    const corrected = structuredClone(p); corrected.awards.push(award('fix', -100, { corrects: 'level' }));
    const result = applyUpdate(board(p), { content: ledger(corrected) });
    assert.equal(readProgression(result.text).xp, 2600);
    assert.equal(readProgression(result.text).level, 4);
    assert.equal(validateBoard(result.text).progression.level, 4);
    corrected.awards.push(award('bad', -1800, { corrects: 'level' }));
    assert.throws(() => applyUpdate(board(p), { content: ledger(corrected) }), /cannot exceed/);
});
test('earning level 5 does not apply it while choices are pending', () => {
    const p = initial(); p.awards.push(award('major', 5600)); p.pending_choices = ['Choose level 4 ASI'];
    const result = applyUpdate('', { content: board(p) }).progression;
    assert.equal(result.eligible_level, 5);
    assert.equal(result.level, 3);
    assert.equal(result.proficiency_bonus, 2);
    assert.equal(result.next_level_xp, 14000);
});
test('level-up requires eligibility, one step, completed choices, and changed sheet in one batch', () => {
    const old = initial(); old.awards.push(award('earned', 5600));
    const next = structuredClone(old); next.level = 4; next.classes[0].level = 4;
    assert.throws(() => applyUpdate(board(old), { content: ledger(next) }), /same batch/);
    next.pending_choices = ['ASI'];
    assert.throws(() => applyUpdate(board(old), { content: ledger(next) + '\n[ENTITIES #hero]\nHP 26; updated' }), /pending choices/);
    next.pending_choices = [];
    const good = applyUpdate(board(old), { content: ledger(next) + '\n[ENTITIES #hero]\nHP 26; DEX 18; chosen ASI' });
    assert.equal(good.progression.level, 4);
    assert.equal(good.progression.xp, 6500);
    next.level = 5; next.classes[0].level = 5;
    assert.throws(() => applyUpdate(board(old), { content: ledger(next) }), /one earned level/);
    next.awards = []; next.level = 4; next.classes[0].level = 4;
    assert.throws(() => applyUpdate(board(initial()), { content: ledger(next) + '\n[ENTITIES #hero]\nHP 26' }), /exceeds/);
});
test('proficiency follows total level, and multiclass levels must agree', () => {
    const p = initial(); p.level = 5; p.base_xp = 6500; p.classes = [{ name: 'Monk', level: 3 }, { name: 'Rogue', level: 2 }];
    assert.equal(normalizeProgression(p).proficiency_bonus, 3);
    p.classes[1].level = 3;
    assert.throws(() => normalizeProgression(p), /sum/);
});
test('boundary thresholds and level 20 are correct', () => {
    for (const [xp, level] of [[299,1],[300,2],[899,2],[900,3],[2699,3],[2700,4],[6499,4],[6500,5],[224999,16],[225000,17],[354999,19],[355000,20]]) {
        const p = initial(); p.level = 1; p.classes[0].level = 1; p.base_xp = xp;
        assert.equal(normalizeProgression(p).eligible_level, level);
    }
    const p = initial(); p.level = 20; p.classes[0].level = 20; p.base_xp = 355000;
    assert.equal(normalizeProgression(p).next_level_xp, null);
    assert.equal(normalizeProgression(p).proficiency_bonus, 6);
});
test('malformed and fractional XP fails before a batch changes any world block', () => {
    const old = board(initial());
    const bad = initial(); bad.awards.push(award('fraction', 1.5));
    assert.throws(() => applyUpdate(old, { content: '[SCENE #study]\nLooted.\n' + ledger(bad) }), /integer/);
    assert.equal(readProgression(old).xp, 900);
    assert.match(old, /Empty shelf/);
});
test('model cannot remove progression or its character sheet', () => {
    const old = board(initial());
    assert.throws(() => applyUpdate(old, { action: 'delete', block_id: 'MISC #character_progression' }), /cannot be deleted/);
    assert.throws(() => applyUpdate(old, { action: 'delete', block_id: 'ENTITIES #hero' }), /missing player/);
});
test('unknown action, ambiguous IDs and duplicate blocks are rejected', () => {
    assert.throws(() => applyUpdate('', { action: 'upsret', content: sheet }), /Use upsert/);
    assert.throws(() => applyUpdate('', { block_id: 'hero', content: 'x' }), /complete block ID/);
    assert.throws(() => applyUpdate('', { content: sheet + '\n' + sheet }), /Duplicate block/);
    assert.throws(() => applyUpdate('', { block_id: 'SCENE #wrong', content: sheet }), /conflicts/);
});
test('deleting an exact ID cannot delete another category with the same tag', () => {
    const result = applyUpdate('[SCENE #same]\na\n[ENTITIES #same]\nb', { action: 'delete', block_id: 'LORE #same' });
    assert.equal(result.parsed.blocks.length, 2);
});
test('replacement cannot erase populated world or clear it by tool', () => {
    assert.throws(() => applyUpdate(sheet, { action: 'replace_all', content: '[SCENE #a]\nb' }), /drop existing/);
    assert.throws(() => applyUpdate(sheet, { action: 'clear' }), /inspector/);
});
test('STALE counts unchanged content, not tool calls or formatting', () => {
    const text = '[SCENE #wall]\nStone.';
    let ages = reconcileAges(text, {}, 1);
    ages = reconcileAges(text + '\n', ages, 2);
    assert.deepEqual(staleBlocks(text, ages, 4), [{ id: 'SCENE #wall', age: 3 }]);
    ages = reconcileAges('[SCENE #wall]\nCracked.', ages, 4);
    assert.deepEqual(staleBlocks('[SCENE #wall]\nCracked.', ages, 4), []);
});
test('deleting/recreating a block starts a fresh age', () => {
    let ages = reconcileAges(sheet, {}, 1);
    ages = reconcileAges('', ages, 4);
    assert.deepEqual(ages, {});
    ages = reconcileAges(sheet, ages, 5);
    assert.deepEqual(staleBlocks(sheet, ages, 5), []);
});
test('snapshots preserve selected swipes and isolate engine objects', () => {
    const message = { swipe_id: 0, swipes: ['A','B'], swipe_info: [{}, {}], extra: {} };
    const engine = { version: 1, turn: 1, ages: {} };
    writeSnapshot(message, 'A board', engine);
    message.swipe_id = 1; writeSnapshot(message, 'B board', { ...engine, turn: 2 });
    message.swipe_id = 0;
    assert.equal(findSnapshot([message]).text, 'A board');
    assert.equal(findSnapshot([message]).engine.turn, 1);
    engine.turn = 20;
    assert.equal(findSnapshot([message]).engine.turn, 1);
});
test('ungenerated or unsnapshotted alternative cannot inherit the previous alternative', () => {
    const before = { is_user: true, extra: { blackboard_snapshot: '' } };
    const msg = { swipe_id: 1, swipes: ['A'], extra: { blackboard_snapshot: 'future' } };
    assert.equal(findSnapshot([before, msg]).text, '');
    msg.swipes.push('legacy B'); msg.swipe_info = [{ extra: { blackboard_snapshot: 'future' } }, {}];
    assert.equal(findSnapshot([before, msg]).text, '');
});
test('custom corridor is honored and inverted max cannot survive', () => {
    const presets = { mid: { minTokens: 800, maxTokens: 1500 }, custom: { name: 'Custom', minTokens: 800, maxTokens: 1500 } };
    assert.deepEqual(budget({ simulationFidelity: 'custom', targetMinTokens: 2500, targetMaxTokens: 8000 }, presets), { min: 2500, max: 8000, name: 'Custom' });
    assert.equal(budget({ simulationFidelity: 'custom', targetMinTokens: 2500, targetMaxTokens: 1000 }, presets).max, 2500);
});
test('tool display hides private board arguments while API records remain unchanged', () => {
    const message = { extra: { tool_invocations: [{ name: 'UpdateBlackboard', parameters: 'secret killer Edda', result: 'secret' }, { name: 'RollTheDice', parameters: '1d20', result: '12' }] } };
    const originals = structuredClone(message.extra);
    assert.equal(redactToolLog(message), true);
    assert.doesNotMatch(message.mes, /Edda|secret killer/);
    assert.match(message.mes, /1d20/);
    assert.deepEqual(message.extra, originals);
});
test('milestone progression has no fictional XP eligibility', () => {
    const p = initial(); p.mode = 'milestone'; p.base_xp = 0;
    assert.equal(normalizeProgression(p).eligible_level, null);
    assert.equal(normalizeProgression(p).next_level_xp, null);
});
