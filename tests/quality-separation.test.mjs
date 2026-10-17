import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SYSTEM_BUNDLES } from '../prompts/system-bundles.js';
import { PROMPT_ULTRA } from '../prompts/ultra.js';

const variants = ['low', 'mid', 'high', 'compact', 'ultra'];
const directory = new URL('../prompts/systems/', import.meta.url);

test('every current quality source is genre/prose-style neutral and remains the exact bundled source', async () => {
    for (const variant of variants) {
        const bundle = SYSTEM_BUNDLES[variant];
        const source = await readFile(new URL(`${variant}-base.md`, directory), 'utf8');
        assert.equal(bundle.base, source, variant);
        assert.doesNotMatch(source, /\bGrimdark\b|\bnarrat(?:e|ive) vividly\b|\bvivid(?:, sensory)? narrative\b|\bUse sensory, grounded prose\b/i, variant);
        assert.match(source, /impartial/i, variant);
        assert.match(source, /N−1/, variant);
        assert.match(source, /before.*(?:narrat|describ)|Establish.*before.*describ|narrative.*derived from committed reality/i, variant);
        assert.match(source, /beliefs|believe/i, variant);
        assert.match(source, /red line|red lines|refusal boundaries/i, variant);
        assert.match(source, /complete.*(?:inventor|contents)|(?:inventor|contents).*complete/is, variant);
        assert.match(source, /clock|interval/i, variant);
        assert.match(source, /player.*(?:thoughts|speech|feelings)|(?:thoughts|speech|feelings).*player/is, variant);
        assert.match(source, /perceiv|percept|known.*propert/i, variant);
    }
});

test('historical tone/presentation survives as explicit migration metadata rather than current quality instructions', () => {
    for (const variant of variants) {
        const bundle = SYSTEM_BUNDLES[variant];
        assert.ok(bundle.priorBases.length > 0, variant);
        assert.equal(bundle.qualityDefaults.campaignTone, ['compact', 'ultra'].includes(variant) ? 'grimdark' : 'inherit');
        assert.equal(bundle.qualityDefaults.narrativeStyle, 'evocative');
        if (['compact', 'ultra'].includes(variant)) {
            assert.ok(bundle.priorBases.some(source => /Grimdark/.test(source)), variant + ': old exact source must remain recognizable');
        }
    }
    assert.ok(SYSTEM_BUNDLES.low.separatedPriorIndices.length > 0, 'The previously separated Low remains explicitly recognizable after corrections');
});

test('ordinary NPC preparation and established social records remain core under General and any game system', () => {
    const core = SYSTEM_BUNDLES.compact.base;
    assert.match(core, /drives and fears; values and red lines/);
    assert.match(core, /relevant loyalties, obligations, incentives/);
    assert.match(core, /Preserve established loyalty scales, bribery terms, debts, vices and family ties/);
    assert.match(core, /new vulnerabilities or numerical meters are not mandatory/);
    assert.match(core, /applicable campaign rules/);
    assert.match(core, /generic red line creates no new immunity/i);
    assert.doesNotMatch(core, /red line makes success impossible regardless of the roll/);
    assert.doesNotMatch(core, /loyalty \(0–100, to whom\)/);
    assert.doesNotMatch(core, /\[D&D 5e PROFILE/);
    assert.match(SYSTEM_BUNDLES.high.base, /loyalties\/levers/);
    assert.match(SYSTEM_BUNDLES.mid.base, /motives, knowledge versus beliefs/);
    assert.match(SYSTEM_BUNDLES.low.base, /goal, knowledge, beliefs and relevant refusal boundaries/);
    assert.match(SYSTEM_BUNDLES.ultra.base, /loyalties and obligations/);
});

test('all D&D profile variants retain social conventions without requiring the Social focus', () => {
    for (const variant of variants) {
        const profile = SYSTEM_BUNDLES[variant].dnd5e;
        assert.equal((profile.match(/\[D&D 5e PROFILE — SOCIAL ADJUDICATION/g) || []).length, 1, variant);
        assert.match(profile, /Retain established 0–100 loyalty values and their meaning/, variant);
        assert.match(profile, /bribery threshold when the actor would consider them/, variant);
        assert.match(profile, /debts, vices, family ties/, variant);
        assert.match(profile, /campaign simulation conventions, not universal official 5e rules/, variant);
        assert.match(profile, /before the roll/, variant);
        assert.match(profile, /magical compulsion.*actual rule scope and duration/is, variant);
        assert.match(profile, /Relationships & Social focus is later disabled/, variant);
        assert.doesNotMatch(SYSTEM_BUNDLES[variant].universal, /0–100|D&D 5e PROFILE/, variant);
    }
});

test('public current Markdown exports and runtime Ultra are the exact separated quality prompts', async () => {
    const files = {
        low: 'PROMPT_1_LOW_LEAN.md', mid: 'PROMPT_2_MID_BALANCED.md',
        high: 'PROMPT_3_HIGH_DEEP.md', compact: 'PROMPT_4_ULTRA_LIVING_WORLD.md',
    };
    for (const [variant, name] of Object.entries(files)) {
        assert.equal(await readFile(new URL('../prompts/' + name, import.meta.url), 'utf8'), SYSTEM_BUNDLES[variant].base, variant);
    }
    assert.equal(PROMPT_ULTRA, SYSTEM_BUNDLES.compact.base);
});
