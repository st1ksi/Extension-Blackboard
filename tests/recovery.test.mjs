import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecovery, openCheckpointStore } from '../recovery.js';
import { browserEnvironment } from './browser-fixtures.mjs';

function harness() {
    const records=new Map();let board='baseline',settings={privateReview:true};let locked=false;
    const ctx={chatId:'chat',characterId:0,characters:[{avatar:'hero.png'}],chat:[{is_user:true,mes:'Act'}],chatMetadata:{blackboard_engine:{turn:1}},chatCompletionSettings:{model:'one'}};
    const store={get:async key=>structuredClone(records.get(key)),put:async record=>records.set(record.key,structuredClone(record)),delete:async key=>records.delete(key)};
    const locks={request:async(_key,_opts,callback)=>{if(locked)return callback(null);locked=true;try{return await callback({});}finally{locked=false;}}};
    const api=createRecovery({getContext:()=>ctx,getBoard:()=>board,setBoard:value=>{board=value;},settings:()=>settings,getAccount:async()=> 'user',store,locks,environment:browserEnvironment()});
    return {api,ctx,records,get board(){return board;},set board(value){board=value;},settings,
        create:async type=>api.create(ctx,type||'normal',[{role:'user',content:'frozen'}],await api.key())};
}

test('checkpoint is separate from chat, scoped to account/character/chat, and contains no connection secrets',async()=>{
    const h=harness(),credential='recovery-test-password-8cd6143a';h.ctx.chatCompletionSettings.reverse_proxy_password=credential;
    const before=structuredClone(h.ctx);const record=await h.create();
    assert.deepEqual(h.ctx,before);assert.ok(!JSON.stringify(record).includes(credential));
    assert.equal(record.key,JSON.stringify(['user','hero.png','chat']));
    assert.deepEqual(await h.api.load(record.key),record);
    h.ctx.chatId='branch';await assert.rejects(h.api.validate(record,h.ctx),/another chat/);
});
test('history, board, connection and extension settings changes reject resume',async()=>{
    for(const mutate of [h=>h.ctx.chat[0].mes='edited',h=>h.board='edited',h=>h.ctx.chatCompletionSettings.model='two',h=>h.settings.privateReview=false]){
        const h=harness(),record=await h.create();mutate(h);await assert.rejects(h.api.validate(record,h.ctx));
    }
});
test('unchanged chat resumes after serialization; publishing markers prohibit replay',async()=>{
    const h=harness(),record=JSON.parse(JSON.stringify(await h.create()));
    await h.api.validate(record,h.ctx);
    for(const status of ['publishing','published']){record.status=status;await assert.rejects(h.api.validate(record,h.ctx),/Publication/);}
});

test('execution migration marker does not strand old turns, but a checkbox change still rejects resume',async()=>{
    for(const withProfile of [false,true]) {
        const h=harness();if(withProfile)h.settings.gameSystem='universal';
        const record=await h.create();record.checkpoint={draft:withProfile?{gameSystem:'universal'}:{}};
        if(!withProfile)h.settings.gameSystem='dnd5e';
        h.settings.executionModeVersion=1;
        await h.api.validate(record,h.ctx);
        h.settings.privateReview=false;
        await assert.rejects(h.api.validate(record,h.ctx),/settings/);
    }
});

test('adding the disabled separate-narration default preserves older private checkpoints exactly',async()=>{
    for (const checkpoint of [null, {version:4,reviewMode:'heavy',draft:{gameSystem:'dnd5e',rolls:[{result:'17'}]},phase:'repair'}]) {
        const h=harness(),record=JSON.parse(JSON.stringify(await h.create()));
        record.checkpoint=checkpoint;
        const saved=structuredClone(record),history=structuredClone(h.ctx.chat);
        h.settings.separateNarration=false;
        await h.api.validate(record,h.ctx);
        assert.deepEqual(record,saved,'Validation must not rewrite a legacy draft, its rolls, or its pending stage.');
        assert.deepEqual(h.ctx.chat,history);
        assert.equal(h.board,'baseline');
    }
});

test('disabled separate-narration migration composes with legacy execution, profile and review defaults',async()=>{
    const h=harness(),record=await h.create();
    record.checkpoint={version:4,draft:{baseline:'baseline'}};
    Object.assign(h.settings,{separateNarration:false,executionModeVersion:1,privateReviewMode:'heavy',gameSystem:'dnd5e'});
    await h.api.validate(record,h.ctx);
    h.settings.privateReviewMode='light';
    await assert.rejects(h.api.validate(record,h.ctx),/settings/,'The opt-in migration must not mask an actual review-mode change.');
});

