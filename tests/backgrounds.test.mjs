import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backgroundInstructions, DEFAULT_BACKGROUND_SYSTEM_PROMPT } from '../background-instructions.js';
import { SYSTEM_BUNDLES } from '../prompts/system-bundles.js';
import { composeGamePrompt } from '../game-profiles.js';
import { runPrivateTurn } from '../transaction.js';
import { pass, payload } from './review-fixtures.mjs';

const presets=Object.fromEntries(Object.entries(SYSTEM_BUNDLES).map(([id,b])=>[id,{prompt:b.legacy}]));
const board='[MISC #world_clock]\nTime: Day 1, 01:00:00\n[MISC #simulation_processes]\n{"version":1,"through":"Day 1, 01:00:00","processes":[]}';

test('all known quality/game profiles, including prior saved editor bases, contain no image-generation assignment',()=>{
    for(const [id,b] of Object.entries(SYSTEM_BUNDLES)) for(const customPrompt of [b.legacy,b.base,...b.priorBases]) {
        for(const gameSystem of ['universal','dnd5e']) {
            const settings={simulationFidelity:id,customPrompt,gameSystem};
            const p=composeGamePrompt(settings,presets);
            assert.equal(p.recognized,true);assert.equal(p.base,b.base);
            assert.doesNotMatch(p.text,/SetSceneBackground|DYNAMIC SCENE VISUALIZATION/);
            assert.match(p.text,/UpdateBlackboard/);
        }
    }
});

test('background instructions have an independent enabled gate and retain custom text',()=>{
    const custom='User-defined scene-art instructions.';
    for(const privateReview of [false,true]){
        const settings={autoSceneBackground:false,privateReview,customBackgroundPrompt:custom};
        assert.equal(backgroundInstructions(settings),'');
        assert.equal(settings.customBackgroundPrompt,custom);
        settings.autoSceneBackground=true;
        assert.ok(backgroundInstructions(settings).startsWith(custom));
        assert.match(backgroundInstructions(settings), privateReview ? /stages a request during simulation only/ : /generates and applies/);
        settings.customBackgroundPrompt='';
        assert.ok(backgroundInstructions(settings).startsWith(DEFAULT_BACKGROUND_SYSTEM_PROMPT));
    }
});

test('disabled private checkpoint resumes exact allowed request and rejects a changed background setting',async()=>{
    let checkpoint,frozen,fail=true;
    const options={baseline:board,backgroundsEnabled:false,context:[],saveCheckpoint:async s=>{checkpoint=s;},request:async(messages,allowed)=>{
        assert.ok(!allowed.includes('SetSceneBackground'));
        const p=payload(messages);
        if(p.phase==='review')return pass(p);
        assert.doesNotMatch(messages[0].content,/SetSceneBackground/);
        if(fail){fail=false;frozen=structuredClone(messages);throw new Error('429');}
        assert.deepEqual(messages,frozen);return {text:'Wait.'};
    }};
    await assert.rejects(runPrivateTurn(options),/429/);
    assert.equal(checkpoint.backgroundsEnabled,false);
    await assert.rejects(runPrivateTurn({...options,backgroundsEnabled:true,checkpoint}),/Background setting changed/);
    const result=await runPrivateTurn({...options,checkpoint});
    assert.equal(result.draft.background,null);assert.equal(result.stats.requests,5);
});

test('legacy paused turn cannot apply an image queued while its background setting was off',async()=>{
    let checkpoint,first=true;
    await assert.rejects(runPrivateTurn({baseline:board,context:[],saveCheckpoint:async s=>{checkpoint=s;},request:async()=>{
        if(first){first=false;return {calls:[{name:'SetSceneBackground',arguments:{prompt:'View'}}]};}
        throw new Error('429');
    }}),/429/);
    delete checkpoint.backgroundsEnabled;
    const result=await runPrivateTurn({baseline:board,backgroundsEnabled:false,checkpoint,invoke:()=>assert.fail('No image'),request:async(messages,allowed)=>{
        assert.ok(!allowed.includes('SetSceneBackground'));
        const p=payload(messages);return p.phase==='review'?pass(p):{text:'Wait.'};
    }});
    assert.equal(result.draft.background,null);
    assert.equal(result.draft.backgroundRequests.length,1,'Preserve old request in private diagnostics');
});
