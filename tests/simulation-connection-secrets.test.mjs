import test from 'node:test';
import assert from 'node:assert/strict';
import { getSimulationSecretKey, saveSimulationProfileSecret, installSimulationSecretControl, isSimulationKeySavePending, assertSimulationKeyWritable } from '../simulation-connection-secrets.js';

const sample = 'fixture-key-not-a-real-credential';
const secretKeys = { CUSTOM:'api_key_custom', MAKERSUITE:'api_key_makersuite', VERTEXAI:'api_key_vertexai', VERTEXAI_SERVICE_ACCOUNT:'vertexai_service_account_json' };
function fixture({ firstKey = false, failRotate = false, rotateNoOp = false, failWrite = false, afterWrite, saveFailure = false } = {}) {
    const profile = { id:'sim', name:'World', api:'custom', model:'model', preset:'preset', 'secret-id':'profile-old', exclude:['secret-id','other'] };
    let selected='sim', scope='chat', saved=0, refreshed=0;
    const state={ api_key_custom:firstKey?[]:[{id:'main-old',active:true}] }, calls=[];
    const context={chat:[{mes:'act'}],chatMetadata:{},chatId:'one',extensionSettings:{connectionManager:{profiles:[profile]}},
        getRequestHeaders:()=>({'X-CSRF-Token':'fixture'}),saveSettingsDebounced(){saved++;if(saveFailure)throw new Error(sample);} };
    const options={getContext:()=>context,getProfileId:()=>selected,getViewKey:()=>scope,value:sample,secretKeys,
        readState:async()=>structuredClone(state),refreshState:async()=>{refreshed++;},persistProfile:async ctx=>ctx.saveSettingsDebounced(),
        resolveConnection:async()=>({settings:{custom_url:'http://fixture.invalid'},descriptor:{source:'custom',name:'World',model:'model'}}),
        fetchRequest:async(path,init)=>{
            const body=JSON.parse(init.body);calls.push({path,body});
            if(path==='/api/secrets/write'){
                if(failWrite)throw new Error(sample);
                state.api_key_custom.forEach(entry=>entry.active=false);state.api_key_custom.push({id:'new-id',active:true});
                afterWrite?.({profile,context,setSelected:value=>{selected=value;},setScope:value=>{scope=value;}});
                return {ok:true,json:async()=>({id:'new-id'})};
            }
            assert.equal(path,'/api/secrets/rotate');
            assert.equal(profile['secret-id'],'profile-old','Default restoration precedes profile assignment');
            if(failRotate)return {ok:false,json:async()=>({error:sample})};
            if(!rotateNoOp)state.api_key_custom.forEach(entry=>entry.active=entry.id===body.id);
            return {ok:true};
        }};
    return {options,context,profile,state,calls,get saved(){return saved;},get refreshed(){return refreshed;}};
}

test('secret buckets use the selected provider and Vertex authentication mode',()=>{
    assert.equal(getSimulationSecretKey('custom',{},secretKeys),'api_key_custom');
    assert.equal(getSimulationSecretKey('makersuite',{},secretKeys),'api_key_makersuite');
    assert.equal(getSimulationSecretKey('vertexai',{vertexai_auth_mode:'full'},secretKeys),'vertexai_service_account_json');
    assert.equal(getSimulationSecretKey('vertexai',{vertexai_auth_mode:'express'},secretKeys),'api_key_vertexai');
    assert.equal(getSimulationSecretKey('unknown',{},secretKeys),null);
});

test('save binds only a secret ID, preserves previous active key and removes secret exclusion',async()=>{
    const h=fixture();const result=await saveSimulationProfileSecret(h.options);
    assert.deepEqual(result,{id:'new-id',firstKey:false});
    assert.equal(h.profile['secret-id'],'new-id');assert.deepEqual(h.profile.exclude,['other']);
    assert.equal(h.state.api_key_custom.find(entry=>entry.active).id,'main-old');
    assert.equal(h.saved,1);assert.equal(h.refreshed,1);
    assert.ok(!JSON.stringify(h.context).includes(sample));
    assert.deepEqual(h.calls.map(call=>call.path),['/api/secrets/write','/api/secrets/rotate']);
    assert.equal(h.calls[0].body.value,sample);assert.equal(h.calls[1].body.id,'main-old');
});

