import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecovery } from '../recovery.js';
import { browserEnvironment } from './browser-fixtures.mjs';
import { createPrivateInterceptor } from '../private-host.js';
import { createPrivateRequest, normalizeBlackboardResponse } from '../private-api.js';

function harness({ run, makeRequest, generate, saveReply, saveChat, recoveryFactory } = {}) {
    const handlers = new Map(), log = [], errors = [];
    const eventSource = {
        on(name, f) { const list = handlers.get(name) || []; list.push(f); handlers.set(name, list); },
        removeListener(name, f) { handlers.set(name, (handlers.get(name) || []).filter(x => x !== f)); },
        async emit(name, ...args) { for (const f of [...handlers.get(name) || []]) await f(...args); },
    };
    const names = ['GENERATION_STARTED', 'GENERATION_STOPPED', 'CHAT_CHANGED', 'GENERATE_AFTER_DATA'];
    let ctx = {
        chat: [{ is_user: true, mes: 'Open the door.' }], chatMetadata: {}, mainApi: 'openai',
        chatCompletionSettings: { model: 'test', stream_openai: true, n: 3 },
        eventTypes: Object.fromEntries(names.map(n => [n, n])), eventSource,
        canPerformToolCalls: () => true,
        ToolManager: { invokeFunctionTool: async (name, args) => { log.push([name, JSON.parse(args)]); return 'roll: 17'; } },
        async generate(type, options, dryRun) {
            log.push(['build', type, dryRun]);
            assert.equal(dryRun, true);
            await eventSource.emit('GENERATION_STARTED', type, options, true);
            if (generate) await generate(ctx, options);
            else await eventSource.emit('GENERATE_AFTER_DATA', { prompt: [{role:'system',content:'Card + lorebook + injections'}, {role:'user',content:'Open the door.'}] }, true);
        },
        async saveReply(data) {
            log.push(['publish', data.type]);
            if (saveReply) return saveReply(ctx, data);
            if (data.type === 'swipe') ctx.chat.at(-1).mes = data.getMessage;
            else ctx.chat.push({ is_user: false, mes: data.getMessage });
        },
        async saveChat() { log.push('save'); if (saveChat) await saveChat(ctx); },
    };
    const result = { data: { choices: [{message:{content:'Reviewed response'}}] },
        commit() { log.push('commit'); }, rollback() { log.push('rollback'); },
        afterSave() { log.push('background'); }, release() { log.push('release'); },
    };
    let isEnabled = true;
    const recovery = recoveryFactory?.(() => ctx);
    const intercept = createPrivateInterceptor({ getContext: () => ctx, recovery, enabled: () => isEnabled,
        makeRequest: makeRequest || (async () => async () => ({text:'reply'})),
        run: async host => { log.push('run'); return run ? run(host, result, ctx) : result; },
        onFailure: (e, detail) => errors.push({ message: e.message, ...detail }),
    });
    return { intercept, recovery, get ctx() { return ctx; }, set ctx(value) { ctx = value; }, log, errors, handlers, result,
        disable() { isEnabled = false; },
        async turn(type = 'normal') {
            await eventSource.emit('GENERATION_STARTED', type, {}, false);
            await intercept([], 10000, flag => { assert.equal(flag,true); log.push('abort-native'); }, type);
        },
    };
}

test('standalone interceptor takes full dry-run context; publishes only after commit and saves before background', async () => {
    const h = harness({ run: async (host, result, ctx) => {
        assert.match(host.messages[0].content, /Card \+ lorebook/);
        assert.equal(ctx.chat.length, 1);
        assert.deepEqual(await host.request(host.messages, []), {text:'reply'});
        assert.equal(await host.invoke('RollTheDice', {formula:'1d20'}), 'roll: 17');
        return result;
    }});
    await h.turn(undefined);
    assert.deepEqual(h.log.filter(x => typeof x === 'string'), ['abort-native','run','commit','save','background','save','release']);
    assert.equal(h.ctx.chat.length,2);
    assert.deepEqual(h.errors,[]);
    for (const event of ['GENERATION_STOPPED','CHAT_CHANGED','GENERATE_AFTER_DATA']) assert.equal(h.handlers.get(event).length, 0);
});

