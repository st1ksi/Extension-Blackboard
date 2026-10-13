import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SYSTEM_BUNDLES } from '../prompts/system-bundles.js';
import { composeGamePrompt } from '../game-profiles.js';
import { applyUpdate, readProgression, validateBoard } from '../state.js';
import { DraftTurn, processRegister } from '../transaction.js';

const tiers = ['low', 'mid', 'high'];
const presets = Object.fromEntries(Object.entries(SYSTEM_BUNDLES).map(([id, bundle]) => [id, { prompt: bundle.base }]));
const sourceFile = name => readFile(new URL(`../prompts/systems/${name}`, import.meta.url), 'utf8');
const fencedJson = text => [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
const progressionBlock = value => '[MISC #character_progression]\n```json\n' + JSON.stringify(value) + '\n```';

for (const tier of tiers) {
    for (const gameSystem of ['universal', 'dnd5e']) {
        test(`${tier}/${gameSystem}: every archived known prompt migrates at composition without rewriting settings`, async () => {
            const bundle = SYSTEM_BUNDLES[tier];
            const expectedBase = await sourceFile(`${tier}-base.md`);
            const originals = [bundle.legacy, ...(bundle.priorBases || [])];
            assert.ok(originals.length > 1, 'Migration must cover the formerly active base as well as the original prompt');
            for (const original of originals) {
                // Saved custom editors may retain CRLF and a trailing newline.
                for (const savedText of [original, original.replace(/\r?\n/g, '\r\n') + '\r\n']) {
                    const settings = Object.freeze({ simulationFidelity: tier, gameSystem, customPrompt: savedText });
                    const before = JSON.stringify(settings);
                    const composed = composeGamePrompt(settings, presets);
                    assert.equal(composed.recognized, true);
                    assert.equal(composed.variant, tier);
                    assert.equal(composed.base, expectedBase);
                    assert.equal(composed.profile, bundle[gameSystem]);
                    assert.equal(composed.text, `${expectedBase.trim()}\n\n---\n\n${bundle[gameSystem].trim()}\n`);
                    assert.equal(JSON.stringify(settings), before);
                }
            }
        });
    }

    test(`${tier}: a user edit of an archived prompt remains verbatim in either game profile`, () => {
        const customPrompt = SYSTEM_BUNDLES[tier].legacy + '\nUser campaign exception: the west gate is permanently sealed.\n';
        for (const gameSystem of ['universal', 'dnd5e']) {
            const settings = Object.freeze({ simulationFidelity: tier, gameSystem, customPrompt, systemPromptVariant: tier });
            const composed = composeGamePrompt(settings, presets);
            assert.equal(composed.recognized, false);
            assert.equal(composed.base, customPrompt);
            assert.equal(composed.profile, SYSTEM_BUNDLES[tier][gameSystem]);
            assert.equal(settings.customPrompt, customPrompt);
        }
    });

    test(`${tier}: documented process register is accepted by real board and private-turn validators`, async () => {
        const examples = fencedJson(await sourceFile(`${tier}-base.md`)).filter(value => Array.isArray(value.processes));
        assert.ok(examples.length, 'The process-register example must be executable JSON');
        for (const example of examples) {
            const owners = [...new Set(example.processes.map(process => process.owner))];
            const board = [
                `[MISC #world_clock]\nTime: ${example.through}`,
                '[MISC #simulation_processes]\n```json\n' + JSON.stringify(example) + '\n```',
                ...owners.map(owner => `[${owner}]\nCurrent location and task as recorded in the example.`),
            ].join('\n\n');
            for (const gameSystem of ['universal', 'dnd5e']) {
                const normalized = validateBoard(board, null, { gameSystem }).text;
                assert.deepEqual(processRegister(normalized), example);
                assert.deepEqual(new DraftTurn(normalized, 'diff', gameSystem).checks(), []);
            }
        }
    });
}

test('shared D&D example accepts earned advancement with sheet update and rejects duplicate achievements', async () => {
    const examples = fencedJson(await sourceFile('dnd5e-core.md'));
    const example = examples.find(value => value.version === 1 && value.character_id && Array.isArray(value.awards));
    assert.ok(example, 'A runnable advancement-ledger example is required');
    const entityId = `ENTITIES #${example.character_id}`;
    const firstSheet = `[${entityId}]\nFighter level 1. HP 10/12; Hit Dice 1d10 remaining. Inventory: sword; travel clothes.`;
    const baseline = validateBoard(firstSheet + '\n' + progressionBlock(example), null, { model: true }).text;
    assert.equal(readProgression(baseline).xp, 0);
    assert.equal(readProgression(baseline).level, 1);

    const earned = structuredClone(example);
    earned.awards.push({ id: 'rescue_at_gate', delta: 300, at: 'Day 1, 02:10:00', reason: 'Completed rescue at the gate.' });
    const eligible = applyUpdate(baseline, { content: progressionBlock(earned) }).text;
    assert.equal(readProgression(eligible).xp, 300);
    assert.equal(readProgression(eligible).eligible_level, 2);
    assert.equal(readProgression(eligible).level, 1, 'Eligibility alone must not apply a level');

    const advanced = structuredClone(earned);
    advanced.level = 2;
    assert.throws(() => applyUpdate(eligible, { content: progressionBlock(advanced) }), /Class levels must sum/);
    advanced.classes[0].level = 2;
    assert.throws(() => applyUpdate(eligible, { content: progressionBlock(advanced) }), /mechanical sheet in the same batch/);

    const secondSheet = `[${entityId}]\nFighter level 2. HP 18/20; Hit Dice 2d10 remaining. Action Surge 1/1. Inventory: sword; travel clothes.`;
    const applied = applyUpdate(eligible, { content: secondSheet + '\n' + progressionBlock(advanced) }).text;
    const actual = readProgression(applied);
    assert.equal(actual.xp, 300);
    assert.equal(actual.level, 2);
    assert.equal(actual.classes[0].level, 2);
    assert.equal(actual.next_level_xp, 900);
    assert.equal(actual.proficiency_bonus, 2);
    assert.ok(applied.includes('HP 18/20'));

    const duplicate = structuredClone(actual);
    duplicate.awards.push(structuredClone(duplicate.awards[0]));
    assert.throws(() => applyUpdate(applied, { content: progressionBlock(duplicate) }), /Duplicate XP award ID/);
    assert.equal(readProgression(applied).awards.length, 1);
    assert.equal(readProgression(baseline).xp, 0, 'Rejected or later updates cannot mutate earlier board strings');
});
