import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SYSTEM_BUNDLES } from '../prompts/system-bundles.js';
import { composeGamePrompt, gameSystem } from '../game-profiles.js';
import { applyUpdate, validateBoard, readProgression } from '../state.js';
import { DraftTurn, runPrivateTurn } from '../transaction.js';
import { payload, pass } from './review-fixtures.mjs';

const presets = Object.fromEntries(Object.entries(SYSTEM_BUNDLES).map(([id,b]) => [id,{prompt:b.legacy}]));
const record = '[MISC #character_progression]\nLearned lock repair through apprenticeship. No classes or numeric levels.';
const processBoard = '[MISC #world_clock]\nTime: Day 1, 01:00:00\n[MISC #simulation_processes]\n' + JSON.stringify({version:1,through:'Day 1, 01:00:00',processes:[]});

for (const id of Object.keys(SYSTEM_BUNDLES)) {
    test(`${id}: universal keeps shared mechanics, excludes D&D mandates, and matches editable sources`, async () => {
        const settings = { simulationFidelity: id, gameSystem:'universal', customPrompt:SYSTEM_BUNDLES[id].legacy };
        const before = JSON.stringify(settings);
        const p = composeGamePrompt(settings,presets);
        assert.equal(JSON.stringify(settings), before, 'Reading a prompt cannot overwrite the saved original');
        assert.equal(p.base, await readFile(new URL(`../prompts/systems/${id}-base.md`,import.meta.url),'utf8'));
        assert.equal(p.profile, await readFile(new URL('../prompts/systems/universal.md',import.meta.url),'utf8'));
        assert.match(p.base, /<item>/);
        assert.match(p.base, /UpdateBlackboard/);
        assert.match(p.base, /\{\{getvar::world_blackboard\}\}/);
        assert.doesNotMatch(p.base, /D&D|5e-2014|5e-2024|spell slots|six seconds|6 seconds|\+2\/\+5 AC|\bXP\b|\bgp\b/);
        const dnd = composeGamePrompt({...settings,gameSystem:'dnd5e'},presets);
        assert.equal(p.base,dnd.base);
        assert.match(dnd.profile,/D&D 5e/);
        assert.equal(dnd.profile, await readFile(new URL(`../prompts/systems/${id}-dnd5e.md`,import.meta.url),'utf8'));
        if (['compact','ultra'].includes(id)) {
            const originalSection = '### 21.' + SYSTEM_BUNDLES[id].legacy.split('### 21.')[1];
            assert.ok(dnd.profile.replace(/\r\n/g, '\n').includes(originalSection.replace(/\r\n/g, '\n')), 'The original detailed D&D advancement procedure survives intact');
            for (const section of [4,5,9,16,18,20]) {
                const extract = t => t.replace(/\r\n/g, '\n').match(new RegExp(`### ${section}\\.[\\s\\S]*?(?=\\n### \\d+\\.|$)`))?.[0];
                // Item-card properties/currency are generalized. Distance-dependent
                // sections changed with the expanded Ultra horizon, tested separately.
                if (section!==18 && id==='compact') assert.equal(extract(p.base),extract(SYSTEM_BUNDLES[id].legacy));
            }
        }
    });
}

test('known compact custom prompt preserves variant after editing the neutral base', () => {
    const original = SYSTEM_BUNDLES.compact.legacy.replace(/\n/g,'\r\n')+'\r\n';
    const s={simulationFidelity:'ultra',customPrompt:original};
    const first=composeGamePrompt(s,presets);
    assert.equal(first.variant,'compact');
    const edited=composeGamePrompt({...s,customPrompt:first.base+'\nCustom preference.',systemPromptVariant:first.variant},presets);
    assert.match(edited.base,/Custom preference/);
    assert.equal(edited.profile,first.profile);
    assert.equal(s.customPrompt,original);
});