for (const type of ['quiet','impersonate']) test(`${type} bypasses the private interceptor`, async () => {
    const h=harness(); await h.turn(type); assert.deepEqual(h.log, []);
});
test('disabled private mode leaves native generation alone', async () => {
    const h=harness(); h.disable(); await h.turn(); assert.deepEqual(h.log, []);
});
for (const type of ['regenerate','swipe']) test(`${type} reaches native prompt builder and saveReply with correct type`, async () => {
    const h=harness(); if(type==='swipe') h.ctx.chat.push({is_user:false,mes:'old'});
    await h.turn(type);
    assert.deepEqual(h.log.find(x=>Array.isArray(x)&&x[0]==='build'),['build',type,true]);
    assert.deepEqual(h.log.find(x=>Array.isArray(x)&&x[0]==='publish'),['publish',type]);
    assert.equal(h.ctx.chat.length,2); assert.deepEqual(h.errors,[]);
});
test('Continue and unsupported backends are stopped without a native fallback', async () => {
    const h=harness(); await h.turn('continue'); assert.deepEqual(h.log,['abort-native']);
    assert.match(h.errors[0].message,/Continue/);
    h.ctx.mainApi='kobold'; await h.turn(); assert.match(h.errors[1].message,/Chat Completion/);
});
test('missing assembled context does not call model or publish', async () => {
    const h=harness({generate:async()=>{}}); await h.turn();
    assert.match(h.errors[0].message,/did not produce/); assert.ok(!h.log.includes('run'));
});
test('cancel during context building discards the attempt, removes listeners and allows retry', async () => {
    let cancel=true;
    const h=harness({generate:async ctx=>{
        if(cancel) await ctx.eventSource.emit('GENERATION_STOPPED');
        await ctx.eventSource.emit('GENERATE_AFTER_DATA',{prompt:[{role:'user',content:'act'}]},true);
    }});
    await h.turn(); assert.equal(h.errors[0].cancelled,true); assert.ok(!h.log.includes('run'));
    cancel=false; await h.turn(); assert.ok(h.log.includes('commit'));
});
test('stop cancels the in-flight request and never publishes its late response', async () => {
    const h=harness({makeRequest:async ctx=>async(_messages,_allowed,signal)=>{
        await ctx.eventSource.emit('GENERATION_STOPPED'); assert.equal(signal.aborted,true); return {text:'late'};
    },run:async(host,result)=>{await host.request([],[]); return result;}});
    await h.turn(); assert.equal(h.errors[0].cancelled,true); assert.ok(!h.log.includes('commit'));
});
test('background quiet generation does not cancel the private turn', async () => {
    const h=harness({run:async(host,result,ctx)=>{
        await ctx.eventSource.emit('GENERATION_STARTED','quiet',{},false);
        assert.equal(host.signal.aborted,false);
        return result;
    }});
    await h.turn(); assert.deepEqual(h.errors,[]);assert.ok(h.log.includes('commit'));
});
test('chat and provider changes during a request reject its result', async () => {
    for (const change of [ctx=>{ctx.chatMetadata={};},ctx=>{ctx.chatCompletionSettings.model='other';}]) {
        const h=harness({makeRequest:async ctx=>async()=>{change(ctx);return {text:'late'};},run:async(host,result)=>{await host.request([],[]);return result;}});
        await h.turn(); assert.match(h.errors[0].message,/changed/); assert.ok(!h.log.includes('commit'));
    }
});
test('publication failure before insertion rolls board back', async () => {
    const h=harness({saveReply:async()=>{throw new Error('render failed');}}); await h.turn();
    assert.ok(h.log.includes('rollback')); assert.equal(h.errors[0].published,false);
});
test('save failure after publication keeps board and does not run background', async () => {
    const h=harness({saveChat:async()=>{throw new Error('save failed');}}); await h.turn();
    assert.ok(!h.log.includes('rollback')); assert.ok(!h.log.includes('background'));
    assert.equal(h.errors[0].published,true); assert.equal(h.ctx.chat.length,2);
});
test('listener failure after insertion keeps published state', async () => {
    const h=harness({saveReply:async(ctx,data)=>{ctx.chat.push({mes:data.getMessage});throw new Error('listener failed');}});
    await h.turn(); assert.equal(h.errors[0].published,true); assert.ok(!h.log.includes('rollback'));
});

test('private transport keeps settings and native schemas intact, strips unrelated tools and disables streaming per request', async () => {
    const settings={stream_openai:true,n:4}; const schema={properties:{},required:[]};
    const tools=[{function:{name:'UpdateBlackboard',parameters:schema},toString(){return 'native';}}, {function:{name:'Unrelated',parameters:{}}}];
    const wire=[];
    const request=createPrivateRequest({ settings,getModel:()=> 'model',
        createParameters:async s=>{assert.notEqual(s,settings);assert.equal(s.stream_openai,false);return {generate_data:{tools}};},
        context:{eventTypes:{CHAT_COMPLETION_SETTINGS_READY:'settings'},eventSource:{emit:async(_name,data)=>{data.stream=true;data.n=6;}},getRequestHeaders:()=>({'X-CSRF-Token':'test'}),extractMessageFromData:()=> 'OK'},
        fetchRequest:async(url,init)=>{assert.equal(url,'/api/backends/chat-completions/generate');wire.push(JSON.parse(init.body));return {ok:true,json:async()=>({choices:[{message:{content:'OK'}}]})};},
    });
    await request([],['UpdateBlackboard']); await request([],[]);
    assert.deepEqual(settings,{stream_openai:true,n:4}); assert.deepEqual(schema,{properties:{},required:[]});
    assert.equal(wire[0].stream,false);assert.equal(wire[0].n,1);assert.equal(wire[0].tools.length,1);
    assert.deepEqual(wire[0].tools[0].function.parameters.required,['base_revision']);assert.equal(wire[1].tools,undefined);
});
for(const data of [
    {choices:[{message:{tool_calls:[{function:{name:'RollTheDice',arguments:'{}'}}]}}]},
    {content:[{type:'tool_use',name:'RollTheDice',input:{}}]},
    {responseContent:{parts:[{functionCall:{name:'RollTheDice',args:{}}}]}},
    {message:{tool_calls:[{function:{name:'RollTheDice',arguments:{}}}]}},
]) test('provider tool response normalization',()=>{assert.equal(normalizeBlackboardResponse(data,'','m').calls[0].name,'RollTheDice');});

