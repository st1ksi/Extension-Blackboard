// IDs are persisted in chat preferences and private snapshots. Do not reuse an ID
// for a different rules edition or silently reinterpret unknown future profiles.
export const GAME_SYSTEMS = Object.freeze({
    universal: Object.freeze({ name: 'Universal', progression: 'campaign', description: 'Uses your campaign rules. No automatic game-specific advancement calculations. Existing world state is preserved.' }),
    dnd5e: Object.freeze({ name: 'D&D 5e (2014 / 2024)', progression: 'dnd5e', description: 'Uses the recorded 2014/2024 edition and campaign exceptions (2014 if unspecified). Includes the validated D&D advancement ledger.' }),
    coc7e: Object.freeze({ name: 'Call of Cthulhu 7e', progression: 'campaign', description: 'Standard 7e core unless an introductory source is already selected. Percentile skills, Sanity and development. Uses a declared closed-world Luck house policy: prepared facts stay fixed; external fact creation requires a scoped campaign agreement. No built-in advancement calculator.' }),
    pf2e: Object.freeze({ name: 'Pathfinder 2e Remaster', progression: 'campaign', description: 'Four degrees of success, three-action turns, proficiency, conditions and Pathfinder advancement. Records source and legacy exceptions; no D&D advancement calculator.' }),
    gurps4e: Object.freeze({ name: 'GURPS 4e', progression: 'campaign', description: 'Fourth Edition Basic Set unless another source such as Lite is already selected. 3d6 checks, active defenses, one-second turns, injury and character points. Luck uses agreed time of play, separately from world time; no automatic point-cost calculator.' }),
    cyberpunk_red: Object.freeze({ name: 'Cyberpunk RED', progression: 'campaign', description: 'd10 checks, range defenses, armor ablation, wounds, Humanity and Improvement Points. Does not assume Cyberpunk 2020, the Edgerunners kit or a particular setting.' }),
    vtm5e: Object.freeze({ name: 'Vampire: The Masquerade V5', progression: 'campaign', description: 'Distinct regular and Hunger dice, criticals, Rouse Checks, Health, Willpower and Humanity. Uses recorded V5 sources; no automatic experience-cost calculator.' }),
    swade: Object.freeze({ name: 'Savage Worlds Adventure Edition', progression: 'campaign', description: 'Trait/Wild dice, Aces, Bennies, Wounds and action cards. A real card source or declared random mapping is required for initiative; story-detail spending needs an explicit campaign agreement.' }),
});

export function gameSystem(settings = {}) {
    const id = typeof settings === 'string' ? settings : settings?.gameSystem ?? 'dnd5e';
    if (!Object.hasOwn(GAME_SYSTEMS, id)) throw new Error(`Unsupported Blackboard game profile: ${String(id)}. Choose a supported profile without converting existing campaign state.`);
    return id;
}

export function hasCalculatedProgression(settings = {}) {
    return GAME_SYSTEMS[gameSystem(settings)].progression === 'dnd5e';
}