test('changing from ordinary preparation to separate narration cannot resume the old pipeline',async()=>{
    for (const originalValue of [undefined,false]) {
        const h=harness();
        if (originalValue!==undefined) h.settings.separateNarration=originalValue;
        const record=await h.create();
        record.checkpoint={version:4,draft:{rolls:[{result:'17'}]},phase:'repair'};
        h.settings.separateNarration=true;
        await assert.rejects(h.api.validate(record,h.ctx),/settings/);
        if (originalValue===undefined) delete h.settings.separateNarration;
        else h.settings.separateNarration=originalValue;
        await h.api.validate(record,h.ctx);
    }
});

test('a separate-narration checkpoint requires its actual enabled mode across serialization',async()=>{
    const h=harness();h.settings.separateNarration=true;
    const record=JSON.parse(JSON.stringify(await h.create()));
    record.checkpoint={version:1,kind:'separate_narration',phase:'narration_check',world:{draft:{rolls:[{result:'17'}]}}};
    await h.api.validate(record,h.ctx);
    h.settings.separateNarration=false;
    await assert.rejects(h.api.validate(record,h.ctx),/settings/);
    delete h.settings.separateNarration;
    await assert.rejects(h.api.validate(record,h.ctx),/settings/);
    h.settings.separateNarration=true;
    await h.api.validate(record,h.ctx);
});

test('default migration never treats a wrapped narration checkpoint as a legacy ordinary turn',async()=>{
    const h=harness(),record=await h.create();
    record.checkpoint={version:1,kind:'separate_narration',phase:'narrate'};
    h.settings.separateNarration=false;
    await assert.rejects(h.api.validate(record,h.ctx),/settings/);
});

test('pre-profile checkpoint accepts only the newly added D&D default, not a changed campaign profile',async()=>{
    const h=harness(),record=await h.create();
    record.checkpoint={draft:{baseline:'baseline'}};
    h.settings.gameSystem='dnd5e';
    await h.api.validate(record,h.ctx);
    h.settings.gameSystem='universal';
    await assert.rejects(h.api.validate(record,h.ctx),/settings/);
    h.settings.gameSystem='dnd5e';h.settings.privateReview=false;
    await assert.rejects(h.api.validate(record,h.ctx),/settings/);
});
test('failed swipe may restore only its exact fallback and original baseline',async()=>{
    const h=harness();h.ctx.chat.push({is_user:false,mes:'...',swipe_id:1,swipes:['Old answer'],swipe_info:[{extra:{blackboard_snapshot:'old board'}}]});
    const record=await h.create('swipe');
    Object.assign(h.ctx.chat.at(-1),{mes:'Old answer',swipe_id:0});h.board='old board';
    await h.api.validate(record,h.ctx,true);
    assert.equal(h.board,'baseline');assert.equal(h.ctx.chat.at(-1).swipe_id,1);assert.equal(h.ctx.chat.at(-1).mes,'...');
    await h.api.validate(record,h.ctx);
    h.ctx.chat.at(-1).swipes.push('Different answer');await assert.rejects(h.api.validate(record,h.ctx),/History/);
});
test('a second tab cannot enter an already held chat lock',async()=>{
    const h=harness();await h.api.withLock(h.ctx,async()=>{await assert.rejects(h.api.withLock(h.ctx,()=>assert.fail('Concurrent turn')),/another tab/);});
    await h.api.withLock(h.ctx,async()=>{});
});

test('checkpoint open failure is actionable and can retry after storage permission changes',async()=>{
    let attempts=0;
    const store=openCheckpointStore({open(){attempts++;throw new Error('SecurityError');}});
    await assert.rejects(store.get('chat'),/site-storage permissions: SecurityError/);
    await assert.rejects(store.get('chat'),/site-storage permissions: SecurityError/);
    assert.equal(attempts,2,'An initial rejected promise must not permanently poison storage');
});

test('restricted storage does not break construction or standard-mode refresh',async()=>{
    const environment=browserEnvironment();
    Object.defineProperty(environment,'indexedDB',{get(){throw new Error('SecurityError');}});
    const renders=[];
    const ctx={chatId:'chat',characterId:0,characters:[{avatar:'hero.png'}]};
    const api=createRecovery({environment,getContext:()=>ctx,getAccount:async()=> 'user',render:record=>renders.push(record)});
    await api.refresh();
    assert.deepEqual(renders,[null]);
    await assert.rejects(api.withLock(ctx,()=>assert.fail('No turn on restricted browser')),/IndexedDB/);
});
