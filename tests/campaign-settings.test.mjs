import test from 'node:test';
import assert from 'node:assert/strict';
import { createCampaignSettings, CHAT_SETTINGS_KEY } from '../campaign-settings.js';
import { createRecovery } from '../recovery.js';
import { browserEnvironment } from './browser-fixtures.mjs';

function harness(initial = {}, chatMetadata = {variables:{}}) {
    const saves = {global:0,chat:0};
    const defaults = {functionTool:true,privateReview:false,privateReviewMode:'heavy',simulationFidelity:'mid',gameSystem:'dnd5e',customPrompt:'',autoSceneBackground:true,nested:{example:true}};
    const context = {
        chatId:'Campaign A',characterId:0,characters:[{avatar:'hero.png'}],chatMetadata,
        extensionSettings:{blackboard:structuredClone(initial)},
        saveSettingsDebounced:()=>{saves.global++;},
        saveMetadataDebounced:()=>{saves.chat++;},
    };
    const api = createCampaignSettings({getContext:()=>context,defaults,normalize:settings=>{
        settings.privateReviewMode=settings.privateReviewMode==='light'?'light':'heavy';
    }});
    return {api,context,defaults,saves};
}

test('inheriting global defaults never creates chat settings or schedules metadata writes', () => {
    const h = harness({simulationFidelity:'ultra'});
    const metadata = JSON.stringify(h.context.chatMetadata);
    assert.equal(h.api.get().simulationFidelity,'ultra');
    assert.deepEqual(h.api.status(),{scope:'global',available:true,retained:false,chatId:'Campaign A'});
    assert.equal(h.api.viewKey(),'global');
    h.api.setScope('global');
    assert.equal(JSON.stringify(h.context.chatMetadata),metadata);
    assert.equal(h.saves.chat,0);
    h.api.get().gameSystem='universal';h.api.save();
    assert.equal(h.saves.global,1);assert.equal(h.saves.chat,0);
});

test('chat opt-in makes a deep snapshot of globals and routes writes to metadata', () => {
    const h = harness({simulationFidelity:'ultra',customPrompt:'Global quality.'});
    const original = JSON.stringify(h.api.global());
    const local = h.api.setScope('chat');
    assert.deepEqual(local,JSON.parse(original));
    assert.notEqual(local,h.api.global());
    assert.notEqual(local.nested,h.api.global().nested);
    local.gameSystem='universal';local.nested.example=false;h.api.save();
    assert.equal(JSON.stringify(h.api.global()),original);
    assert.equal(h.context.chatMetadata[CHAT_SETTINGS_KEY].enabled,true);
    assert.equal(h.saves.chat,2);assert.equal(h.saves.global,0);
});

test('inactive global edits and scope bookkeeping cannot change the effective private-turn fingerprint', () => {
    const h = harness({privateReview:true,privateReviewMode:'light'});
    const before = JSON.stringify(h.api.get());
    h.api.setScope('chat');
    assert.equal(JSON.stringify(h.api.get()),before,'Opt-in with identical preferences changes storage only.');
    const effective = JSON.stringify(h.api.get());
    h.api.global().gameSystem='universal';
    h.api.global().customPrompt='Updated global defaults.';
    assert.equal(JSON.stringify(h.api.get()),effective);
    const settings = h.api.get();
    for(const key of ['scope','enabled','version','values','chatId','retained'])assert.equal(Object.hasOwn(settings,key),false,`${key} belongs outside execution preferences.`);
});

test('disabling a local override retains it, re-enabling restores it, and reset copies current globals', () => {
    const h = harness();
    h.api.setScope('chat');h.api.get().gameSystem='universal';
    h.api.get().customPrompt='Retained local quality.';
    const local = h.api.get();
    h.api.setScope('global');
    assert.equal(h.context.chatMetadata[CHAT_SETTINGS_KEY].enabled,false);
    assert.equal(h.api.status().retained,true);
    h.api.get().simulationFidelity='high';h.api.get().customPrompt='New global quality.';h.api.save();
    h.api.setScope('chat');
    assert.equal(h.api.get(),local);
    assert.equal(h.api.get().customPrompt,'Retained local quality.');
    const globals = JSON.stringify(h.api.global());
    h.api.resetChat();
    assert.notEqual(h.api.get(),local);
    assert.equal(h.api.get().simulationFidelity,'high');
    assert.equal(h.api.get().customPrompt,'New global quality.');
    assert.equal(JSON.stringify(h.api.global()),globals);
});

