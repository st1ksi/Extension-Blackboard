import { SYSTEM_BUNDLES } from './prompts/system-bundles.js';

export const QUALITY_SEPARATION_VERSION = 1;
const normalized = text => String(text ?? '').replace(/\r\n/g, '\n').trim();
const defaultVariant = settings => settings.simulationFidelity === 'ultra' ? 'compact'
    : SYSTEM_BUNDLES[settings.simulationFidelity] ? settings.simulationFidelity : 'mid';

/** Exact source recognition upgrades known historical presets, never edits user text. */
export function resolveQualityPrompt(settings = {}, presets) {
    const custom = typeof settings.customPrompt === 'string' && settings.customPrompt.trim() ? settings.customPrompt : null;
    const fallback = presets
        ? presets[settings.simulationFidelity]?.prompt || presets.mid.prompt
        : SYSTEM_BUNDLES[defaultVariant(settings)].base;
    const source = custom ?? fallback;
    const found = Object.entries(SYSTEM_BUNDLES).find(([, bundle]) =>
        [bundle.base, bundle.legacy, ...(bundle.priorBases || [])].some(text => normalized(text) === normalized(source)));
    const variant = found?.[0] || (SYSTEM_BUNDLES[settings.systemPromptVariant] ? settings.systemPromptVariant : defaultVariant(settings));
    const separatedSource = !!found && (normalized(source) === normalized(found[1].base)
        || (found[1].separatedPriorIndices || []).some(index => normalized(source) === normalized(found[1].priorBases[index])));
    return { base: found ? found[1].base : source, variant, recognized: !!found, custom: !!custom,
        historical: !!found && normalized(source) !== normalized(found[1].base), separatedSource };
}

/**
 * Before this split, some built-in quality sources also chose tone/prose.
 * Preserve those choices once as explicit preferences. New installs already
 * carry this marker and keep all optional layers off until selected.
 */
export function migrateQualitySeparation(settings) {
    if (settings.qualitySeparationVersion === QUALITY_SEPARATION_VERSION) return false;
    if (Number(settings.qualitySeparationVersion) > QUALITY_SEPARATION_VERSION) {
        throw new Error('These Blackboard settings use a newer quality instruction format. Restore a compatible extension version.');
    }
    const quality = resolveQualityPrompt(settings);
    const selectedCustom = typeof settings.customPrompt === 'string' && settings.customPrompt.trim();
    // An already separated source has no former baked-in direction to migrate.
    const alreadySeparated = selectedCustom && quality.separatedSource;
    if (quality.recognized && !alreadySeparated) {
        const previous = SYSTEM_BUNDLES[quality.variant].qualityDefaults;
        if (previous) {
            if (settings.campaignTone == null || settings.campaignTone === 'inherit') settings.campaignTone = previous.campaignTone;
            if (settings.narrativeStyle == null || settings.narrativeStyle === 'inherit') settings.narrativeStyle = previous.narrativeStyle;
        }
    }
    settings.qualitySeparationVersion = QUALITY_SEPARATION_VERSION;
    return true;
}
