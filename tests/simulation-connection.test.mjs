import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSimulationConnection, resolveSimulationConnection } from '../simulation-connection.js';
import { createPrivateRequest } from '../private-api.js';
import { DICE_TOOL_NAME } from '../dice-engine.js';

// ST's public settingsToUpdate contract maps serialized preset keys to its
// request-setting keys before provider-specific parameter conversion.
const mapping = Object.fromEntries(Object.entries({
    temperature:'temp_openai', reasoning_effort:'reasoning_effort', openai_max_tokens:'openai_max_tokens',
    custom_url:'custom_url', custom_include_headers:'custom_include_headers', custom_include_body:'custom_include_body',
    custom_prompt_post_processing:'custom_prompt_post_processing', use_sysprompt:'use_sysprompt',
    reverse_proxy:'reverse_proxy', proxy_password:'proxy_password', vertexai_auth_mode:'vertexai_auth_mode',
    vertexai_region:'vertexai_region', vertexai_express_project_id:'vertexai_express_project_id',
}).map(([key,value])=>[key,['#unused',value,false,false]]));

function fixture({source='custom', profile={}, preset={}}={}) {
    const saved={id:'simulation',name:'World model',mode:'cc',api:source,model:'world-model',preset:'World preset',
        ...(source==='custom'?{'api-url':'http://127.0.0.1:8901/codex/v1'}:{}),...profile};
    const context={CONNECT_API_MAP:{custom:{selected:'openai',source:'custom'},vertexai:{selected:'openai',source:'vertexai'},
        makersuite:{selected:'openai',source:'makersuite'},tc:{selected:'textgenerationwebui'}},
        extensionSettings:{connectionManager:{profiles:[saved]},subscriptions:{codex:{effort:'low'}}}};
    const settings={chat_completion_source:'custom',custom_model:'narrator-model',custom_url:'https://narrator.example/v1',
        custom_include_headers:'Authorization: narrator-private-test',custom_include_body:'narrator-body-test',
        custom_exclude_body:'tools',custom_prompt_post_processing:'single',
        reverse_proxy:'https://narrator-proxy.example',proxy_password:'narrator-password-test',
        azure_base_url:'https://narrator-azure.example',vertexai_express_project_id:'narrator-project',
        bias_preset_selected:'Narrator bias',temp_openai:1,reasoning_effort:'high',stream_openai:true,n:5};
    const selectedPreset={temperature:0.3,reasoning_effort:'low',openai_max_tokens:2000,...preset};
    const proxies=[],keyState={id:null};
    const resolve=()=>buildSimulationConnection({context,profileId:'simulation',settings,settingsToUpdate:mapping,
        getPreset:name=>name===saved.preset?selectedPreset:undefined,proxies:()=>proxies,
        getActiveSecretId:()=>keyState.id});
    return {context,settings,saved,selectedPreset,proxies,keyState,resolve};
}

test('a Custom/Codex profile freezes its target and mapped sampling without switching narrator settings',async()=>{
    const h=fixture(),before=structuredClone({context:h.context,settings:h.settings});
    const snapshot=await h.resolve();
    assert.equal(snapshot.settings.chat_completion_source,'custom');assert.equal(snapshot.model,'world-model');
    assert.equal(snapshot.settings.custom_url,'http://127.0.0.1:8901/codex/v1');
    assert.equal(snapshot.settings.temp_openai,0.3);assert.equal(snapshot.settings.reasoning_effort,'low');
    assert.equal(snapshot.settings.stream_openai,false);assert.equal(snapshot.settings.n,1);
    assert.equal(snapshot.settings.function_calling,true);assert.equal(snapshot.settings.bias_preset_selected,'');
    for(const key of ['reverse_proxy','proxy_password','custom_include_headers','custom_include_body','custom_exclude_body',
        'custom_prompt_post_processing','azure_base_url','vertexai_express_project_id'])assert.equal(snapshot.settings[key],'',key);
    assert.deepEqual({context:h.context,settings:h.settings},before);
    assert.match(snapshot.fingerprint,/^[0-9a-f]{64}$/);
    const report=JSON.stringify({descriptor:snapshot.descriptor,fingerprint:snapshot.fingerprint});
    assert.doesNotMatch(report,/http|password|Authorization|narrator-private-test/);
    assert.equal(snapshot.descriptor.profileId,'simulation');snapshot.assertCurrent();
});