test('saved metadata reload and separate chats retain independent configuration with stable chat view identities', () => {
    const h = harness();
    h.api.setScope('chat');h.api.get().gameSystem='universal';
    const a = {chatId:h.context.chatId,chatMetadata:h.context.chatMetadata};
    const aKey=h.api.viewKey();
    const b = {chatId:'Campaign B',chatMetadata:{variables:{}}};
    Object.assign(h.context,b);
    assert.equal(h.api.status().scope,'global');
    h.api.setScope('chat');h.api.get().customPrompt='Campaign B.';
    assert.notEqual(h.api.viewKey(),aKey);
    Object.assign(h.context,a);
    assert.equal(h.api.get().gameSystem,'universal');assert.equal(h.api.get().customPrompt,'');
    assert.equal(h.api.viewKey(),aKey);
    const reload=harness(structuredClone(h.api.global()),JSON.parse(JSON.stringify(a.chatMetadata)));
    assert.equal(reload.api.get().gameSystem,'universal');
    assert.equal(reload.api.status().scope,'chat');
    assert.equal(reload.saves.chat,0,'Reloading existing settings must not save metadata.');
});

test('a newly branched metadata copy inherits preferences without sharing mutable objects with its parent', () => {
    const h = harness();
    h.api.setScope('chat');h.api.get().gameSystem='universal';
    const original=h.context.chatMetadata;
    h.context.chatMetadata=structuredClone(original);h.context.chatId='Campaign A - Branch #1';
    assert.equal(h.api.get().gameSystem,'universal');
    h.api.get().gameSystem='dnd5e';h.api.get().nested.example=false;
    assert.equal(original[CHAT_SETTINGS_KEY].values.gameSystem,'universal');
    assert.equal(original[CHAT_SETTINGS_KEY].values.nested.example,true);
});

test('an unsaved or absent chat cannot acquire an override and cannot mutate an unrelated metadata object', () => {
    for(const chatId of [null,'']){
        const h=harness();h.context.chatId=chatId;
        assert.equal(h.api.status().available,false);
        assert.throws(()=>h.api.setScope('chat'),/saved chat/i);
        assert.throws(()=>h.api.resetChat(),/saved chat/i);
        assert.equal(h.context.chatMetadata[CHAT_SETTINGS_KEY],undefined);
        assert.equal(h.saves.chat,0);
        assert.equal(h.api.get().gameSystem,'dnd5e');
    }
    const h=harness();delete h.context.chatMetadata;
    assert.equal(h.api.status().available,false);
    assert.throws(()=>h.api.setScope('chat'),/saved chat/i);
    assert.equal(h.saves.chat,0);
});

test('legacy global preferences migrate once before opt-in, and missing defaults normalize separately in saved local values', () => {
    const h=harness({simulationFidelity:'ultra',privateReviewMode:'unknown'});
    let migrations=0;
    const store=createCampaignSettings({getContext:()=>h.context,defaults:h.defaults,
        migrate:settings=>{if(settings.executionModeVersion!==1){migrations++;settings.executionModeVersion=1;settings.privateReview=true;}},
        normalize:settings=>{settings.privateReviewMode=settings.privateReviewMode==='light'?'light':'heavy';},
    });
    assert.equal(store.get().privateReview,true);assert.equal(store.get().privateReviewMode,'heavy');
    store.get();assert.equal(migrations,1);
    store.setScope('chat');assert.equal(migrations,1);
    assert.equal(store.get().executionModeVersion,1);
    const local=h.context.chatMetadata[CHAT_SETTINGS_KEY].values;
    delete local.autoSceneBackground;local.privateReviewMode='invalid';
    assert.equal(store.get().autoSceneBackground,true);
    assert.equal(store.get().privateReviewMode,'heavy');
    assert.equal(h.context.extensionSettings.blackboard.simulationFidelity,'ultra');
});

