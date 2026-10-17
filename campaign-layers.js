import { CAMPAIGN_PROMPTS } from './prompts/campaign-bundle.js';
import { SYSTEM_BUNDLES } from './prompts/system-bundles.js';
import { resolveQualityPrompt, QUALITY_SEPARATION_VERSION } from './quality-source.js';
import { GAME_SYSTEMS, gameSystem } from './game-system-registry.js';
import { gameProfileText } from './game-profile-text.js';

const option = (id, label, description) => Object.freeze({ id, label, description });
export const CAMPAIGN_LAYER_OPTIONS = Object.freeze({
    simulationFocus: Object.freeze([
        option('general', 'General', 'Use the quality tier\'s regular preparation of people and the world.'),
        option('relationships_social', 'Relationships & Social', 'Deepen relevant psychology, significant memories and directed relationships. Does not imply romance.'),
    ]),
    campaignStyle: Object.freeze([
        option('inherit', 'No additional style', 'Add no world-style instructions; follow the existing campaign sources.'),
        option('deductive', 'Deductive', 'Investigable causes, evidence and information routes; no forced detective role.'),
        option('adventure', 'Adventure', 'Varied places, obstacles and consequential action; no mandatory hero role or combat.'),
        option('social_intrigue', 'Social intrigue', 'Intersecting interests, institutions and information; not universal betrayal.'),
        option('exploration', 'Exploration', 'Connected geography, discovery and routes; no required expedition or discovery quota.'),
        option('survival', 'Survival', 'Practical environment, supply and shelter tradeoffs under actual campaign rules.'),
        option('slice_of_life', 'Everyday life', 'Routines, local concerns and shared activities; no compulsory romance or crisis.'),
    ]),
    campaignTone: Object.freeze([
        option('inherit', 'No additional tone', 'Add no tone instructions; follow the existing campaign sources. Quality presets do not choose a tone.'),
        option('balanced', 'Balanced', 'Allow warmth, hardship and ordinary life as circumstances warrant.'),
        option('grimdark', 'Grimdark', 'Credible harshness and moral pressure, without arbitrary punishment or universal betrayal.'),
        option('hopeful', 'Hopeful', 'Credible goodwill and possibilities for improvement, without guaranteed success.'),
    ]),
    narrativeStyle: Object.freeze([
        option('inherit', 'No additional narration', 'Add no prose-style instructions; follow the existing presentation sources.'),
        option('concise', 'Concise', 'Compact, specific prose while preserving required information and mechanics.'),
        option('evocative', 'Evocative', 'Vivid sensory detail and distinct voices grounded in perceptible reality.'),
    ]),
});

const DEFAULTS = Object.freeze({ simulationFocus: 'general', campaignStyle: 'inherit', campaignTone: 'inherit', narrativeStyle: 'inherit' });

export function normalizeCampaignLayers(settings = {}) {
    return Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => [
        key, CAMPAIGN_LAYER_OPTIONS[key].some(item => item.id === settings?.[key]) ? settings[key] : fallback,
    ]));
}

export function isDefaultCampaignLayers(settings = {}) {
    const selected = normalizeCampaignLayers(settings);
    return Object.keys(DEFAULTS).every(key => selected[key] === DEFAULTS[key]);
}

function socialTier(settings = {}, quality = resolveQualityPrompt(settings)) {
    if (quality.custom) {
        if (!quality.recognized) return 'custom';
        return ['compact', 'ultra'].includes(quality.variant) ? 'ultra' : quality.variant;
    }
    return ['low', 'mid', 'high', 'ultra', 'custom'].includes(settings?.simulationFidelity)
        ? settings.simulationFidelity : 'mid';
}

const STYLE_PREPARATION_CHECKS = Object.freeze({
    deductive: 'DEDUCTIVE PREPARATION: For an investigable situation, check the committed origin of its actual traces, evidence versus testimony, and feasible access to relevant information, including available alternative routes. Culprit/time alone do not prepare how evidence arose or can be found. No compulsory mystery or conspiracy.',
    adventure: 'ADVENTURE PREPARATION: For travel, obstacles or consequential action, check concrete stakes, usable approaches and relevant terrain, barriers, capacities and consequences. A genre label is insufficient. Preserve possible avoidance, negotiation and retreat; no required quest, combat, reward or heroic player role.',
    social_intrigue: 'SOCIAL INTRIGUE PREPARATION: For intersecting interests or institutional dealings, check motives, actual obligations and ability to influence events, knowledge, and how information or decisions can travel. Prepare actionable cooperation, disagreement or discovery; no required deception, betrayal or player allegiance.',
    exploration: 'EXPLORATION PREPARATION: For places or routes, check connected geography, access and travel conditions, and discoverable environmental or inhabited features/patterns. Available approaches must be usable at the quality horizon, not disconnected scenery. No compulsory discovery, danger or treasure.',
    survival: 'SURVIVAL PREPARATION: For environmental or supply tradeoffs, check conditions, availability and access to resources or shelter, and applicable deterioration, exposure, travel costs and practical alternatives under the recorded rules. No invented scarcity, upkeep mechanics or hazard to supply a problem.',
    slice_of_life: 'EVERYDAY LIFE PREPARATION: For daily-life participants, places or activities, check routines, independent concerns, commitments and practical constraints that make ordinary choices usable. Locally meaningful consequences can suffice; a genre label does not prepare an activity. No compulsory crisis, romance or transformation.',
});

