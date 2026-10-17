import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    CAMPAIGN_LAYER_OPTIONS, normalizeCampaignLayers, isDefaultCampaignLayers,
    composeCampaignLayers, freezeCampaignLayers, campaignLayersFingerprint, getCampaignReviewCriteria,
} from '../campaign-layers.js';
import { CAMPAIGN_PROMPTS } from '../prompts/campaign-bundle.js';
import { SYSTEM_BUNDLES } from '../prompts/system-bundles.js';

const defaults = { simulationFocus: 'general', campaignStyle: 'inherit', campaignTone: 'inherit', narrativeStyle: 'inherit' };

test('missing/invalid selections inherit without mutation or guessing genres from text', () => {
    const input = { simulationFocus: 'romance', campaignStyle: 'Grimdark', campaignTone: false, narrativeStyle: ['concise'], extra: 3 };
    const before = JSON.stringify(input);
    assert.deepEqual(normalizeCampaignLayers(input), defaults);
    assert.deepEqual(normalizeCampaignLayers(null), defaults);
    assert.equal(JSON.stringify(input), before);
    assert.equal(isDefaultCampaignLayers(input), true);
    assert.equal(isDefaultCampaignLayers({ campaignStyle: 'adventure' }), false);
    assert.equal(isDefaultCampaignLayers({ simulationFocus: 'relationships_social' }), false);
});

for (const [variant, bundle] of Object.entries(SYSTEM_BUNDLES)) {
    test(variant + ': default settings preserve the exact quality base and add no hidden instructions', () => {
        const base = bundle.base;
        const result = composeCampaignLayers({ simulationFidelity: variant === 'compact' ? 'ultra' : variant }, { base, recognized: true, variant });
        assert.equal(result.base, base);
        assert.equal(result.instructions, '');
        assert.equal(result.gameProfileSupplement, undefined);
        assert.equal(result.changed, false);
        for (const aspect of ['time', 'continuity', 'reach', 'narration', 'light']) {
            assert.equal(getCampaignReviewCriteria(result.snapshot, aspect), '');
        }
    });
}

test('each selected tier gets one social depth adapter without changing its quality horizon', () => {
    for (const tier of ['low', 'mid', 'high', 'ultra', 'custom']) {
        const settings = { simulationFocus: 'relationships_social', simulationFidelity: tier, gameSystem: 'universal' };
        const result = composeCampaignLayers(settings, { base: SYSTEM_BUNDLES[tier === 'ultra' || tier === 'custom' ? 'compact' : tier].base });
        assert.equal(result.snapshot.tier, tier);
        assert.equal((result.instructions.match(/SOCIAL DEPTH —/g) || []).length, 1);
        assert.match(result.instructions, new RegExp('SOCIAL DEPTH — ' + tier.toUpperCase()));
        assert.match(result.instructions, /quality tier|Quality owns/);
        assert.match(result.instructions, /No wider social-network expansion|not expand the entire acquaintance|without promoting every named contact|without promoting lower-resolution branches|without assuming Ultra/);
        assert.equal(result.snapshot.gameProfile.id, 'universal');
    }
});

test('recognized old sources retain their actual tier; arbitrary custom quality gets custom adapter', () => {
    for (const variant of ['low', 'mid', 'high', 'compact', 'ultra']) {
        const bundle = SYSTEM_BUNDLES[variant];
        const settings = { simulationFidelity: 'ultra', simulationFocus: 'relationships_social', customPrompt: bundle.legacy };
        const expected = ['compact', 'ultra'].includes(variant) ? 'ultra' : variant;
        assert.equal(freezeCampaignLayers(settings).tier, expected);
    }
    const arbitrary = { simulationFidelity: 'ultra', simulationFocus: 'relationships_social', customPrompt: 'Only prepare one next contact.' };
    assert.equal(freezeCampaignLayers(arbitrary).tier, 'custom');
    const prior = SYSTEM_BUNDLES.compact.priorBases?.[0];
    if (prior) assert.equal(freezeCampaignLayers({ ...arbitrary, customPrompt: prior }).tier, 'ultra');
});

