// Optional resolution policy: independent of quality, rules, genre and execution.
// A missing frozen descriptor means the feature was off, including older turns.
export const CONTEXTUAL_CHOICE_INSTRUCTIONS = `BLACKBOARD OPTIONAL RESOLUTION — CONTEXTUAL CHOICE ROLLS
Use this policy for genuinely open, locally meaningful alternatives after applying established reality and the campaign's rules. It includes an NPC's immediate response, willingness, boundary or conversational direction when it changes the interaction; it is not restricted to major world decisions. Do not roll for every sentence, decorative gesture or possible variation, and do not create a choice quota. A causally settled response needs no roll.

First apply the NPC's established motives, values, temperament, memories, current feelings, knowledge, obligations and practical constraints to the actual new situation. The player counts as an in-world participant with their actual conduct, reputation, relationships and leverage; favorability to the user is not a probability criterion. Do not favor agreeable outcomes or compensate with hostility. A surprising player proposal may require a new situated reaction, not a rewritten personality or a prewritten answer to every possible line. Inability to decide is not evidence that outcomes are equally likely. Use the game system's applicable check, opposed roll, table or explicit campaign procedure first; this option does not replace it or add a second chance to its resolved result. Preserve existing deterministic off-screen procedures, player agency and preparation horizons.

When several credible responses remain, define a small set of materially distinct, bounded alternatives and their relative likelihood BEFORE rolling. Each must fit the same established person and circumstances; no implausible option for drama or balance. Judge likelihood from in-world causes, not desired plot, player benefit, a good/bad-outcome quota or the number of paraphrases you can invent. Estimate weights for the underlying alternatives first; splitting one into several descriptions must not increase its collective chance. Use coarse weights proportionate to available grounds, not fabricated statistical precision. Equal weights are appropriate only when the grounds support roughly equal likelihood. If the necessary grounds are missing, preserve actual uncertainty or complete genuinely undefined preparation at its required time; a coin flip cannot substitute for reading or establishing the relevant person.

Use RollBlackboardDice with face_type:"symbol", one die and short outcome descriptions in faces. Repeat an entry to encode its relative weight; every listed entry is equally likely. Fix the full options, meanings and weights in the arguments before the tool runs. Follow the returned face_values, not its face index, and do not reinterpret a face after seeing it. Record the selected disposition/action and relevant cause in the existing authoritative owner block, then resolve its actual consequences. The arguments/receipt retain the alternatives; no permanent global alternatives registry is required. Carry that decision and its consequences into later reactions instead of independently rerolling a personality each line. No reroll or alternate dice source to improve a result; uncertain partial receipts remain binding recovery evidence.

World facts must still be prepared before their required contact: this policy may help choose genuinely undefined future preparation, but never generate closed contents when searched, change a root truth after discovery, invent a missing prerequisite after dependent dice, or reopen a resolved outcome. NPC decisions made in response to new information can be resolved now within their established dispositions. Technical requests, reviews, repairs and narration do not advance time or choose new alternatives; only the authorized simulation stage may request a new roll. Review/repair preserves received choices and fixes supported discrepancies without rerolling. Present observable behavior; private alternatives, motives and the unchosen branches are not automatically player knowledge.`;

const ASPECTS = ['time', 'continuity', 'reach', 'narration', 'combined'];
const COMMON_REVIEW = 'CONTEXTUAL CHOICE REVIEW: Report only an evidence-supported defect in the actual transition or receipt. This optional policy does not require a roll, exhaustive alternatives or a balanced share of player-favorable outcomes. Do not invent missing probabilities, replace a legitimate response with your preferred one, roll during review/repair or reopen binding outcomes.';
const CRITERIA = {
    time: 'Check that a choice roll or technical continuation was not counted as another world interval, action or agenda step; preserve actual decision timing, delays and interruptions.',
    continuity: 'For an actual contextual roll, compare its pre-roll alternatives/weights and selected face with established motives, knowledge and constraints, then the authoritative reaction and consequences. Look for unsupported personality rewrites, post-result reinterpretation, duplicate rerolls or splitting one outcome into extra weighted paraphrases. Player role/context matters; benefit or harm to the user alone is no causal basis.',
    reach: 'Distinguish a present NPC decision responding to new input from an already-existing world fact. A contextual roll cannot justify loot creation on search, a changed root truth or a prerequisite invented after dependent resolution. Complete genuinely undefined future contacts only at the selected preparation horizon; missing optional rolls or unenumerated future dialogue are not defects.',
    narration: 'Compare the visible response with the selected face, actual consequences and retained state. Check that unchosen alternatives, undiscovered motives or private decision grounds were not disclosed as player knowledge, and that narration did not select a second outcome or decide the player\'s voluntary response.',
};
CRITERIA.combined = ['time', 'continuity', 'reach', 'narration'].map(key => CRITERIA[key]).join('\n');

export function choiceResolutionInstructions(settings = {}) {
    return settings.contextualChoices === true ? CONTEXTUAL_CHOICE_INSTRUCTIONS : '';
}

export function freezeChoiceResolution(settings = {}) {
    if (settings.contextualChoices !== true) return undefined;
    return { version: 1, enabled: true, instructions: CONTEXTUAL_CHOICE_INSTRUCTIONS,
        reviewCriteria: Object.fromEntries(ASPECTS.map(key => [key, COMMON_REVIEW + '\n' + CRITERIA[key]])) };
}

/** Validate shape, retaining exact prior text for fingerprinted resume checks. */
export function validateChoiceResolution(value) {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || value.version !== 1 || value.enabled !== true
        || typeof value.instructions !== 'string' || !value.instructions.trim()
        || Object.keys(value).some(key => !['version', 'enabled', 'instructions', 'reviewCriteria'].includes(key))
        || !value.reviewCriteria || typeof value.reviewCriteria !== 'object' || Array.isArray(value.reviewCriteria)
        || Object.keys(value.reviewCriteria).some(key => !ASPECTS.includes(key))
        || ASPECTS.some(key => typeof value.reviewCriteria[key] !== 'string' || !value.reviewCriteria[key].trim())) {
        throw new Error('Unsupported or invalid contextual-choice instruction snapshot.');
    }
    return value;
}

export function choiceReviewCriteria(value, aspect = 'combined') {
    const descriptor = validateChoiceResolution(value);
    if (!descriptor) return '';
    const key = ['light', 'all', 'detect'].includes(aspect) ? 'combined' : aspect;
    return ASPECTS.includes(key) ? descriptor.reviewCriteria[key] : '';
}
