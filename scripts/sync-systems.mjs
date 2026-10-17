import { readFile, writeFile } from 'node:fs/promises';
await import('./sync-game-profiles.mjs');
const directory = new URL('../prompts/systems/', import.meta.url);
const legacy = JSON.parse(await readFile(new URL('legacy.json', directory), 'utf8'));
const priorBases = JSON.parse(await readFile(new URL('prior-bases.json', directory), 'utf8'));
const separatedPriorIndices = JSON.parse(await readFile(new URL('separated-prior-indices.json', directory), 'utf8'));
// Historical built-in intent is migrated into explicit campaign settings once.
// It is not an instruction to rewrite the quality source at generation time.
const qualityDefaults = JSON.parse(await readFile(new URL('quality-defaults.json', directory), 'utf8'));
const universal = await readFile(new URL('universal.md', directory), 'utf8');
const dndCore = await readFile(new URL('dnd5e-core.md', directory), 'utf8');
const bundles = {};
const currentExports = {
    low: 'PROMPT_1_LOW_LEAN.md',
    mid: 'PROMPT_2_MID_BALANCED.md',
    high: 'PROMPT_3_HIGH_DEEP.md',
    compact: 'PROMPT_4_ULTRA_LIVING_WORLD.md',
};
for (const [id, original] of Object.entries(legacy)) {
    // Lower tiers share the same mechanics/schema in a shorter game supplement.
    // Keep per-tier editable previews in sync; edit dnd5e-core.md as their source.
    if (['low', 'mid', 'high'].includes(id)) await writeFile(new URL(`${id}-dnd5e.md`, directory), dndCore, 'utf8');
    bundles[id] = { legacy: original, priorBases: Array.isArray(priorBases[id]) ? priorBases[id] : [priorBases[id]],
        separatedPriorIndices: separatedPriorIndices[id] || [],
        qualityDefaults: qualityDefaults[id],
        base: await readFile(new URL(`${id}-base.md`, directory), 'utf8'),
        dnd5e: await readFile(new URL(`${id}-dnd5e.md`, directory), 'utf8'), universal };
    // Unversioned exports are current quality-only sources, not stale full prompts.
    // Explicitly versioned Markdown files remain historical references.
    if (currentExports[id]) await writeFile(new URL(`../${currentExports[id]}`, directory), bundles[id].base, 'utf8');
}
await writeFile(new URL('../prompts/system-bundles.js', import.meta.url),
    '// Generated prompt bundles; rebuild with scripts/sync-systems.mjs.\nexport const SYSTEM_BUNDLES = ' + JSON.stringify(bundles, null, 2) + ';\n');
