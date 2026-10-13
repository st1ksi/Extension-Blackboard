import { readFile, writeFile } from 'node:fs/promises';
// Ultra now uses the shared v6 base; keep its profile bundle in sync too.
await import('./sync-systems.mjs');
const prompt = await readFile(new URL('../prompts/systems/compact-base.md', import.meta.url), 'utf8');
const module = '// Default Ultra: shared v6 base from systems/compact-base.md. Run npm run sync-prompt after editing.\n'
    + `export const PROMPT_ULTRA = ${JSON.stringify(prompt)};\n`;
await writeFile(new URL('../prompts/ultra.js', import.meta.url), module, 'utf8');
console.log('Runtime prompt synchronized with Markdown (including line endings).');
