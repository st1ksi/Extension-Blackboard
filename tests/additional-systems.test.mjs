import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GAME_SYSTEMS, gameSystem, hasCalculatedProgression } from '../game-system-registry.js';
import { composeGamePrompt } from '../game-profiles.js';
import { GAME_PROFILE_PROMPTS } from '../prompts/game-profile-bundles.js';
import { SYSTEM_BUNDLES } from '../prompts/system-bundles.js';
import { applyUpdate, validateBoard, readProgression } from '../state.js';
import { freezeCampaignLayers, campaignLayersFingerprint } from '../campaign-layers.js';
import { runPrivateTurn } from '../transaction.js';
import { payload, pass } from './review-fixtures.mjs';

const ids=['coc7e','pf2e','gurps4e','cyberpunk_red','vtm5e','swade'];
const presets={low:{prompt:SYSTEM_BUNDLES.low.base},mid:{prompt:SYSTEM_BUNDLES.mid.base},high:{prompt:SYSTEM_BUNDLES.high.base},ultra:{prompt:SYSTEM_BUNDLES.compact.base}};
const baseline='[MISC #world_clock]\nTime: Day 1, 01:00:00\n[MISC #simulation_processes]\n{"version":1,"through":"Day 1, 01:00:00","processes":[]}\n[ENTITIES #hero]\nCampaign sheet.';
const ledger=id=>'[MISC #character_progression]\n'+JSON.stringify({system:id,earned:[{id:'training-1',at:'Day 1, 01:00:00',points:3}],spent:[],pending_choices:['Choose improvement.']});

test('all profiles use one registry and only D&D requests its calculated schema',()=>{
    assert.deepEqual(Object.keys(GAME_SYSTEMS),['universal','dnd5e',...ids]);
    assert.equal(gameSystem({}),'dnd5e');
    assert.equal(hasCalculatedProgression('dnd5e'),true);
    for(const id of ['universal',...ids]) {assert.equal(gameSystem({gameSystem:id}),id);assert.equal(hasCalculatedProgression(id),false);}
    assert.throws(()=>gameSystem({gameSystem:'new_unsupported_edition'}),/Unsupported.*profile/);
    assert.throws(()=>validateBoard(ledger('future'),null,{gameSystem:'future'}),/Unsupported.*profile/);
});

