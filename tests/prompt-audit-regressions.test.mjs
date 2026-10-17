// Composition and migration guarantees; these checks do not simulate a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_BUNDLES } from '../prompts/system-bundles.js';
import { GAME_PROFILE_PROMPTS } from '../prompts/game-profile-bundles.js';
import { GAME_SYSTEMS } from '../game-system-registry.js';
import { composeGamePrompt } from '../game-profiles.js';
import { resolveQualityPrompt, migrateQualitySeparation } from '../quality-source.js';

test('every selected game receives shared receipts and choice rules exactly once, with the correct advancement owner', () => {
    for (const [variant, bundle] of Object.entries(SYSTEM_BUNDLES)) {
        for (const gameSystem of Object.keys(GAME_SYSTEMS)) {
            const settings = { simulationFidelity: variant === 'compact' ? 'ultra' : variant,
                customPrompt: bundle.base, gameSystem };
            const result = composeGamePrompt(settings);
            assert.equal(result.profile.split(GAME_PROFILE_PROMPTS.common.trim()).length - 1, 1, `${variant}/${gameSystem}`);
            assert.equal(result.campaignLayers.snapshot.gameProfile.text, result.profile);
            assert.match(result.profile, /individual dice/);
            assert.match(result.profile, /every original\/replacement receipt/);
            assert.match(result.profile, /optional player choice stays a choice/);
            if (gameSystem === 'dnd5e') {
                assert.doesNotMatch(result.profile, /\[CAMPAIGN-OWNED ADVANCEMENT\]|does NOT calculate this profile's progression/);
                assert.match(result.profile, /"version":\s*1/);
            } else {
                assert.equal(result.profile.split(GAME_PROFILE_PROMPTS.advancement.trim()).length - 1, 1);
                assert.match(result.profile, /does NOT calculate this profile's progression/);
                assert.doesNotMatch(result.profile, /\[GAME SYSTEM PROFILE — D&D|"base_xp"/);
            }
        }
    }
});

test('D&D default off-screen initiative has the same bonus-aware order at every supported quality', () => {
    for (const [variant, bundle] of Object.entries(SYSTEM_BUNDLES)) {
        assert.match(bundle.dnd5e, /descending total initiative modifier \(including applicable bonuses\), then descending Dexterity score, then stable actor ID/, variant);
        assert.match(bundle.dnd5e, /recorded deterministic convention/, variant);
        assert.doesNotMatch(bundle.dnd5e, /initiative (?:ordering )?by Dexterity then actor ID/, variant);
    }
});

test('previous separated built-in sources upgrade without reintroducing historical tone or changing saved custom text', () => {
    for (const [variant, bundle] of Object.entries(SYSTEM_BUNDLES)) {
        assert.ok(bundle.separatedPriorIndices.length, variant);
        for (const index of bundle.separatedPriorIndices) {
            const customPrompt = bundle.priorBases[index].replace(/\r?\n/g, '\r\n');
            const settings = { simulationFidelity: ['compact', 'ultra'].includes(variant) ? 'ultra' : variant,
                customPrompt, campaignTone: 'inherit', narrativeStyle: 'inherit' };
            const quality = resolveQualityPrompt(settings);
            assert.equal(quality.variant, variant);
            assert.equal(quality.separatedSource, true);
            assert.equal(quality.base, bundle.base);
            assert.equal(migrateQualitySeparation(settings), true);
            assert.equal(settings.customPrompt, customPrompt);
            assert.equal(settings.campaignTone, 'inherit');
            assert.equal(settings.narrativeStyle, 'inherit');
            assert.equal(migrateQualitySeparation(settings), false);
        }
    }
});

test('older combined built-ins still migrate their former tone while arbitrary custom sources remain intact', () => {
    for (const source of [SYSTEM_BUNDLES.low.legacy, SYSTEM_BUNDLES.low.priorBases[0]]) {
        const settings = { simulationFidelity: 'low', customPrompt: source };
        migrateQualitySeparation(settings);
        assert.equal(settings.campaignTone, 'inherit');
        assert.equal(settings.narrativeStyle, 'evocative');
    }
    for (const variant of ['compact', 'ultra']) {
        const settings = { simulationFidelity: 'ultra', customPrompt: SYSTEM_BUNDLES[variant].legacy };
        migrateQualitySeparation(settings);
        assert.equal(settings.campaignTone, 'grimdark');
        assert.equal(settings.narrativeStyle, 'evocative');
    }
    const customPrompt = 'My world has faction alertness 0–100 and unusual social rules. Preserve this custom source.';
    const settings = { simulationFidelity: 'ultra', customPrompt };
    migrateQualitySeparation(settings);
    assert.equal(resolveQualityPrompt(settings).base, customPrompt);
    assert.equal(resolveQualityPrompt(settings).recognized, false);
    assert.equal(settings.customPrompt, customPrompt);
});
