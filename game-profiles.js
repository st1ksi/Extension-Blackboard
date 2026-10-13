import { SYSTEM_BUNDLES } from './prompts/system-bundles.js';

export const GAME_SYSTEMS = Object.freeze({
    universal: { name: 'Universal', description: 'Uses your campaign rules. No automatic D&D XP, level or proficiency calculations. Existing world state is preserved.' },
    dnd5e: { name: 'D&D 5e', description: 'Uses the recorded 2014/2024 edition and campaign exceptions (2014 if unspecified). Includes the validated D&D advancement ledger.' },
});

export function gameSystem(settings = {}) {
    return settings.gameSystem === 'universal' ? 'universal' : 'dnd5e';
}

const normalized = text => String(text ?? '').replace(/\r\n/g, '\n').trim();

// Recognize only exact known sources. Never strip arbitrary user instructions by regex.
export function resolveQualityPrompt(settings, presets) {
    const custom = typeof settings.customPrompt === 'string' && settings.customPrompt.trim() ? settings.customPrompt : null;
    const fallback = presets[settings.simulationFidelity]?.prompt || presets.mid.prompt;
    const source = custom ?? fallback;
    const found = Object.entries(SYSTEM_BUNDLES).find(([, b]) => normalized(source) === normalized(b.legacy) || normalized(source) === normalized(b.base) || (b.priorBases || []).some(prior => normalized(source) === normalized(prior)));
    const defaultVariant = settings.simulationFidelity === 'ultra' ? 'compact' : settings.simulationFidelity;
    const variant = found?.[0] || (SYSTEM_BUNDLES[settings.systemPromptVariant] ? settings.systemPromptVariant : SYSTEM_BUNDLES[defaultVariant] ? defaultVariant : 'mid');
    return { base: found ? found[1].base : source, variant, recognized: !!found, custom: !!custom };
}

export function composeGamePrompt(settings, presets) {
    const quality = resolveQualityPrompt(settings, presets);
    const profile = SYSTEM_BUNDLES[quality.variant][gameSystem(settings)];
    return { ...quality, profile, text: `${quality.base.trim()}\n\n---\n\n${profile.trim()}\n` };
}

export const GENERIC_PROGRESSION_TOOL = 'MISC #character_progression stores the campaign’s own advancement record when applicable. Preserve earned changes, sources and pending choices; do not assume a particular game schema or automatic calculations. Update the character sheet together with applied advancement.';
