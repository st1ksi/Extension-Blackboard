import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSetupGate, setupRequirements, enableRequiredSettings, setupPanel } from '../setup-gate.js';

function harness(overrides = {}) {
    const handlers = new Map();
    const names = ['GENERATION_STOPPED','CHAT_CHANGED','MESSAGE_EDITED','MESSAGE_DELETED','MESSAGE_SWIPED','GENERATION_STARTED'];
    const ctx = { mainApi:'openai',chatId:'one',chat:[{is_user:true,mes:'Act'}],chatMetadata:{},
        chatCompletionSettings:{function_calling:false,use_sysprompt:false,chat_completion_source:'vertexai'},
        isToolCallingSupported:()=>true,
        eventTypes:Object.fromEntries(names.map(n=>[n,n])),
        eventSource:{on:(n,f)=>{if(!handlers.has(n))handlers.set(n,new Set());handlers.get(n).add(f);},removeListener:(n,f)=>handlers.get(n)?.delete(f)},...overrides };
    let enabled=true,actions,report,closed=0,aborted=0,syncs=0,panels=0;
    const guard=createSetupGate({getContext:()=>ctx,enabled:()=>enabled,disable:()=>{enabled=false;},synchronize:()=>syncs++,
        enableSettings:()=>{ctx.chatCompletionSettings.function_calling=true;ctx.chatCompletionSettings.use_sysprompt=true;},
        showPanel:()=>{panels++;return {update:(r,a)=>{report=r;actions=a;},close:()=>closed++};}});
    return {ctx,guard,start:(type='normal')=>guard(type,flag=>{assert.equal(flag,true);aborted++;}),
        emit:(n,...args)=>{for(const f of [...handlers.get(n)??[]])f(...args);},
        get actions(){return actions;},get report(){return report;},get enabled(){return enabled;},
        counts:()=>({closed,aborted,syncs,panels,listeners:[...handlers.values()].reduce((n,s)=>n+s.size,0)})};
}

test('provider-specific requirements do not demand a system checkbox from other providers',()=>{
    for(const source of ['vertexai','makersuite','claude','openai','custom']) {
        const h=harness();h.ctx.chatCompletionSettings.chat_completion_source=source;
        assert.deepEqual(setupRequirements(h.ctx).missing, ['vertexai','makersuite','claude'].includes(source)
            ? ['Enable function calling','Use system prompt'] : ['Enable function calling']);
    }
});
test('check keeps waiting until both settings are enabled, then resumes once without changing chat',async()=>{
    const h=harness(),before=structuredClone(h.ctx.chat);let resumed=0;
    const pending=h.start().then(ok=>{if(ok)resumed++;});
    h.actions.check(); await Promise.resolve();assert.equal(resumed,0);
    h.ctx.chatCompletionSettings.function_calling=true;h.actions.check();
    assert.deepEqual(h.report.missing,['Use system prompt']);
    h.ctx.chatCompletionSettings.use_sysprompt=true;h.actions.check();await pending;
    h.actions.check();assert.equal(resumed,1);assert.deepEqual(h.ctx.chat,before);
    assert.equal(h.counts().listeners,0);assert.equal(h.counts().aborted,0);
});
for(const type of ['normal','regenerate','swipe']) test(`${type}: auto-enable continues the held request`,async()=>{
    const h=harness(),p=h.start(type);h.actions.enable();assert.equal(await p,true);
    assert.equal(h.counts().closed,1);assert.equal(h.counts().listeners,0);
});
test('disable continues without modifying host settings',async()=>{
    const h=harness(),settings=structuredClone(h.ctx.chatCompletionSettings),p=h.start();
    h.actions.disable();assert.equal(await p,true);assert.equal(h.enabled,false);
    assert.deepEqual(h.ctx.chatCompletionSettings,settings);
    assert.equal(await h.start(),true);assert.equal(h.counts().panels,1);
});
for(const event of ['GENERATION_STOPPED','CHAT_CHANGED','MESSAGE_EDITED','MESSAGE_DELETED','MESSAGE_SWIPED','GENERATION_STARTED']) test(`${event}: cancel and release listeners; stale buttons cannot continue`,async()=>{
    const h=harness(),p=h.start();h.emit(event);assert.equal(await p,false);
    h.actions.enable();assert.equal(h.ctx.chatCompletionSettings.function_calling,false);
    assert.equal(h.counts().listeners,0);assert.equal(h.counts().aborted,1);
});
test('silent history mutation cancels when resuming; dry-run event does not cancel',async()=>{
    const h=harness(),p=h.start();h.emit('GENERATION_STARTED','normal',{},true);
    assert.equal(h.counts().closed,0);h.ctx.chat[0].mes='Different action';h.actions.enable();
    assert.equal(await p,false);assert.equal(h.ctx.chatCompletionSettings.function_calling,false);
});
test('unsupported model remains blocked after enabling, and Continue explains its restriction',async()=>{
    const h=harness({isToolCallingSupported:()=>false}),p=h.start();h.actions.enable();
    assert.match(h.report.blockers.join(),/does not support/);assert.equal(h.counts().closed,0);
    h.actions.disable();assert.equal(await p,true);
    assert.match(setupRequirements(h.ctx,'continue').blockers.join(),/does not call tools for Continue/);
});
test('quiet and impersonation bypass; ready setup creates no panel',async()=>{
    const h=harness();for(const type of ['quiet','impersonate'])assert.equal(await h.start(type),true);
    Object.assign(h.ctx.chatCompletionSettings,{function_calling:true,use_sysprompt:true});
    assert.equal(await h.start(),true);assert.equal(h.counts().panels,0);
});
test('native checkbox handlers receive correct events and settings are saved',()=>{
    const calls=[];globalThis.$=selector=>({prop:(key,value)=>({trigger:event=>calls.push([selector,key,value,event])})});
    const ctx=harness().ctx;ctx.saveSettingsDebounced=()=>calls.push('save');
    try{enableRequiredSettings(ctx);}finally{delete globalThis.$;}
    assert.deepEqual(calls,[['#openai_function_calling','checked',true,'input'],['#use_sysprompt','checked',true,'change'],'save']);
    assert.equal(setupRequirements(ctx).ready,true);
});
test('panel lists only missing requirements and exposes all three English actions',()=>{
    const node=()=>({children:[],dataset:{},append(...children){this.children.push(...children);},replaceChildren(){this.children=[];},setAttribute(){},remove(){this.removed=true;}});
    const body=node();globalThis.document={body,createElement:node};
    try{
        const panel=setupPanel();let clicks=0;
        panel.update({missing:['Use system prompt'],blockers:[]},{check:()=>clicks++,enable:()=>clicks++,disable:()=>clicks++});
        const root=body.children[0],buttons=root.children[3].children;
        assert.equal(root.id,'blackboard-setup-required');
        assert.deepEqual(buttons.map(b=>b.textContent),['Check again & continue','Enable settings & continue','Disable Blackboard & continue']);
        buttons.forEach(b=>b.onclick());assert.equal(clicks,3);
        panel.close();assert.equal(root.removed,true);
    }finally{delete globalThis.document;}
});

