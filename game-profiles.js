import { composeCampaignLayers } from './campaign-layers.js';
import { resolveQualityPrompt } from './quality-source.js';
import { gameProfileText } from './game-profile-text.js';
export { resolveQualityPrompt } from './quality-source.js';
export { GAME_SYSTEMS, gameSystem, hasCalculatedProgression } from './game-system-registry.js';

export function composeGamePrompt(settings, presets) {
    const quality = resolveQualityPrompt(settings, presets);
    const campaignLayers = composeCampaignLayers(settings, quality);
    const rawProfile = gameProfileText(settings, quality.variant);
    const profile = rawProfile;
    const text = `${quality.base.trim()}\n\n---\n\n${profile.trim()}\n`;
    return { ...quality, rawBase: quality.base, base: campaignLayers.base, rawProfile, profile, campaignLayers,
        text: campaignLayers.instructions ? `${text}\n---\n\n${campaignLayers.instructions.trim()}\n` : text };
}

export const GENERIC_PROGRESSION_TOOL = 'MISC #character_progression stores the campaign’s own advancement record when applicable. Preserve earned changes, sources and pending choices; do not assume a particular game schema or automatic calculations. Update the character sheet together with applied advancement.';