const TONE_PREPARATION_CHECKS = Object.freeze({
    balanced: 'BALANCED TONE PREPARATION: Check that newly developed stakes and dispositions are proportionate to the setting and allow credible ordinary life, warmth, hardship or humor as applicable, not a uniformly extreme emotional register. No required mixture, alternating good/bad events or softening established hardship.',
    grimdark: 'GRIMDARK TONE PREPARATION: Check applicable harshness or moral pressure for concrete societal, material or personal causes and meaningful costs, not dark adjectives alone. No required cruelty, corruption, betrayal or suffering in every contact; preserve real relief and valid solutions.',
    hopeful: 'HOPEFUL TONE PREPARATION: Among compatible undefined conditions, check that preparation favors credible independent motives or practicable opportunities for goodwill, solidarity or improvement. Removing harsh adjectives alone is insufficient. No required benefactor, rescue, forgiveness or success; established adversaries and hardship remain real.',
});

const NARRATION_CONFORMANCE_CHECKS = Object.freeze({
    concise: 'CONCISE PRESENTATION: Check compact, specific delivery of perceptible changes, relevant speech, spatial information and the next decision. Cite concrete unnecessary repetition, restated scene summaries or ornamental passages that materially defeat this requirement. Preserve required mechanics, item details, status and useful sensory information; a longer answer needed for those duties is not a defect.',
    evocative: 'EVOCATIVE PRESENTATION: Check specific perceptible sensory details and distinct situated voices where the established scene/dialogue offers a meaningful opportunity. Cite an unfulfilled presentation task, such as generic mood labels or interchangeable speech. No extra-description quota or voice when no one speaks; preserve mechanical clarity.',
});

function reviewCriteria(selected) {
    const social = selected.simulationFocus === 'relationships_social';
    const worldDirection = selected.campaignStyle !== 'inherit' || selected.campaignTone !== 'inherit';
    const result = {};
    for (const aspect of ['time', 'continuity', 'reach', 'narration', 'combined']) {
        const criteria = [];
        if (social) criteria.push(CAMPAIGN_PROMPTS['review-social-' + aspect]);
        if (worldDirection && ['reach', 'combined'].includes(aspect)) {
            criteria.push('WORLD-PREPARATION APPLICABILITY: Check positive duties only where this turn actually develops genuinely undefined circumstances within the quality instructions\' real horizon and canon. Cite the surface and missing operational detail through existing audit targets and evidence. A scene fully constrained by prior canon or justified unchanged state may pass. No scene, clue, danger, goodwill or emotional quota. Missing prerequisites of resolved results cannot be invented retrospectively; complete only genuinely undefined future contacts.');
            if (selected.campaignStyle !== 'inherit') criteria.push(STYLE_PREPARATION_CHECKS[selected.campaignStyle]);
            if (selected.campaignTone !== 'inherit') criteria.push(TONE_PREPARATION_CHECKS[selected.campaignTone]);
        }
        if (worldDirection && ['continuity', 'reach', 'narration', 'combined'].includes(aspect)) {
            criteria.push('CAMPAIGN LAYER CHECK: Find unsupported changes or lost established facts, manufactured prerequisites/outcomes and forced player roles or choices. Explicit user-authorized campaign edits remain valid. Existing conditions need not exemplify the selected style; missing optional drama, romance, darkness or optimism is not itself a defect.');
        }
        if (selected.narrativeStyle !== 'inherit' && ['narration', 'combined'].includes(aspect)) {
            criteria.push(NARRATION_CONFORMANCE_CHECKS[selected.narrativeStyle]);
            criteria.push('PRESENTATION VERSUS WORLD DEFECTS: Label presentation-only nonconformance in existing issue problem/repair text and prescribe candidate-prose-only repair using existing player-perceptible facts: no board rewrite, invented fact, additional speech content/action, changed result, removed required information or extra elapsed time. Preserve speech meaning, the knowledge boundary and actual action boundary. Record a supported world defect separately; shortening prose cannot repair it. Apply the selected requirement, not a personal prose preference.');
        }
        result[aspect] = criteria.join('\n\n');
    }
    return result;
}

