import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecovery } from '../recovery.js';
import { browserEnvironment } from './browser-fixtures.mjs';

function harness(settings = {privateReview:true,privateReviewMode:'heavy'}) {
    const records = new Map();
    const context = {chatId:'campaign',characterId:0,characters:[{avatar:'hero.png'}],chat:[{is_user:true,mes:'Wait.'}],
        chatMetadata:{blackboard_engine:{turn:1}},chatCompletionSettings:{model:'one'}};
    const api = createRecovery({getContext:()=>context,getBoard:()=> 'baseline',settings:()=>settings,getAccount:async()=> 'user',
        environment:browserEnvironment(),store:{get:async key=>records.get(key),put:async value=>records.set(value.key,structuredClone(value)),delete:async key=>records.delete(key)}});
    return {api,context,settings,create:async()=>api.create(context,'normal',[{role:'user',content:'Frozen action.'}],await api.key())};
}

for (const mode of ['light','heavy']) test(`recovery settings fingerprint rejects switching a saved ${mode} private turn`, async () => {
    const h = harness({privateReview:true,privateReviewMode:mode});
    const record = await h.create(); record.checkpoint = {reviewMode:mode,draft:{}};
    await h.api.validate(record,h.context);
    h.settings.privateReviewMode = mode === 'light' ? 'heavy' : 'light';
    await assert.rejects(h.api.validate(record,h.context), /settings.*changed|settings/i);
});

test('older recovery record without the new mode setting accepts only the added heavy default', async () => {
    const h = harness({privateReview:true});
    const record = await h.create(); record.checkpoint = {version:4,draft:{}};
    h.settings.privateReviewMode = 'heavy';
    await h.api.validate(record,h.context);
    h.settings.privateReviewMode = 'light';
    await assert.rejects(h.api.validate(record,h.context), /settings/i);
});

test('heavy migration compatibility does not forgive unrelated setting changes', async () => {
    const h = harness({privateReview:true,simulationFidelity:'ultra'});
    const record = await h.create(); record.checkpoint = {version:4,draft:{}};
    h.settings.privateReviewMode = 'heavy';
    await h.api.validate(record,h.context);
    h.settings.simulationFidelity = 'high';
    await assert.rejects(h.api.validate(record,h.context), /settings/i);
});