test('social conventions live in the game profile with or without the focus, and the quality source is immutable', () => {
    const source = SYSTEM_BUNDLES.compact.base;
    const settings = { simulationFocus: 'relationships_social', simulationFidelity: 'ultra', gameSystem: 'dnd5e' };
    const result = composeCampaignLayers(settings, { base: source, recognized: true });
    assert.equal(result.base,source);
    assert.doesNotMatch(result.base, /red line makes success impossible regardless of the roll/);
    assert.doesNotMatch(result.base, /levers — loyalty \(0–100, to whom\), price/);
    assert.match(result.base, /Preserve established loyalty scales, bribery terms, debts, vices and family ties/);
    assert.match(result.base, /generic red line creates no new immunity/);
    assert.match(result.snapshot.gameProfile.text, /D&D 5e PROFILE/);
    assert.match(result.snapshot.gameProfile.text, /0–100 loyalty values/);
    assert.match(result.snapshot.gameProfile.text, /campaign simulation conventions, not universal official 5e/);
    assert.match(result.snapshot.gameProfile.text, /before the roll/);
    assert.match(result.snapshot.gameProfile.text, /magical compulsion/);
    assert.equal(result.snapshot.gameProfile.text,freezeCampaignLayers({...settings,simulationFocus:'general'}).gameProfile.text);
    assert.equal(SYSTEM_BUNDLES.compact.base, source, 'Never mutate the source bundle');
    const universal = composeCampaignLayers({ ...settings, gameSystem: 'universal' }, { base: source });
    assert.equal(universal.snapshot.gameProfile.id, 'universal');
    assert.match(universal.base, /Preserve established loyalty scales/);
    assert.match(universal.instructions, /no new universal relationship score/i);
});

test('campaign style is independent from focus, tone and player role', () => {
    for (const option of CAMPAIGN_LAYER_OPTIONS.campaignStyle.filter(item => item.id !== 'inherit')) {
        const settings = { campaignStyle: option.id };
        const result = composeCampaignLayers(settings, { base: SYSTEM_BUNDLES.compact.base });
        assert.equal(result.base, SYSTEM_BUNDLES.compact.base);
        assert.equal(result.social, false);
        assert.equal(result.tone, 'inherit');
        assert.equal(result.gameProfileSupplement, undefined);
        assert.match(result.instructions, /CAMPAIGN STYLE/);
        assert.doesNotMatch(result.instructions, /SIMULATION FOCUS — RELATIONSHIPS|SOCIAL DEPTH/);
        assert.match(result.instructions, /player chooses|player need not|player may|Player|The player/i);
        assert.match(result.instructions, /No .*quota|not a quota|no .*quota|never mandatory|No assigned|No forced|no compulsory|never choose/i);
    }
    const detective = freezeCampaignLayers({ campaignStyle: 'deductive' }).instructions;
    assert.match(detective, /ordinary explanation remains possible/);
    const adventure = freezeCampaignLayers({ campaignStyle: 'adventure' }).instructions;
    assert.match(adventure, /need not become a hero/);
    assert.match(adventure, /Combat is possible, never mandatory/);
});

test('every explicit tone appends instructions without rewriting the neutral quality source', () => {
    for (const variant of ['compact', 'ultra']) {
        for (const tone of ['balanced', 'grimdark', 'hopeful']) {
            const base = SYSTEM_BUNDLES[variant].base;
            const result = composeCampaignLayers({ campaignTone: tone }, { base, recognized: true });
            assert.equal(result.base,base);
            assert.doesNotMatch(result.base.slice(0, 1000), /Grimdark/);
            assert.match(result.base.slice(0, 1000), /Atmosphere never (?:requires|justifies) arbitrary punishment/);
            assert.match(result.instructions, /CAMPAIGN TONE/);
            assert.match(result.instructions, /existing|established/i);
        }
    }
    const focused = composeCampaignLayers({ simulationFocus: 'relationships_social' }, { base: SYSTEM_BUNDLES.compact.base });
    assert.equal(focused.base,SYSTEM_BUNDLES.compact.base);
    assert.doesNotMatch(focused.base.slice(0, 1000), /Grimdark/);
});

test('arbitrary edited quality is never stripped even with a spoofed recognized flag', () => {
    const custom = SYSTEM_BUNDLES.compact.base + '\nUser-authored constraint.';
    const settings = { customPrompt: custom, simulationFocus: 'relationships_social', campaignTone: 'hopeful' };
    const result = composeCampaignLayers(settings, { base: custom, recognized: true, variant: 'compact' });
    assert.equal(result.base, custom);
    assert.equal(result.metadata.customQualityPreserved, true);
    assert.equal(freezeCampaignLayers(settings).tier, 'custom');
});

test('explicit presentation supplements do not replace required output or private preparation', () => {
    for (const narrativeStyle of ['concise', 'evocative']) {
        const snapshot = freezeCampaignLayers({ narrativeStyle });
        assert.match(snapshot.instructions, /NARRATION STYLE/);
        assert.match(snapshot.instructions, /required.*mechanics|mechanics.*required/);
        assert.match(getCampaignReviewCriteria(snapshot, 'narration'), /knowledge boundary/);
        assert.equal(getCampaignReviewCriteria(snapshot, 'time'), '');
        assert.equal(getCampaignReviewCriteria(snapshot, 'continuity'), '');
    }
});

