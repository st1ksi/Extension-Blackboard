import { readFile, writeFile } from 'node:fs/promises';
const directory = new URL('../prompts/systems/', import.meta.url);
const legacy = JSON.parse(await readFile(new URL('legacy.json', directory), 'utf8'));
const priorBases = JSON.parse(await readFile(new URL('prior-bases.json', directory), 'utf8'));
const universal = await readFile(new URL('universal.md', directory), 'utf8');
const dndCore = await readFile(new URL('dnd5e-core.md', directory), 'utf8');
const bundles = {};
for (const [id, original] of Object.entries(legacy)) {
    // Lower tiers share the same mechanics/schema in a shorter game supplement.
    // Keep per-tier editable previews in sync; edit dnd5e-core.md as their source.
    if (['low', 'mid', 'high'].includes(id)) await writeFile(new URL(`${id}-dnd5e.md`, directory), dndCore, 'utf8');
    bundles[id] = { legacy: original, priorBases: Array.isArray(priorBases[id]) ? priorBases[id] : [priorBases[id]],
        base: await readFile(new URL(`${id}-base.md`, directory), 'utf8'),
        dnd5e: await readFile(new URL(`${id}-dnd5e.md`, directory), 'utf8'), universal };
}
await writeFile(new URL('../prompts/system-bundles.js', import.meta.url),
    '// Generated prompt bundles; rebuild with scripts/sync-systems.mjs.\nexport const SYSTEM_BUNDLES = ' + JSON.stringify(bundles, null, 2) + ';\n');