test('Vertex profile preserves its auth/region preset and clears unrelated Custom post-processing',async()=>{
    const h=fixture({source:'vertexai',profile:{'api-url':'europe-west4','secret-id':'opaque-selected-key'},
        preset:{vertexai_auth_mode:'full',vertexai_region:'us-central1',vertexai_express_project_id:'world-project',
            custom_prompt_post_processing:'single',use_sysprompt:false}});
    const connection=await h.resolve();
    assert.equal(connection.settings.vertexai_model,'world-model');assert.equal(connection.settings.vertexai_region,'europe-west4');
    assert.equal(connection.settings.vertexai_auth_mode,'full');assert.equal(connection.settings.vertexai_express_project_id,'world-project');
    assert.equal(connection.settings.use_sysprompt,true);assert.equal(connection.settings.custom_prompt_post_processing,'');
    assert.deepEqual(connection.payloadOverrides,{secret_id:'opaque-selected-key'});
    assert.ok(!JSON.stringify(connection.descriptor).includes('opaque-selected-key'));
    const google=fixture({source:'makersuite'});assert.equal((await google.resolve()).settings.google_model,'world-model');
});

test('selected preset headers and named proxy are honored without modifying saved presets',async()=>{
    const h=fixture({profile:{proxy:'World proxy'},preset:{custom_include_headers:'Authorization: world-private-test',
        custom_include_body:'custom: world',custom_prompt_post_processing:'strict_tools'}});
    h.proxies.push({name:'World proxy',url:'https://world-proxy.example',password:'world-password-test'});
    const before=structuredClone(h.selectedPreset),connection=await h.resolve();
    assert.equal(connection.settings.custom_include_headers,'Authorization: world-private-test');
    assert.equal(connection.settings.custom_prompt_post_processing,'strict_tools');
    assert.equal(connection.settings.reverse_proxy,'https://world-proxy.example');
    assert.deepEqual(h.selectedPreset,before);
    const vertex=fixture({source:'vertexai',profile:{proxy:'World proxy'}});vertex.proxies.push(...h.proxies);
    const resolved=await vertex.resolve();
    assert.equal(resolved.payloadOverrides.reverse_proxy,'https://world-proxy.example');
    assert.equal(resolved.payloadOverrides.proxy_password,'world-password-test');
});

test('incomplete, disabled, deleted and tool-stripping profiles fail explicitly instead of falling back',async()=>{
    for(const [mutate,pattern] of [
        [h=>h.context.extensionSettings.disabledExtensions=['connection-manager'],/Enable Connection Manager/],
        [h=>h.context.extensionSettings.connectionManager.profiles=[],/no longer exists/],
        [h=>h.saved.mode='tc',/Chat Completion/],
        [h=>h.saved.api='unknown',/Chat Completion/],
        [h=>delete h.saved.model,/Save a model/],
        [h=>h.saved.exclude=['model'],/Save a model/],
        [h=>delete h.saved.preset,/settings preset/],
        [h=>h.saved.exclude=['preset'],/settings preset/],
        [h=>h.saved.proxy='missing',/proxy preset/],
        [h=>h.selectedPreset.custom_prompt_post_processing='single',/preserves tools/],
    ]){const h=fixture();mutate(h);await assert.rejects(h.resolve(),pattern);}
    assert.equal(await resolveSimulationConnection({},''),null);
});

test('profile, preset, proxy and subscription changes invalidate the snapshot; harmless key order does not',async()=>{
    for(const mutate of [h=>h.saved.model='changed',h=>h.selectedPreset.temperature=0.8,
        h=>h.context.extensionSettings.connectionManager.profiles=[],h=>h.context.extensionSettings.subscriptions.codex.effort='max']){
        const h=fixture(),snapshot=await h.resolve();mutate(h);assert.throws(()=>snapshot.assertCurrent(),/simulation connection profile/);
    }
    const h=fixture({profile:{proxy:'P'}});h.proxies.push({name:'P',url:'https://proxy.example',password:'test'});
    const snapshot=await h.resolve();h.proxies[0].password='new';assert.throws(()=>snapshot.assertCurrent(),/settings changed/);
    const ordered=fixture(),first=await ordered.resolve();
    ordered.context.extensionSettings.connectionManager.profiles=[Object.fromEntries(Object.entries(ordered.saved).reverse())];
    first.assertCurrent();const second=await ordered.resolve();assert.equal(first.fingerprint,second.fingerprint);
});

