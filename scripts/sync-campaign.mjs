import { readFile, writeFile } from 'node:fs/promises';

const directory = new URL('../prompts/campaign/', import.meta.url);
const ids = [
    'contract', 'relationships-social',
    'social-depth-low', 'social-depth-mid', 'social-depth-high', 'social-depth-ultra', 'social-depth-custom',
    'review-social-time', 'review-social-continuity', 'review-social-reach', 'review-social-narration', 'review-social-combined',
    'style-deductive', 'style-adventure', 'style-social-intrigue', 'style-exploration', 'style-survival', 'style-slice-of-life',
    'tone-balanced', 'tone-grimdark', 'tone-hopeful', 'narration-concise', 'narration-evocative',
];
const bundle = Object.fromEntries(await Promise.all(ids.map(async id =>
    [id, (await readFile(new URL(id + '.md', directory), 'utf8')).replace(/\r\n/g, '\n').trim()])));
await writeFile(new URL('../prompts/campaign-bundle.js', import.meta.url),
    '// Generated campaign layers; rebuild with scripts/sync-campaign.mjs.\nexport const CAMPAIGN_PROMPTS = ' + JSON.stringify(bundle, null, 2) + ';\n');
