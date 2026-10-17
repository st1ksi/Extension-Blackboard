import { SYSTEM_BUNDLES } from './prompts/system-bundles.js';
import { GAME_PROFILE_PROMPTS } from './prompts/game-profile-bundles.js';
import { gameSystem } from './game-system-registry.js';

export function gameProfileText(settings, qualityVariant) {
    const id = gameSystem(settings);
    const text = id === 'universal' || id === 'dnd5e'
        ? SYSTEM_BUNDLES[qualityVariant][id] : GAME_PROFILE_PROMPTS[id];
    if (typeof text !== 'string' || !text.trim()) throw new Error(`Game profile instructions are unavailable: ${id}. Restore the complete extension package.`);
    const common = GAME_PROFILE_PROMPTS.common;
    const advancement = id === 'dnd5e' ? '' : GAME_PROFILE_PROMPTS.advancement;
    if (typeof common !== 'string' || !common.trim()
        || (id !== 'dnd5e' && (typeof advancement !== 'string' || !advancement.trim()))) {
        throw new Error('Shared game profile instructions are unavailable. Restore the complete extension package.');
    }
    return [common, text, advancement].filter(Boolean).map(part => part.trim()).join('\n\n') + '\n';
}
