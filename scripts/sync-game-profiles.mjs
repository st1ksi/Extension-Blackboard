import { readFile, writeFile } from 'node:fs/promises';
const directory = new URL('../prompts/systems/', import.meta.url);
const ids = ['coc7e', 'pf2e', 'gurps4e', 'cyberpunk_red', 'vtm5e', 'swade'];
const entries = [
    ['common', await readFile(new URL('game-common.md', directory), 'utf8')],
    ['advancement', await readFile(new URL('game-advancement.md', directory), 'utf8')],
];
for (const id of ids) entries.push([id, await readFile(new URL(`${id}.md`, directory), 'utf8')]);
await writeFile(new URL('../prompts/game-profile-bundles.js', import.meta.url),
    '// Generated game supplements; rebuild with scripts/sync-game-profiles.mjs.\nexport const GAME_PROFILE_PROMPTS = ' + JSON.stringify(Object.fromEntries(entries), null, 2) + ';\n');