test('a first provider key is saved with an explicit first-key result',async()=>{
    const h=fixture({firstKey:true});const result=await saveSimulationProfileSecret(h.options);
    assert.equal(result.firstKey,true);assert.equal(h.calls.length,1);assert.equal(h.profile['secret-id'],'new-id');
});

test('failed default restoration does not assign or persist a profile key and hides response data',async()=>{
    const h=fixture({failRotate:true});
    await assert.rejects(saveSimulationProfileSecret(h.options),error=>{
        assert.match(error.message,/restore the previous active key/);assert.ok(!error.message.includes(sample));return true;
    });
    assert.equal(h.profile['secret-id'],'profile-old');assert.equal(h.saved,0);assert.equal(h.refreshed,1);
});

test('write errors never expose entered credentials or alter profile settings',async()=>{
    const h=fixture({failWrite:true});
    await assert.rejects(saveSimulationProfileSecret(h.options),error=>{
        assert.ok(!error.message.includes(sample));assert.match(error.message,/key store/);return true;
    });
    assert.equal(h.profile['secret-id'],'profile-old');assert.equal(h.saved,0);
});

test('an empty metadata error response cannot be mistaken for an empty provider vault',async()=>{
    const h=fixture();h.options.readState=async()=>({});
    await assert.rejects(saveSimulationProfileSecret(h.options),/No key was saved/);
    assert.equal(h.calls.length,0);assert.equal(h.saved,0);
});

test('a successful HTTP rotation that does not restore the key never assigns the profile',async()=>{
    const h=fixture({rotateNoOp:true});
    await assert.rejects(saveSimulationProfileSecret(h.options),/could not confirm the active key/);
    assert.equal(h.profile['secret-id'],'profile-old');assert.equal(h.saved,0);
});

test('native generation and resumed private UI state each exclude vault key activation',()=>{
    assert.throws(()=>assertSimulationKeyWritable({isGenerating:()=>true,document:{body:{dataset:{}}}}),/generation to finish/);
    assert.throws(()=>assertSimulationKeyWritable({isGenerating:()=>false,document:{body:{dataset:{generating:'true'}}}}),/generation to finish/);
    assert.doesNotThrow(()=>assertSimulationKeyWritable({isGenerating:()=>false,document:{body:{dataset:{}}}}));
});

test('generation beginning during metadata preparation prevents any key-store write',async()=>{
    for(const resumed of [false,true]) {
        const h=fixture(),document={body:{dataset:{}}};let nativeGenerating=false;
        h.options.readState=async()=>{
            if(resumed)document.body.dataset.generating='true';else nativeGenerating=true;
            return structuredClone(h.state);
        };
        h.options.assertWritable=()=>assertSimulationKeyWritable({isGenerating:()=>nativeGenerating,document});
        await assert.rejects(saveSimulationProfileSecret(h.options),/generation to finish/);
        assert.equal(h.calls.length,0);assert.equal(h.saved,0);
        assert.equal(h.profile['secret-id'],'profile-old');
        assert.equal(h.state.api_key_custom.find(entry=>entry.active).id,'main-old');
    }
});

for(const change of ['selection','scope','profile','chat'])test(`${change} changes during vault write preserve the entry but never bind it to a changed destination`,async()=>{
    const h=fixture({afterWrite({profile,context,setSelected,setScope}){
        if(change==='selection')setSelected('other');
        if(change==='scope')setScope('other');
        if(change==='profile')profile.model='changed';
        if(change==='chat')context.chatMetadata={};
    }});
    await assert.rejects(saveSimulationProfileSecret(h.options),/changed/);
    assert.equal(h.profile['secret-id'],'profile-old');assert.equal(h.saved,0);
    assert.equal(h.state.api_key_custom.find(entry=>entry.active).id,'main-old');
    assert.ok(h.state.api_key_custom.some(entry=>entry.id==='new-id'));
});