test('API errors and cancellation cannot be treated as a model answer', async () => {
    for(const reply of [{ok:false,status:502,json:async()=>({error:'upstream'})},{ok:true,json:async()=>({error:{message:'quota'}})}]) {
        const request=createPrivateRequest({settings:{},getModel:()=> 'm',createParameters:async()=>({generate_data:{}}),context:{eventSource:{emit:async()=>{}},eventTypes:{},getRequestHeaders:()=>({})},retryOptions:{maxRetries:0},fetchRequest:async()=>reply});
        await assert.rejects(request([],[]),/Private request failed/);
    }
    const controller=new AbortController();controller.abort();
    const request=createPrivateRequest({settings:{},getModel:()=> 'm',createParameters:()=>assert.fail('Cancelled request must not prepare or send'),context:{}});
    await assert.rejects(request([],[],controller.signal));
});


function memoryRecovery(getContext, environment = browserEnvironment()) {
    const ctx=getContext();ctx.chatId='test';ctx.characterId=0;ctx.characters=[{avatar:'test.png'}];
    const data=new Map();
    return createRecovery({getContext,environment,getBoard:()=> 'baseline',setBoard:()=>{},settings:()=>({}),getAccount:async()=> 'user',
        store:{get:async k=>structuredClone(data.get(k)),put:async r=>data.set(r.key,structuredClone(r)),delete:async k=>data.delete(k)},
        locks:{request:async(_k,_opts,callback)=>callback({})},render:()=>{}});
}
test('durable host resumes without rebuilding context, adding a user message, or losing checkpoint',async()=>{
    let attempts=0;const h=harness({recoveryFactory:memoryRecovery,run:async(host,result)=>{
        if(!attempts++){await host.saveCheckpoint({version:1,draft:{rolls:[{result:17}]},phase:'review'});throw new Error('429');}
        assert.equal(host.checkpoint.draft.rolls[0].result,17);return result;
    }});
    await h.turn();assert.equal(h.errors[0].saved,true);assert.equal(h.ctx.chat.length,1);
    await h.intercept.resume();assert.equal(h.ctx.chat.length,2);
    assert.equal(h.log.filter(x=>Array.isArray(x)&&x[0]==='build').length,1);
    assert.equal(await h.recovery.load(await h.recovery.key()),undefined);
});
test('pending checkpoint blocks a new native generation without overwriting saved work',async()=>{
    const h=harness({recoveryFactory:memoryRecovery,run:async host=>{await host.saveCheckpoint({saved:true});throw new Error('429');}});
    await h.turn();const key=await h.recovery.key(),before=await h.recovery.load(key);
    await h.turn();assert.match(h.errors.at(-1).message,/saved/);
    assert.deepEqual(await h.recovery.load(key),before);
});
test('publication storage failure retains published marker and blocks regeneration',async()=>{
    let saves=0;const h=harness({recoveryFactory:memoryRecovery,saveChat:async()=>{if(++saves>1)throw new Error('disk failure');}});
    await h.turn();assert.equal(h.ctx.chat.length,2);assert.equal(h.errors[0].published,true);
    const record=await h.recovery.load(await h.recovery.key());assert.equal(record.status,'published');
    await h.intercept.resume();assert.equal(h.ctx.chat.length,2);assert.match(h.errors.at(-1).message,/Publication/);
});

for (const unavailable of [{isSecureContext:false,navigator:{},crypto:{}},{indexedDB:undefined}]) test('unavailable browser stops before context building, model request or publication',async()=>{
    const env=browserEnvironment(unavailable);
    const h=harness({recoveryFactory:getContext=>memoryRecovery(getContext,env)});
    const before=structuredClone(h.ctx.chat);
    await h.turn();
    assert.deepEqual(h.log,['abort-native']);
    assert.match(h.errors[0].message,/Private Turns unavailable/);
    assert.deepEqual(h.ctx.chat,before);
});

test('resume on an unsupported browser preserves checkpoint and previous dice',async()=>{
    const env=browserEnvironment();
    const h=harness({recoveryFactory:getContext=>memoryRecovery(getContext,env),run:async host=>{
        await host.saveCheckpoint({draft:{rolls:[{result:17}]}});throw new Error('429');
    }});
    await h.turn();
    const scope=await h.recovery.key(),before=await h.recovery.load(scope);
    const count=h.log.length;
    env.crypto={};
    await h.intercept.resume();
    assert.match(h.errors.at(-1).message,/Private Turns unavailable/);
    assert.equal(h.log.length,count);
    assert.deepEqual(await h.recovery.load(scope),before);
});