test('guard wrapper resumes the same native call, or aborts on Stop without invoking private runner',async()=>{
    const {withSetupGate}=await import('../private-host.js');
    for(const stop of [false,true]){
        const h=harness();let actions,runs=0,aborts=0;
        const chat=h.ctx.chat;
        const intercept=withSetupGate(async(received,size)=>{assert.equal(received,chat);assert.equal(size,8000);runs++;},{
            getContext:()=>h.ctx,enabled:()=>true,disable:()=>{},synchronize:()=>{},
            enableSettings:()=>Object.assign(h.ctx.chatCompletionSettings,{function_calling:true,use_sysprompt:true}),
            showPanel:()=>({update:(_r,a)=>{actions=a;},close(){}}),
        });
        const pending=intercept(chat,8000,()=>aborts++,'normal');
        assert.equal(runs,0);
        if(stop)h.emit('GENERATION_STOPPED');else actions.enable();
        await pending;
        assert.equal(runs,stop?0:1);assert.equal(aborts,stop?1:0);
        assert.equal(chat.length,1);
    }
});

test('enabling tools rebuilds the native frame with depth=1 so execution uses refreshed flags without inserting another message',async()=>{
    const {withSetupGate}=await import('../private-host.js');
    const h=harness();h.ctx.isToolCallingSupported=()=>h.ctx.chatCompletionSettings.function_calling;
    let actions,privateCalls=0,nativeCalls=0,intercept;
    const options={automatic_trigger:false,force_name2:true};
    h.ctx.generate=async(type,received)=>{
        nativeCalls++;assert.equal(type,'regenerate');assert.equal(received.depth,1);assert.equal(received.force_name2,true);
        const cachedCanPerform=h.ctx.isToolCallingSupported();
        await intercept(h.ctx.chat,8000,()=>assert.fail('Ready nested frame must not abort'),'regenerate');
        assert.equal(cachedCanPerform,true,'New native frame sees enabled function calling');
        assert.equal(h.ctx.chat.length,1,'Continuation never inserts a user message');
    };
    intercept=withSetupGate(async()=>privateCalls++,{
        getContext:()=>h.ctx,enabled:()=>true,disable:()=>{},synchronize:()=>{},
        enableSettings:()=>Object.assign(h.ctx.chatCompletionSettings,{function_calling:true,use_sysprompt:true}),
        showPanel:()=>({update:(_r,a)=>{actions=a;},close(){}}),
    });
    h.emit('GENERATION_STARTED','regenerate',options,false);
    let aborts=0;
    const pending=intercept(h.ctx.chat,8000,flag=>{assert.equal(flag,true);aborts++;},'regenerate');
    actions.enable();await pending;
    assert.equal(nativeCalls,1);assert.equal(aborts,1);assert.equal(privateCalls,1);
});