/** A serializable, exact-text instruction snapshot. No host or preset imports are needed. */
export function freezeCampaignLayers(settings = {}, quality = resolveQualityPrompt(settings)) {
    const selected = normalizeCampaignLayers(settings);
    const tier = socialTier(settings, quality);
    const profileId = gameSystem(settings);
    const pieces = [];
    const active = !isDefaultCampaignLayers(selected);
    if (active) pieces.push(CAMPAIGN_PROMPTS.contract);
    if (selected.simulationFocus === 'relationships_social') {
        pieces.push(CAMPAIGN_PROMPTS['relationships-social'], CAMPAIGN_PROMPTS['social-depth-' + tier]);
    }
    if (selected.campaignStyle !== 'inherit') pieces.push(CAMPAIGN_PROMPTS['style-' + selected.campaignStyle.replaceAll('_', '-')]);
    if (selected.campaignTone !== 'inherit') pieces.push(CAMPAIGN_PROMPTS['tone-' + selected.campaignTone]);
    if (selected.narrativeStyle !== 'inherit') pieces.push(CAMPAIGN_PROMPTS['narration-' + selected.narrativeStyle]);
    return {
        version: 2,
        qualitySeparationVersion: QUALITY_SEPARATION_VERSION,
        qualitySource: { revision: QUALITY_SEPARATION_VERSION, variant: quality.variant, text: quality.base },
        gameProfile: { id: profileId, text: gameProfileText(settings, quality.variant) },
        ...selected,
        tier,
        instructions: pieces.join('\n\n'),
        reviewCriteria: reviewCriteria(selected),
    };
}

function frozenOrSettings(value) {
    const snapshotShaped = value && typeof value === 'object' && ('instructions' in value || 'reviewCriteria' in value);
    if (!snapshotShaped) return freezeCampaignLayers(value);
    if (value.version !== 2) throw new Error('Unsupported campaign-layer snapshot version: ' + String(value.version));
    const selected = normalizeCampaignLayers(value);
    if (typeof value.instructions !== 'string' || value.qualitySeparationVersion !== QUALITY_SEPARATION_VERSION
        || value.qualitySource?.revision !== QUALITY_SEPARATION_VERSION
        || !SYSTEM_BUNDLES[value.qualitySource?.variant] || typeof value.qualitySource?.text !== 'string'
        || !Object.hasOwn(GAME_SYSTEMS, value.gameProfile?.id) || typeof value.gameProfile?.text !== 'string'
        || !['low', 'mid', 'high', 'ultra', 'custom'].includes(value.tier)
        || Object.keys(DEFAULTS).some(key => value[key] !== selected[key])
        || !value.reviewCriteria || ['time', 'continuity', 'reach', 'narration', 'combined'].some(key => typeof value.reviewCriteria[key] !== 'string')) {
        throw new Error('Invalid campaign-layer instruction snapshot.');
    }
    return value;
}

/** Retain the saved criteria when a resumed turn was created under an older prompt bundle. */
export function getCampaignReviewCriteria(settingsOrFrozen = {}, aspect = 'combined') {
    const snapshot = frozenOrSettings(settingsOrFrozen);
    const key = ['light', 'all', 'detect'].includes(aspect) ? 'combined' : aspect;
    return typeof snapshot.reviewCriteria[key] === 'string' ? snapshot.reviewCriteria[key] : '';
}

/** Canonical exact representation for equality, not a security hash. */
export function campaignLayersFingerprint(settingsOrFrozen = {}) {
    const snapshot = frozenOrSettings(settingsOrFrozen);
    return JSON.stringify({
        version: snapshot.version,
        qualitySeparationVersion: snapshot.qualitySeparationVersion,
        qualitySource: { revision: snapshot.qualitySource.revision, variant: snapshot.qualitySource.variant, text: snapshot.qualitySource.text },
        gameProfile: { id: snapshot.gameProfile.id, text: snapshot.gameProfile.text },
        ...normalizeCampaignLayers(snapshot),
        tier: snapshot.tier,
        instructions: snapshot.instructions,
        reviewCriteria: Object.fromEntries(['time', 'continuity', 'reach', 'narration', 'combined'].map(key => [key, getCampaignReviewCriteria(snapshot, key)])),
    });
}

/** Compose independent append-only layers. The quality source is never rewritten. */
export function composeCampaignLayers(settings = {}, qualityInfo = {}) {
    const resolved = resolveQualityPrompt(settings);
    const quality = { ...resolved, ...qualityInfo };
    const snapshot = freezeCampaignLayers(settings, quality);
    return {
        base: quality.base,
        instructions: snapshot.instructions,
        snapshot,
        focus: snapshot.simulationFocus,
        style: snapshot.campaignStyle,
        tone: snapshot.campaignTone,
        narration: snapshot.narrativeStyle,
        social: snapshot.simulationFocus === 'relationships_social',
        changed: !isDefaultCampaignLayers(snapshot),
        metadata: {
            version: 2,
            tier: snapshot.tier,
            knownQuality: quality.recognized ? quality.variant : null,
            customQualityPreserved: resolved.custom && !resolved.recognized,
        },
    };
}
