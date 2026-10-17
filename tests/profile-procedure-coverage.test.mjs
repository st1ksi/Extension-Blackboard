import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GAME_SYSTEMS } from '../game-system-registry.js';

const source = async id => readFile(new URL(`../prompts/systems/${id}.md`, import.meta.url), 'utf8');

// Bounded editorial regression checks, not a game engine or model-behavior eval.
// These cases protect short defining procedures lost in the original split.
test('new core selections retain explicit introductory campaigns without secretly defaulting to them', async () => {
    const coc = await source('coc7e'), gurps = await source('gurps4e');
    assert.match(coc, /preserve an existing selection, including Quick-Start or Starter Set/);
    assert.match(coc, /use standard 7th Edition core scope/);
    assert.doesNotMatch(coc, /Otherwise use .*Quick-Start as the introductory scope/);
    assert.match(gurps, /Preserve the campaign's source, including an existing Lite selection/);
    assert.match(gurps, /otherwise use Fourth Edition Basic Set \(Characters and Campaigns\) scope/);
    assert.doesNotMatch(gurps, /otherwise begin with the free Fourth Edition Lite scope/);
    assert.match(GAME_SYSTEMS.coc7e.description, /Standard 7e core/);
    assert.match(GAME_SYSTEMS.gurps4e.description, /Fourth Edition Basic Set/);
});

test('CoC fact-generating Luck house policy is both model-visible and user-visible', async () => {
    const coc = await source('coc7e');
    assert.match(coc, /closed-world Luck house convention/);
    assert.match(coc, /record the policy in .*ruleset.* and disclose it briefly/);
    assert.match(coc, /genuinely undefined external circumstances/);
    assert.match(coc, /exception is not blanket permission to rewrite prepared contents or history/);
    assert.match(GAME_SYSTEMS.coc7e.description, /closed-world Luck house policy/);
    assert.match(GAME_SYSTEMS.coc7e.description, /external fact creation requires a scoped campaign agreement/);
});

test('PF Remaster owns Hero Point session, replacement and death-prevention procedures', async () => {
    const pf = await source('pf2e');
    assert.match(pf, /session with 1 Hero Point.*cap the balance at 3.*expire unspent points/s);
    assert.match(pf, /use the second result even if worse/);
    assert.match(pf, /costs no action.*available when otherwise unable to act/s);
    assert.match(pf, /when dying would increase.*all.*remaining Hero Points \(minimum 1\)/s);
    assert.match(pf, /stabilize at 0 HP.*does not add or increase wounded/s);
    assert.match(pf, /does not reduce an existing wounded value/);
    assert.match(pf, /model stage.*not a session boundary/s);
    assert.doesNotMatch(pf, /at the start of your turn or when.*dying/);
});

test('GURPS Luck owns a play-time cadence that cannot recharge from fictional travel or latency', async () => {
    const gurps = await source('gurps4e');
    assert.match(gurps, /once per hour of play.*30 minutes of play.*10/s);
    assert.match(gurps, /not elapsed fictional time/);
    assert.match(gurps, /separate from the single world clock/);
    assert.match(gurps, /Do not infer active play time from API latency/);
    assert.match(gurps, /player-agreed equivalent cadence/);
});

test('RED unresolved NET budget cannot silently become a second free action pool', async () => {
    const red = await source('cyberpunk_red');
    assert.match(red, /record the adopted source's NET\/Meat action-budget relationship/);
    assert.match(red, /never add NET Actions on top of an already spent ordinary Action unless the adopted rule expressly permits/);
    assert.match(red, /relationship is unavailable, identify it as unresolved/);
    assert.match(red, /do not promote Jumpstart or Edgerunners Mission Kit wording to full-core RAW/);
});

test('V5 recovery is source-owned and does not inherit a quickstart no-regain policy', async () => {
    const v5 = await source('vtm5e');
    assert.match(v5, /superficial and aggravated Willpower recovery/);
    assert.match(v5, /game-session marker.*separately from fictional nights and scenes/s);
    assert.match(v5, /Do not generalize a Quick-Start scenario's no-recovery restriction/);
    assert.match(v5, /do not.*invent a numerical rate/s);
});

test('SWADE initializes independent player, shared GM and NPC Wild Card pools once per session', async () => {
    const sw = await source('swade');
    assert.match(sw, /player starts a session with three Bennies/);
    assert.match(sw, /GM's shared pool begins with one per player character/);
    assert.match(sw, /each GM Wild Card has two personal Bennies/);
    assert.match(sw, /never replenish a previously spent pool simply because its actor enters view/);
    assert.match(sw, /technical retry is not a new session/);
});