test('an enabled incompatible local configuration fails closed without overwriting its data', () => {
    for(const record of [{version:99,enabled:true,values:{customPrompt:'Future format.'}},{version:1,enabled:true,values:[]}]){
        const h=harness({}, {[CHAT_SETTINGS_KEY]:structuredClone(record),variables:{}});
        const original=JSON.stringify(h.context.chatMetadata);
        assert.throws(()=>h.api.get(),/unsupported Blackboard settings/i);
        assert.throws(()=>h.api.status(),/unsupported Blackboard settings/i);
        assert.equal(JSON.stringify(h.context.chatMetadata),original);
        assert.equal(h.saves.chat,0);
    }
});

test('metadata alias and group chat settings use the same persistence path without affecting global preferences', () => {
    const h=harness();
    h.context.chat_metadata=h.context.chatMetadata;delete h.context.chatMetadata;
    h.context.groupId='group-one';
    h.api.setScope('chat');h.api.get().privateReview=true;h.api.save();
    assert.equal(h.context.chat_metadata[CHAT_SETTINGS_KEY].values.privateReview,true);
    assert.equal(h.context.extensionSettings.blackboard.privateReview,false);
    assert.deepEqual(JSON.parse(h.api.viewKey()),['chat','group-one','Campaign A']);
    assert.equal(h.saves.chat,2);assert.equal(h.saves.global,0);
});

function checkpointHarness(h, settings = () => h.api.get()) {
    const records=new Map();
    h.context.chat=[{is_user:true,mes:'Wait.'}];
    h.context.chatMetadata.blackboard_engine={turn:1,ages:{},baseline:'baseline'};
    h.context.chatCompletionSettings={model:'test-model'};
    const store={get:async key=>structuredClone(records.get(key)),put:async record=>records.set(record.key,structuredClone(record)),delete:async key=>records.delete(key)};
    const recovery=createRecovery({getContext:()=>h.context,getBoard:()=> 'baseline',setBoard:()=>assert.fail('Validation must not mutate the board'),
        settings,getAccount:async()=> 'tester',store,environment:browserEnvironment()});
    return {recovery,create:async()=>recovery.create(h.context,'normal',[{role:'user',content:'Frozen player action.'}],await recovery.key())};
}

test('checkpoint recovery accepts inactive default edits but rejects changes to this chat execution preferences', async () => {
    const h=harness({privateReview:true,privateReviewMode:'light'});
    h.api.setScope('chat');
    const r=checkpointHarness(h),record=await r.create();
    h.api.global().privateReviewMode='heavy';
    h.api.global().gameSystem='universal';
    h.api.global().customPrompt='A different campaign default.';
    await r.recovery.validate(record,h.context);
    h.api.get().customPrompt='Changed local instructions.';
    await assert.rejects(r.recovery.validate(record,h.context),/settings.*changed/i);
    h.api.get().customPrompt='';
    await r.recovery.validate(record,h.context);
    h.api.get().privateReviewMode='heavy';
    await assert.rejects(r.recovery.validate(record,h.context),/settings.*changed/i);
});

test('checkpoint recovery remains valid when storage scope changes but all effective preference values stay identical', async () => {
    const h=harness({privateReview:true,privateReviewMode:'light'});
    const r=checkpointHarness(h),record=await r.create();
    const original=r.recovery.configuration();
    h.api.setScope('chat');
    assert.equal(r.recovery.configuration(),original);
    await r.recovery.validate(record,h.context);
    h.api.setScope('global');
    assert.equal(r.recovery.configuration(),original);
    await r.recovery.validate(record,h.context);
    assert.equal(h.context.chatMetadata[CHAT_SETTINGS_KEY].enabled,false);
});

test('a legacy checkpoint fingerprint from plain global preferences remains valid without scope wrappers or added execution fields', async () => {
    const h=harness({privateReview:true,privateReviewMode:'light',executionModeVersion:1});
    const legacySettings=h.api.global();
    const legacy=checkpointHarness(h,()=>legacySettings);
    const record=JSON.parse(JSON.stringify(await legacy.create()));
    const current=checkpointHarness(h);
    assert.equal(current.recovery.configuration(),JSON.stringify(legacySettings));
    await current.recovery.validate(record,h.context);
    assert.equal(h.context.chatMetadata[CHAT_SETTINGS_KEY],undefined);
    assert.equal(h.saves.chat,0);
});