test('a settings-save failure rolls back profile IDs without deleting old or newly saved vault entries',async()=>{
    const h=fixture({saveFailure:true});await assert.rejects(saveSimulationProfileSecret(h.options),/profile could not be saved/);
    assert.equal(h.profile['secret-id'],'profile-old');assert.deepEqual(h.profile.exclude,['secret-id','other']);
    assert.equal(h.state.api_key_custom.length,2);
});

function uiFixture({saveSecret} = {}) {
    const nodes=()=>({value:'',disabled:false,textContent:'',listeners:new Map(),addEventListener(name,listener){this.listeners.set(name,listener);}});
    const input=nodes(),button=nodes(),status=nodes(),listeners=new Map();
    const panel={querySelector:selector=>selector==='[data-bb-simulation-key]'?input:selector==='[data-bb-save-simulation-key]'?button:status,
        addEventListener(name,listener){listeners.set(name,listener);}};
    const settings={functionTool:true,separateNarration:true,simulationConnectionProfile:'sim'};
    const events=new Map();
    const context={extensionSettings:{connectionManager:{profiles:[{id:'sim',api:'custom',mode:'cc'}]}},CONNECT_API_MAP:{custom:{selected:'openai'}},
        eventTypes:Object.fromEntries(['GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED'].map(name=>[name,name])),
        eventSource:{on(name,handler){events.set(name,handler);}}};
    let scope='global',sent;
    const control=installSimulationSecretControl({panel,getContext:()=>context,getSettings:()=>settings,getViewKey:()=>scope,
        saveSecret:saveSecret??(async options=>{sent=options.value;context.extensionSettings.connectionManager.profiles[0]['secret-id']='new-id';return {id:'new-id',firstKey:false};})});
    return {input,button,status,settings,context,control,listeners,events,setScope:value=>{scope=value;},get sent(){return sent;}};
}

test('password UI clears on save, close, profile/scope changes and never stores entered text in settings',async()=>{
    const h=uiFixture();h.input.value=sample;h.input.listeners.get('input')();
    assert.equal(h.button.disabled,false);await h.button.listeners.get('click')();
    assert.equal(h.sent,sample);assert.equal(h.input.value,'');assert.match(h.status.textContent,/previous default key is unchanged/);
    assert.ok(!JSON.stringify(h.settings).includes(sample));assert.ok(!JSON.stringify(h.context).includes(sample));
    h.input.value=sample;h.listeners.get('bb-panel-close')();assert.equal(h.input.value,'');
    h.input.value=sample;h.setScope('chat');h.control.refresh();assert.equal(h.input.value,'');
    h.input.value=sample;h.settings.simulationConnectionProfile='';h.control.refresh();assert.equal(h.input.value,'');
    assert.equal(h.input.disabled,true);assert.equal(h.button.disabled,true);
});

test('the pending-key guard covers the whole async save and releases after failure',async()=>{
    let finish;
    const h=uiFixture({saveSecret:()=>new Promise((resolve,reject)=>{finish=reject;})});
    h.input.value=sample;const pending=h.button.listeners.get('click')();
    assert.equal(isSimulationKeySavePending(),true);assert.equal(h.input.value,'');
    finish(new Error('Fixture save failed'));await pending;
    assert.equal(isSimulationKeySavePending(),false);assert.equal(h.input.value,'');
});

test('generation clears key drafts and disables saving until it ends',()=>{
    const h=uiFixture();h.input.value=sample;h.input.listeners.get('input')();
    h.events.get('GENERATION_STARTED')('normal',{},true);assert.equal(h.input.value,sample);
    h.events.get('GENERATION_STARTED')('normal',{},false);
    assert.equal(h.input.value,'');assert.equal(h.input.disabled,true);assert.equal(h.button.disabled,true);
    h.events.get('GENERATION_ENDED')();assert.equal(h.input.disabled,false);assert.equal(h.button.disabled,true);
});