function transportFixture(connection,{response,decorate,fetchRequest,retryOptions}={}) {
    const schema={type:'object',properties:{content:{type:'string'}},required:['content']};
    const tools=['UpdateBlackboard','Unrelated'].map(name=>({toFunctionOpenAI:()=>({type:'function',function:{name,parameters:schema}})}));
    const wires=[],converted=[],events=[];
    const request=createPrivateRequest({connection,settings:{},getModel:()=>assert.fail('Selected model is frozen'),
        createParameters:async(settings,model,type,messages)=>{
            converted.push({settings:structuredClone(settings),model,type});
            return {generate_data:{chat_completion_source:settings.chat_completion_source,model,messages,
                temperature:settings.temp_openai,reasoning_effort:settings.reasoning_effort,custom_url:settings.custom_url}};
        },context:{ToolManager:{tools},eventTypes:{CHAT_COMPLETION_SETTINGS_READY:'ready'},
            eventSource:{emit:async(event,data)=>{events.push(event);await decorate?.(data);}},
            getRequestHeaders:()=>({'X-CSRF-Token':'fixture'}),extractMessageFromData:data=>data?.choices?.[0]?.message?.content??''},
        fetchRequest:async(url,init)=>{assert.equal(url,'/api/backends/chat-completions/generate');wires.push(init.body);
            return fetchRequest?fetchRequest(url,init):{ok:true,json:async()=>response??({choices:[{message:{content:'OK'}}]})};},
        retryOptions,onWait:retryOptions?.onWait});
    return {request,wires,converted,events,schema};
}

test('selected requests retain endpoint decorators, restore tools, add dice and preserve raw tool calls',async()=>{
    const h=fixture(),connection=await h.resolve();
    const t=transportFixture(connection,{decorate:data=>{data.custom_include_body='subscriptions: {codex: {effort: low}}';
        data.stream=true;data.n=9;data.tools=[{function:{name:'Unrelated'}}];data.tool_choice='required';},
        response:{model:'actual-world-model',choices:[{message:{content:'',tool_calls:[{function:{name:'UpdateBlackboard',arguments:'{"content":"board","base_revision":0}'}}]},finish_reason:'tool_calls'}]}});
    const response=await t.request([{role:'user',content:'Act'}],['UpdateBlackboard',DICE_TOOL_NAME]);
    const wire=JSON.parse(t.wires[0]);assert.equal(wire.custom_url,'http://127.0.0.1:8901/codex/v1');
    assert.equal(wire.temperature,0.3);assert.equal(wire.reasoning_effort,'low');assert.equal(wire.stream,false);assert.equal(wire.n,1);
    assert.equal(wire.tool_choice,undefined);assert.match(wire.custom_include_body,/subscriptions/);
    assert.deepEqual(wire.tools.map(tool=>tool.function.name),['UpdateBlackboard',DICE_TOOL_NAME]);
    assert.deepEqual(wire.tools[0].function.parameters.required,['content','base_revision']);
    assert.deepEqual(t.schema.required,['content']);assert.equal(response.calls[0].name,'UpdateBlackboard');
    assert.equal(response.model,'actual-world-model');assert.deepEqual(t.events,['ready']);
    await t.request([],[]);assert.equal(JSON.parse(t.wires[1]).tools,undefined);
});

test('selected reverse proxy bypasses global ST validation and is attached after parameter conversion',async()=>{
    const h=fixture({source:'vertexai',profile:{proxy:'P','secret-id':'world-key'}});
    h.proxies.push({name:'P',url:'https://world.example',password:'world-password'});
    const t=transportFixture(await h.resolve());await t.request([],['UpdateBlackboard']);
    assert.equal(t.converted[0].settings.reverse_proxy,'');assert.equal(t.converted[0].settings.proxy_password,'');
    const wire=JSON.parse(t.wires[0]);assert.equal(wire.reverse_proxy,'https://world.example');assert.equal(wire.secret_id,'world-key');
});