test('layer combinations compose one contract and one selected source each with stable frozen equality', () => {
    const settings = {
        simulationFidelity: 'high', gameSystem: 'dnd5e',
        simulationFocus: 'relationships_social', campaignStyle: 'deductive', campaignTone: 'hopeful', narrativeStyle: 'concise',
    };
    const before = JSON.stringify(settings);
    const composed = composeCampaignLayers(settings, { base: SYSTEM_BUNDLES.high.base });
    const snapshot = freezeCampaignLayers(settings);
    assert.deepEqual(composed.snapshot, snapshot);
    assert.equal((snapshot.instructions.match(/\[CAMPAIGN LAYERS — v1\]/g) || []).length, 1);
    assert.equal((snapshot.instructions.match(/\[SIMULATION FOCUS — RELATIONSHIPS/g) || []).length, 1);
    assert.equal((snapshot.instructions.match(/\[CAMPAIGN STYLE —/g) || []).length, 1);
    assert.equal((snapshot.instructions.match(/\[CAMPAIGN TONE —/g) || []).length, 1);
    assert.equal((snapshot.instructions.match(/\[NARRATION STYLE —/g) || []).length, 1);
    assert.equal(JSON.stringify(settings), before);
    assert.equal(campaignLayersFingerprint(snapshot), campaignLayersFingerprint(JSON.parse(JSON.stringify(snapshot))));
    assert.notEqual(campaignLayersFingerprint(snapshot), campaignLayersFingerprint({ ...settings, campaignTone: 'balanced' }));
});

test('saved exact review criteria take precedence over current template lookup on resume', () => {
    const frozen = freezeCampaignLayers({ simulationFocus: 'relationships_social' });
    frozen.reviewCriteria.time = 'Previously frozen exact criterion.';
    frozen.reviewCriteria.combined = 'Previously frozen combined criterion.';
    assert.equal(getCampaignReviewCriteria(frozen, 'time'), 'Previously frozen exact criterion.');
    assert.equal(getCampaignReviewCriteria(frozen, 'light'), 'Previously frozen combined criterion.');
    assert.equal(getCampaignReviewCriteria(frozen, 'unknown'), '');
    assert.notEqual(campaignLayersFingerprint(frozen), campaignLayersFingerprint({ simulationFocus: 'relationships_social' }));
    assert.match(getCampaignReviewCriteria({ simulationFocus: 'relationships_social' }, 'time'), /Stable moods and relationships need no artificial timers/);
});

test('social prompt preserves agency, directional beliefs, nonreciprocity and causal memory', () => {
    const snapshot = freezeCampaignLayers({ simulationFocus: 'relationships_social' });
    for (const phrase of [
        'A recorded belief is true as a belief',
        "Store A's attitude toward B with A",
        'Mutual acquaintance does not establish mutual trust',
        'Do not invent shared history',
        'no new universal relationship score',
        'Stable moods and relationships need no artificial timers',
        'Record their explicitly supplied subjective state without inferring its unstated meaning',
        'Separately record and apply verified rules-imposed involuntary mental conditions',
        'Such a condition grants no unrelated feeling, devotion, knowledge or extra voluntary choice',
        'a mechanically altered memory does not rewrite objective history',
    ]) assert.ok((snapshot.instructions + '\n' + snapshot.reviewCriteria.time).includes(phrase), phrase);
});

test('unknown-version or malformed saved descriptors cannot be silently reinterpreted as current settings', () => {
    const frozen = freezeCampaignLayers({ simulationFocus: 'relationships_social' });
    assert.throws(() => campaignLayersFingerprint({ ...frozen, version: 99 }), /Unsupported campaign-layer/);
    assert.throws(() => getCampaignReviewCriteria({ ...frozen, version: 99 }, 'light'), /Unsupported campaign-layer/);
    assert.throws(() => campaignLayersFingerprint({ ...frozen, reviewCriteria: {} }), /Invalid campaign-layer/);
    assert.throws(() => campaignLayersFingerprint({ ...frozen, tier: 'remote' }), /Invalid campaign-layer/);
    assert.throws(() => getCampaignReviewCriteria({ ...frozen, simulationFocus: 'romance' }, 'time'), /Invalid campaign-layer/);
});

test('editable campaign sources match all generated bundle entries', async () => {
    for (const [id, text] of Object.entries(CAMPAIGN_PROMPTS)) {
        const source = await readFile(new URL('../prompts/campaign/' + id + '.md', import.meta.url), 'utf8');
        assert.equal(source.replace(/\r\n/g, '\n').trim(), text, id);
    }
});