for(const id of ids) test(`${id}: every quality/focus retains exact core and one independent system profile`,()=>{
    for(const tier of ['low','mid','high','ultra']) for(const focus of ['general','relationships_social']) {
        const s={gameSystem:id,simulationFidelity:tier,simulationFocus:focus,campaignStyle:'deductive',campaignTone:'hopeful',narrativeStyle:'concise'};
        const result=composeGamePrompt(s,presets);
        assert.equal(result.base,SYSTEM_BUNDLES[tier==='ultra'?'compact':tier].base);
        assert.equal(result.rawBase,result.base);
        assert.equal(result.text.split(GAME_PROFILE_PROMPTS[id].trim()).length-1,1);
        assert.equal(result.text.split(GAME_PROFILE_PROMPTS.common.trim()).length-1,1);
        assert.equal(result.campaignLayers.snapshot.gameProfile.id,id);
        assert.equal(result.campaignLayers.snapshot.gameProfile.text,result.profile);
        assert.doesNotMatch(result.profile,/\[GAME SYSTEM PROFILE — D&D|base_xp|proficiency_bonus/);
        assert.equal(result.profile,composeGamePrompt({...s,simulationFocus:'general',campaignStyle:'inherit',campaignTone:'inherit',narrativeStyle:'inherit'},presets).profile);
    }
    const custom=composeGamePrompt({gameSystem:id,simulationFidelity:'custom',customPrompt:'User quality instructions.',simulationFocus:'relationships_social'},presets);
    assert.equal(custom.base,'User quality instructions.');
    assert.equal(custom.campaignLayers.snapshot.tier,'custom');
    assert.equal(custom.campaignLayers.snapshot.gameProfile.id,id);
    assert.equal(custom.profile,composeGamePrompt({gameSystem:id,simulationFidelity:'low'},presets).profile);
});

for(const id of ids) test(`${id}: advancement uses campaign-owned data and survives model edits without D&D arithmetic`,()=>{
    const before=baseline+'\n'+ledger(id),opts={gameSystem:id};
    assert.equal(readProgression(before,opts),null);
    const normalized=validateBoard(before,null,opts).text;
    assert.doesNotMatch(normalized,/eligible_level|proficiency_bonus|base_xp/);
    const next=applyUpdate(normalized,{block_id:'MISC #character_progression',content:JSON.stringify({system:id,earned:[{id:'training-1',points:3}],spent:[{id:'choice-1',points:1}],balance:2})},opts);
    assert.match(next.text,/choice-1/);
    assert.throws(()=>applyUpdate(next.text,{action:'delete',block_id:'MISC #character_progression'},opts),/progression record cannot be deleted/);
    assert.throws(()=>validateBoard(before),/version|ruleset/,'The default D&D validator must still reject a foreign schema.');
});

for(const id of ids) test(`${id}: private simulation, Light review, checkpoint and report descriptor retain exact profile`,async()=>{
    const s={gameSystem:id,simulationFidelity:'low'},snapshot=freezeCampaignLayers(s);
    let saved; const phases=[];
    const result=await runPrivateTurn({baseline:baseline+'\n'+ledger(id),gameSystem:id,campaignLayers:snapshot,reviewMode:'light',context:[],
        saveCheckpoint:async cp=>{saved=structuredClone(cp);}, request:async messages=>{
            const p=payload(messages);phases.push(p.phase);
            if(p.phase==='review')return pass(p);
            if(p.phase==='repair')return {text:JSON.stringify({revision:p.head_revision,candidate_id:p.candidate_id,candidate:'You wait.',issue_resolutions:[]})};
            return {text:'You wait.'};
        }});
    assert.deepEqual(phases,['simulate','review','repair']);assert.equal(result.stats.requests,3);
    assert.equal(saved.draft.gameSystem,id);assert.equal(result.draft.campaignLayers.gameProfile.text,snapshot.gameProfile.text);
    assert.equal(campaignLayersFingerprint(JSON.parse(JSON.stringify(saved.draft.campaignLayers))),campaignLayersFingerprint(snapshot));
    let called=false;
    await assert.rejects(runPrivateTurn({baseline,gameSystem:'dnd5e',campaignLayers:snapshot,context:[],request:async()=>{called=true;}}),/Game system changed/);
    assert.equal(called,false);
});

test('all editable new sources and common contract match generated profiles exactly',async()=>{
    for(const id of ['common','advancement',...ids]) {
        const sourceName = id==='common'?'game-common':id==='advancement'?'game-advancement':id;
        const source=await readFile(new URL(`../prompts/systems/${sourceName}.md`,import.meta.url),'utf8');
        assert.equal(GAME_PROFILE_PROMPTS[id],source,id);
    }
    assert.match(GAME_PROFILE_PROMPTS.common,/wholly off-screen/);
    assert.match(GAME_PROFILE_PROMPTS.advancement,/does NOT calculate/);
    assert.doesNotMatch(GAME_PROFILE_PROMPTS.common,/does NOT calculate/);
    assert.match(GAME_PROFILE_PROMPTS.common,/Rules-authorized pushes, rerolls/);
});

test('both settings templates enumerate the same complete game registry',async()=>{
    const native=await readFile(new URL('../settings.html',import.meta.url),'utf8');
    const custom=await readFile(new URL('../dashboard.html',import.meta.url),'utf8');
    for(const text of [native,custom]) {
        const section=text.match(/<select[^>]*(?:id="blackboard_game_system"|data-bb-control="blackboard_game_system")[^>]*>([\s\S]*?)<\/select>/)[1];
        assert.deepEqual([...section.matchAll(/value="([^"]+)"/g)].map(match=>match[1]),Object.keys(GAME_SYSTEMS));
    }
});
