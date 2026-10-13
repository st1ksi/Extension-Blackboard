import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryInfo, retryRequest, interruptibleWait } from '../retry.js';
import { createPrivateRequest } from '../private-api.js';

test('temporary errors retry; authentication, billing and invalid input do not',()=>{
    for(const code of [429,500,502,503,504])assert.equal(retryInfo(code,{}).retryable,true);
    assert.equal(retryInfo(200,{error:'Vertex: RESOURCE_EXHAUSTED'}).retryable,true);
    assert.equal(retryInfo(429,{error:{code:'rate_limit_error'}}).retryable,true);
    for(const code of [400,401,403,404])assert.equal(retryInfo(code,{}).retryable,false);
    assert.equal(retryInfo(429,{error:{code:'insufficient_quota'}}).retryable,false);
    assert.equal(retryInfo(429,{error:{message:'billing limit reached'}}).retryable,false);
});
test('Retry-After accepts seconds and date; bounded waits respect the provider minimum',async()=>{
    assert.equal(retryInfo(429,{},'90').retryAfterMs,90000);
    assert.equal(retryInfo(429,{},'Thu, 08 Oct 2026 12:01:30 GMT',Date.parse('2026-10-08T12:00:00Z')).retryAfterMs,90000);
    let attempts=0;const waits=[];
    await assert.rejects(retryRequest(async()=>{attempts++;throw Object.assign(new Error('429'),{retryable:true,retryAfterMs:90000});},{wait:async ms=>waits.push(ms)}),/429/);
    assert.equal(attempts,4);assert.deepEqual(waits,[90000,120000,240000]);
});
test('pause interrupts backoff before another request',async()=>{
    let attempts=0;const controller=new AbortController();
    await assert.rejects(retryRequest(async()=>{attempts++;throw Object.assign(new Error('429'),{retryable:true});},{signal:controller.signal,onWait:()=>controller.abort()}));
    assert.equal(attempts,1);
    const c=new AbortController();const wait=interruptibleWait(60000,c.signal);c.abort();await assert.rejects(wait);
});
test('excessive Retry-After and permanent errors immediately pause',async()=>{
    for(const error of [{retryable:true,retryAfterMs:700000},{retryable:false}]){
        let attempts=0;await assert.rejects(retryRequest(async()=>{attempts++;throw Object.assign(new Error('stop'),error);},{wait:()=>assert.fail('No wait')}));
        assert.equal(attempts,1);
    }
});
test('transport retries the identical decorated wire body without rerunning decorators',async()=>{
    let prepared=0,attempts=0;const bodies=[];
    const request=createPrivateRequest({settings:{},getModel:()=> 'test',createParameters:async()=>{prepared++;return {generate_data:{messages:[{role:'user',content:'act'}]}};},
        context:{eventSource:{emit:async()=>{}},eventTypes:{},getRequestHeaders:()=>({}),extractMessageFromData:()=> 'OK'},
        retryOptions:{wait:async()=>{}},fetchRequest:async(_url,init)=>{bodies.push(init.body);return ++attempts===1?{ok:false,status:429,json:async()=>({error:'Resource exhausted'})}:{ok:true,json:async()=>({choices:[{message:{content:'OK'}}]})};}});
    assert.equal((await request([],[])).text,'OK');assert.equal(prepared,1);assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);
});
