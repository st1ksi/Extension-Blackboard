import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPrivateReportArchive,openPrivateReportStore} from '../private-report-store.js';
import {memoryReportStore,reportDatabase} from './report-store-fixtures.mjs';

const context = () => ({chatId:'Campaign A',characterId:0,characters:[{avatar:'hero.png'}],chatMetadata:{},chat:[]});
function archiveHarness(store = memoryReportStore()) {
    let ctx = context(), account = 'alice';
    const create = () => createPrivateReportArchive({getContext:()=>ctx,getAccount:async()=>account,store});
    return {store,create,get ctx(){return ctx;},set ctx(value){ctx=value;},set account(value){account=value;},archive:create()};
}
const report = (candidate='Private working details',attempt_started=100,status='committed') => ({
    status,attempt_started,candidate,reviewMode:'light',auditLog:[{private:'analysis'}],versions:[{revision:0,text:'Secret board'}],
});

test('private report archive survives reconstruction and returns independent report objects',async()=>{
    const h=archiveHarness(), key=await h.archive.key(), original=report();
    await h.archive.save(key,original);
    original.auditLog[0].private='Caller mutation';
    const restored=await h.create().load(key);
    assert.equal(restored.candidate,'Private working details');
    assert.equal(restored.auditLog[0].private,'analysis');
    restored.auditLog[0].private='Reader mutation';
    assert.equal((await h.archive.load(key)).auditLog[0].private,'analysis');
    assert.deepEqual(h.ctx.chatMetadata,{}); assert.deepEqual(h.ctx.chat,[]);
});

test('report scope includes account, character avatar and saved chat ID with no cross-chat fallback',async()=>{
    const h=archiveHarness(), original=await h.archive.key();
    await h.archive.save(original,report());
    for(const mutate of [
        ()=>{h.ctx.chatId='Campaign B';},
        ()=>{h.ctx.characters[0].avatar='villain.png';},
        ()=>{h.account='bob';},
    ]) {
        h.ctx=context(); h.account='alice'; mutate();
        const different=await h.archive.key();
        assert.notEqual(different,original);
        assert.equal(await h.archive.load(different),null);
    }
    h.ctx=context();h.account='alice';
    assert.equal(await h.archive.key(),original);
    assert.equal((await h.archive.load(original)).candidate,'Private working details');
});

test('scope snapshots chat identity before awaiting account lookup',async()=>{
    const ctx=context();let resolveAccount;
    const archive=createPrivateReportArchive({getContext:()=>ctx,getAccount:()=>new Promise(resolve=>{resolveAccount=resolve;}),store:memoryReportStore()});
    const pending=archive.key();
    ctx.chatId='Campaign switched during lookup';ctx.characters[0].avatar='other.png';
    resolveAccount('alice');
    assert.equal(await pending,JSON.stringify(['alice','hero.png','Campaign A']));
});

test('unsaved or unidentified chats cannot share an anonymous private report slot',async()=>{
    const h=archiveHarness();
    h.ctx.chatId='';await assert.rejects(h.archive.key(),/chat|saved|select/i);
    h.ctx=context();h.ctx.characters=[];await assert.rejects(h.archive.key(),/character|chat|select/i);
    h.ctx=context();h.account='';await assert.rejects(h.archive.key(),/account|user|identify/i);
    assert.equal(h.store.records.size,0);
});

test('failed later attempts retain the previous completed report internally',async()=>{
    const h=archiveHarness(),key=await h.archive.key();
    await h.archive.save(key,report('Completed baseline',100));
    await h.archive.save(key,{...report('Failed later attempt',200,'failed'),reason:'429'});
    assert.equal((await h.archive.load(key)).status,'failed');
    const record=h.store.records.get(key);
    assert.equal(record.completedReport.candidate,'Completed baseline');
    assert.equal(record.report.reason,'429');
});

test('late persistence from an older attempt cannot overwrite a newer report',async()=>{
    const h=archiveHarness(),key=await h.archive.key();
    await h.archive.save(key,report('Newer attempt',200));
    await h.archive.save(key,report('Late old background completion',100));
    assert.equal((await h.archive.load(key)).candidate,'Newer attempt');
});

test('archive failures remain explicit, and a failed write does not poison later saves',async()=>{
    const h=archiveHarness(),key=await h.archive.key();
    h.store.error=new Error('Site storage denied');
    await assert.rejects(h.archive.save(key,report()),/Site storage denied/);
    await assert.rejects(h.archive.load(key),/Site storage denied/);
    h.store.error=null;
    await h.archive.save(key,report('Retry after storage recovery',200));
    assert.equal((await h.archive.load(key)).candidate,'Retry after storage recovery');
});

test('IndexedDB report store persists across new archive and connection instances',async()=>{
    const database=reportDatabase(),ctx=context();
    const create=()=>createPrivateReportArchive({getContext:()=>ctx,getAccount:async()=> 'alice',store:openPrivateReportStore(()=>database)});
    const first=create(),key=await first.key();
    await first.save(key,report());
    assert.equal((await create().load(key)).candidate,'Private working details');
    assert.ok(database.databases.has('objective-blackboard-reports'));
    assert.ok(!database.databases.has('objective-blackboard-private'),'Detailed reports do not replace pending-turn checkpoints.');
});

test('IndexedDB failures are reported instead of looking like an empty archive',async()=>{
    const database=reportDatabase();database.error=new Error('Browser storage blocked');
    const h=archiveHarness(openPrivateReportStore(()=>database)),key=await h.archive.key();
    await assert.rejects(h.archive.load(key),/storage|blocked/i);
    database.error=null;
    await h.archive.save(key,report('Storage works again',200));
    assert.equal((await h.archive.load(key)).candidate,'Storage works again');
});

for(const order of ['newer-first','older-first'])test(`separate archive connections atomically retain the newest attempt (${order})`,async()=>{
    const database=reportDatabase(),ctx=context();
    const create=()=>createPrivateReportArchive({getContext:()=>ctx,getAccount:async()=> 'alice',store:openPrivateReportStore(()=>database)});
    const newer=create(),older=create(),key=await newer.key();
    const tasks=order==='newer-first'
        ? [[newer,report('Newer concurrent turn',200)],[older,report('Older concurrent callback',100)]]
        : [[older,report('Older concurrent callback',100)],[newer,report('Newer concurrent turn',200)]];
    await Promise.all(tasks.map(([archive,value])=>archive.save(key,value)));
    assert.equal((await create().load(key)).candidate,'Newer concurrent turn');
});