test('provider retries reuse the frozen wire; a changed profile during cooldown stops another paid request',async()=>{
    for(const change of [false,true]){
        const h=fixture();let attempts=0;const waits=[];
        const t=transportFixture(await h.resolve(),{fetchRequest:async()=>++attempts===1
            ?{ok:false,status:429,headers:{get:()=> '1'},json:async()=>({error:{message:'Resource exhausted'}})}
            :{ok:true,json:async()=>({choices:[{message:{content:'OK'}}]})},
            retryOptions:{maxRetries:1,onWait:wait=>waits.push(wait),wait:async()=>{if(change)h.saved.model='different';}}});
        if(change){await assert.rejects(t.request([],['UpdateBlackboard']),/simulation connection profile/);assert.equal(attempts,1);}
        else{await t.request([],['UpdateBlackboard']);assert.equal(attempts,2);assert.equal(t.wires[0],t.wires[1]);}
        assert.equal(waits.length,1);
    }
});

test('missing UpdateBlackboard schema prevents any provider request',async()=>{
    const h=fixture(),connection=await h.resolve();let requested=false;
    const request=createPrivateRequest({connection,settings:{},getModel:()=>'',createParameters:async()=>({generate_data:{}}),
        context:{eventSource:{emit:async()=>{}},eventTypes:{},getRequestHeaders:()=>({})},
        fetchRequest:async()=>{requested=true;assert.fail('Missing schema must be detected locally');}});
    await assert.rejects(request([],['UpdateBlackboard']),/could not register UpdateBlackboard/);assert.equal(requested,false);
});

test('known unsupported native routes are rejected; another provider cannot borrow narrator model metadata',async()=>{
    const unsupported=fixture({source:'custom'});unsupported.context.ToolManager={isToolCallingSupported:()=>false};
    await assert.rejects(unsupported.resolve(),/model does not support function tools/);
    const other=fixture({source:'vertexai'});other.context.ToolManager={isToolCallingSupported:()=>assert.fail('Unrelated narrator catalog')};
    await other.resolve();
    const source=fixture({source:'custom'});source.context.CONNECT_API_MAP.no_tools={selected:'openai',source:'perplexity'};
    source.saved.api='no_tools';await assert.rejects(source.resolve(),/route/);
    const responses=fixture({source:'custom'});responses.context.CONNECT_API_MAP.native={selected:'openai',source:'openai'};
    responses.saved.api='native';responses.saved.model='gpt-6-astra';await assert.rejects(responses.resolve(),/route/);
});

test('ST default named None proxy is an explicit empty proxy, not a missing-profile error',async()=>{
    const h=fixture({profile:{proxy:'None'}});h.proxies.push({name:'None',url:'',password:''});
    const snapshot=await h.resolve();assert.equal(snapshot.settings.reverse_proxy,'');assert.equal(snapshot.settings.proxy_password,'');
});

test('an inherited active API key is frozen as an opaque selector, guarded and hashed without export',async()=>{
    const h=fixture();h.keyState.id='opaque-active-world-key';
    const first=await h.resolve();assert.equal(first.payloadOverrides.secret_id,'opaque-active-world-key');
    assert.doesNotMatch(JSON.stringify(first.descriptor),/opaque-active-world-key/);first.assertCurrent();
    h.keyState.id='rotated-world-key';assert.throws(()=>first.assertCurrent(),/active API key changed/);
    const second=await h.resolve();assert.notEqual(first.fingerprint,second.fingerprint);
    h.keyState.id='opaque-active-world-key';assert.equal((await h.resolve()).fingerprint,first.fingerprint);
    first.assertCurrent();
    const explicit=fixture({profile:{'secret-id':'explicit-world-key'}});
    const snapshot=await explicit.resolve();explicit.keyState.id='another-global-key';snapshot.assertCurrent();
    assert.equal(snapshot.payloadOverrides.secret_id,'explicit-world-key');
});

test('keyless sidecars detect a newly selected implicit key rather than changing authentication midway',async()=>{
    const h=fixture(),snapshot=await h.resolve();assert.deepEqual(snapshot.payloadOverrides,{});
    h.keyState.id='new-key';assert.throws(()=>snapshot.assertCurrent(),/active API key changed/);
});
