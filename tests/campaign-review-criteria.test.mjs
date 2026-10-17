import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeCampaignLayers, freezeCampaignLayers, composeCampaignLayers,
    getCampaignReviewCriteria, campaignLayersFingerprint,
} from '../campaign-layers.js';
import { REVIEW_STAGES, reviewProtocol } from '../review.js';

const styles = [
    ['deductive', /origin of its actual traces/, /feasible access to relevant information/],
    ['adventure', /usable approaches/, /terrain, barriers, capacities and consequences/],
    ['social_intrigue', /actual obligations and ability to influence events/, /information or decisions can travel/],
    ['exploration', /connected geography/, /access and travel conditions/],
    ['survival', /availability and access to resources or shelter/, /recorded rules/],
    ['slice_of_life', /routines, independent concerns, commitments/, /ordinary choices usable/],
];

test('each selected world style audits its own positive preparation task in existing reach and Light stages', () => {
    for (const [campaignStyle, duty, specific] of styles) {
        const frozen = freezeCampaignLayers({ campaignStyle, simulationFocus: 'general', gameSystem: 'universal' });
        for (const aspect of ['reach', 'light']) {
            const criterion = getCampaignReviewCriteria(frozen, aspect);
            assert.match(criterion, duty, campaignStyle + ' positive duty');
            assert.match(criterion, specific, campaignStyle + ' operational coverage');
            assert.match(criterion, /actually develops genuinely undefined circumstances/);
            assert.match(criterion, /quality instructions' real horizon/);
            assert.match(criterion, /fully constrained by prior canon.*may pass/);
            assert.match(criterion, /existing audit targets and evidence/);
            assert.match(criterion, /No scene, clue, danger, goodwill or emotional quota/);
            assert.match(criterion, /cannot be invented retrospectively/);
            assert.doesNotMatch(criterion, /SOCIAL FOCUS CHECK/);
        }
        assert.equal(getCampaignReviewCriteria(frozen, 'time'), '');
        assert.doesNotMatch(getCampaignReviewCriteria(frozen, 'continuity'), duty);
        assert.doesNotMatch(getCampaignReviewCriteria(frozen, 'narration'), duty);
    }
});

test('the three tones carry distinct positive preparation criteria without imposing an emotional event quota', () => {
    const expected = {
        balanced: /stakes and dispositions are proportionate/,
        grimdark: /concrete societal, material or personal causes and meaningful costs/,
        hopeful: /credible independent motives or practicable opportunities/,
    };
    const criteria = new Set();
    for (const [campaignTone, positiveDuty] of Object.entries(expected)) {
        const frozen = freezeCampaignLayers({ campaignTone });
        const reach = getCampaignReviewCriteria(frozen, 'reach');
        assert.match(reach, positiveDuty);
        assert.match(getCampaignReviewCriteria(frozen, 'light'), positiveDuty);
        assert.match(reach, /No scene, clue, danger, goodwill or emotional quota/);
        assert.match(reach, /Existing conditions need not exemplify the selected style/);
        criteria.add(reach);
        for (const unselected of Object.keys(expected).filter(id => id !== campaignTone)) {
            assert.doesNotMatch(reach, new RegExp(unselected.toUpperCase() + ' TONE PREPARATION'));
        }
    }
    assert.equal(criteria.size, 3);
});

test('selected prose requirements can fail conformance while prescribed correction remains presentation-only', () => {
    const expected = {
        concise: /concrete unnecessary repetition, restated scene summaries or ornamental passages/,
        evocative: /specific perceptible sensory details and distinct situated voices/,
    };
    for (const [narrativeStyle, positiveDuty] of Object.entries(expected)) {
        const frozen = freezeCampaignLayers({ narrativeStyle });
        for (const aspect of ['narration', 'light']) {
            const criterion = getCampaignReviewCriteria(frozen, aspect);
            assert.match(criterion, positiveDuty);
            assert.match(criterion, /PRESENTATION VERSUS WORLD DEFECTS/);
            assert.match(criterion, /candidate-prose-only repair using existing player-perceptible facts/);
            assert.match(criterion, /no board rewrite/);
            assert.match(criterion, /removed required information or extra elapsed time/);
            assert.match(criterion, /Record a supported world defect separately/);
            assert.match(criterion, /knowledge boundary and actual action boundary/);
        }
        for (const aspect of ['time', 'continuity', 'reach']) {
            assert.equal(getCampaignReviewCriteria(frozen, aspect), '');
        }
    }
    assert.match(getCampaignReviewCriteria({ narrativeStyle: 'concise' }, 'narration'), /longer answer needed for those duties is not a defect/);
    assert.match(getCampaignReviewCriteria({ narrativeStyle: 'evocative' }, 'narration'), /voice when no one speaks/);
});

test('Heavy and Light receive the new criteria through their original protocol with no stage/schema additions', () => {
    const frozen = freezeCampaignLayers({ campaignStyle: 'deductive', campaignTone: 'hopeful', narrativeStyle: 'concise' });
    assert.deepEqual(REVIEW_STAGES.map(stage => stage.id), ['time', 'continuity', 'reach', 'narration']);
    const heavyReach = reviewProtocol('reach', 'detect', frozen);
    const heavyNarration = reviewProtocol('narration', 'detect', frozen);
    const light = reviewProtocol('light', 'detect', frozen);
    assert.match(heavyReach, /DEDUCTIVE PREPARATION/);
    assert.match(heavyReach, /HOPEFUL TONE PREPARATION/);
    assert.doesNotMatch(heavyReach, /CONCISE PRESENTATION/);
    assert.match(heavyNarration, /CONCISE PRESENTATION/);
    assert.doesNotMatch(heavyNarration, /DEDUCTIVE PREPARATION/);
    for (const part of ['DEDUCTIVE PREPARATION', 'HOPEFUL TONE PREPARATION', 'CONCISE PRESENTATION']) assert.ok(light.includes(part));
    assert.match(light, /"problem":"Specific discrepancy and consequence","repair":"Minimal correction supported by existing facts"/);
    const verification = reviewProtocol('reach', 'verify', frozen);
    assert.match(verification, /VERIFY RECORDED REPAIRS/);
    assert.match(verification, /DEDUCTIVE PREPARATION/);
});

test('new freezes retain exact selected criteria while saved earlier criteria are not regenerated', () => {
    const current = freezeCampaignLayers({ campaignStyle: 'deductive', narrativeStyle: 'concise' });
    const older = structuredClone(current);
    older.reviewCriteria.reach = 'Old frozen negative-only criterion.';
    older.reviewCriteria.narration = 'Old frozen presentation criterion.';
    older.reviewCriteria.combined = 'Old combined criterion.';
    const restored = JSON.parse(JSON.stringify(older));
    assert.equal(getCampaignReviewCriteria(restored, 'reach'), older.reviewCriteria.reach);
    assert.equal(getCampaignReviewCriteria(restored, 'narration'), older.reviewCriteria.narration);
    assert.equal(getCampaignReviewCriteria(restored, 'light'), older.reviewCriteria.combined);
    assert.notEqual(campaignLayersFingerprint(current), campaignLayersFingerprint(restored));
    assert.match(current.reviewCriteria.reach, /DEDUCTIVE PREPARATION/);
    assert.match(current.reviewCriteria.narration, /CONCISE PRESENTATION/);
    assert.equal(campaignLayersFingerprint(older), campaignLayersFingerprint(restored));
});

test('unselected modes remain absent and arbitrary custom quality is append-only and unchanged', () => {
    const customPrompt = 'User campaign quality: prepare only one contact; keep this exact source.\n';
    const settings = {
        customPrompt, gameSystem: 'universal', campaignStyle: 'exploration',
        campaignTone: 'balanced', narrativeStyle: 'evocative',
    };
    const before = JSON.stringify(settings);
    const composed = composeCampaignLayers(settings);
    assert.equal(composed.base, customPrompt);
    assert.equal(composed.snapshot.qualitySource.text, customPrompt);
    assert.equal(composed.snapshot.tier, 'custom');
    assert.match(getCampaignReviewCriteria(composed.snapshot, 'reach'), /EXPLORATION PREPARATION/);
    assert.doesNotMatch(getCampaignReviewCriteria(composed.snapshot, 'reach'), /DEDUCTIVE PREPARATION|SOCIAL INTRIGUE PREPARATION/);
    assert.equal(JSON.stringify(settings), before);
    const allDefaults = freezeCampaignLayers(normalizeCampaignLayers({}));
    assert.deepEqual(Object.values(allDefaults.reviewCriteria), ['', '', '', '', '']);
});