test('arbitrary user text is not silently rewritten or classified from keywords', () => {
    const custom='User rules: D&D is a fictional book in this science-fiction story. Preserve this line.';
    const p=composeGamePrompt({simulationFidelity:'mid',gameSystem:'universal',customPrompt:custom},presets);
    assert.equal(p.base,custom);assert.equal(p.recognized,false);
    assert.equal(gameSystem({}),'dnd5e');
});

test('unrecognized Ultra custom text defaults to v6 profile while explicit legacy v5 remains recognized',()=>{
    const custom='User-specific world rules.';
    const current=composeGamePrompt({simulationFidelity:'ultra',customPrompt:custom},presets);
    assert.equal(current.base,custom);assert.equal(current.variant,'compact');
    assert.equal(current.profile,SYSTEM_BUNDLES.compact.dnd5e);
    const legacy=composeGamePrompt({simulationFidelity:'ultra',customPrompt:SYSTEM_BUNDLES.ultra.legacy},presets);
    assert.equal(legacy.variant,'ultra');assert.equal(legacy.base,SYSTEM_BUNDLES.ultra.base);
});

test('universal record supports narrative and non-5e structured progression without derived fields', () => {
    const options={gameSystem:'universal'};
    assert.equal(validateBoard(record,null,options).text,record);
    const custom={ruleset:'custom',rank:'journeyman',xp:12,threshold:17};
    const result=applyUpdate(record,{block_id:'MISC #character_progression',content:JSON.stringify(custom)},options);
    assert.deepEqual(JSON.parse(result.parsed.blocks[0].content),custom);
    assert.equal(readProgression(result.text,options),null);
    assert.throws(()=>applyUpdate(result.text,{action:'delete',block_id:'MISC #character_progression'},options),/cannot be deleted/);
    assert.throws(()=>validateBoard(result.text),/version|ruleset/);
});

test('changing profile does not convert a saved D&D ledger; default still validates arithmetic', () => {
    const value={version:1,character_id:'hero',ruleset:'5e-2014',mode:'xp',base_xp:900,baseline_reason:'Starting level',level:3,classes:[{name:'Monk',level:3}],awards:[],pending_choices:[]};
    const board='[ENTITIES #hero]\nMonk level 3\n[MISC #character_progression]\n'+JSON.stringify(value);
    const normalized=validateBoard(board).text;
    assert.equal(validateBoard(normalized,null,{gameSystem:'universal'}).text,normalized);
    assert.equal(readProgression(normalized).xp,900);
    assert.equal(readProgression(normalized).proficiency_bonus,2);
});

test('universal private draft stages, audits and resumes using its campaign format', async () => {
    let saved, stop=true;
    const baseline=processBoard+'\n'+record;
    const request=async messages=>{
        const p=payload(messages);
        if(p.phase==='review')return pass(p);
        if(p.head_revision===0)return {calls:[{name:'UpdateBlackboard',arguments:{base_revision:0,block_id:'MISC #character_progression',content:'Apprenticeship complete; learned lock repair. Next choice pending.'}}]};
        if(stop)throw new Error('simulated network interruption');
        return {text:'Your apprenticeship is complete.'};
    };
    await assert.rejects(runPrivateTurn({baseline,gameSystem:'universal',context:[],request,invoke:async()=>{},saveCheckpoint:async c=>{saved=structuredClone(c);}}),/network interruption/);
    assert.equal(saved.draft.gameSystem,'universal');
    assert.equal(saved.draft.versions.length,2);
    stop=false;
    const result=await runPrivateTurn({baseline,gameSystem:'universal',context:[],checkpoint:saved,request,invoke:async()=>{}});
    assert.match(result.draft.head,/Apprenticeship complete/);
    assert.deepEqual(result.draft.checks(),[]);
    await assert.rejects(runPrivateTurn({baseline,gameSystem:'dnd5e',checkpoint:saved,request,invoke:async()=>{}}),/Game system changed/);
    const draft=new DraftTurn(processBoard,'diff','universal');
    draft.update({base_revision:0,content:record});
    assert.deepEqual(draft.checks(),[]);
});
