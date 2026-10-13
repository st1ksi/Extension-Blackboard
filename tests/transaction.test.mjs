import { pass, repair } from './review-fixtures.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DraftTurn, absoluteTime, diffBoards, runPrivateTurn, processRegister } from '../transaction.js';

const time = n => `Day 1, 02:15:${String(n).padStart(2, '0')}`;
const register = (n, processes = []) => '[MISC #simulation_processes]\n' + JSON.stringify({ version: 1, through: time(n), processes });
const clock = n => `[MISC #world_clock]\n- Time: ${time(n)}`;
const board = (n = 0) => `${clock(n)}\n${register(n)}\n[ENTITIES #hero]\nHP 20/20; gold 200.\n[SCENE #safe]\nClosed. Contains a note.`;
const update = (revision, content) => ({ name: 'UpdateBlackboard', arguments: JSON.stringify({ action: 'upsert', base_revision: revision, content }) });
const payload = messages => JSON.parse(messages.at(-1).content.split('\n').slice(1).join('\n'));

test('absolute times cross midnight; relative deadlines are rejected', () => {
    assert.equal(absoluteTime('Day 2, 00:00:00') - absoluteTime('Day 1, 23:59:54'), 6);
    assert.throws(() => absoluteTime('in 6 seconds'));
    assert.throws(() => absoluteTime('Day 1, 25:00:00'));
});
test('revisions are immutable; stale edits rejected; unchanged update is not a revision', () => {
    const d = new DraftTurn(board());
    d.update({ action: 'upsert', base_revision: 0, content: '[SCENE #safe]\nOpen; empty.' });
    assert.equal(d.revision, 1);
    assert.equal(d.versions[0].text, board());
    assert.throws(() => d.update({ action: 'delete', base_revision: 0, block_id: 'SCENE #safe' }), /Stale/);
    d.update({ action: 'upsert', base_revision: 1, content: '[SCENE #safe]\nOpen; empty.' });
    assert.equal(d.revision, 1);
});
test('full and diff packets reconstruct exactly the same successive states', () => {
    const d = new DraftTurn(board());
    d.update({ base_revision: 0, content: '[SCENE #safe]\nOpen; empty.' });
    d.update({ base_revision: 1, content: '[ENTITIES #hero]\nHP 20/20; gold 200; note.' });
    const p = d.packet();
    for (let i = 1; i < p.versions.length; i++) {
        assert.deepEqual(p.versions[i].changes, diffBoards(d.versions[i - 1].text, d.versions[i].text));
        assert.equal(p.versions[i].base_revision, i - 1);
    }
    d.mode = 'full'; assert.deepEqual(d.packet().versions, d.versions);
});
test('overdue process, orphan owner, missing progress and clock mismatch block commit', () => {
    const p = { id: 'patrol', owner: 'ENTITIES #hero', status: 'active', accounted_through: time(0), next_at: time(12), note: 'walking' };
    assert.ok(processRegister(board().replace(register(0), register(0, [p]))));
    for (const bad of [{ ...p, next_at: time(0) }, { ...p, owner: 'ENTITIES #missing' }, { ...p, accounted_through: time(6) }]) {
        assert.ok(new DraftTurn(board().replace(register(0), register(0, [bad]))).checks().length);
    }
    assert.ok(new DraftTurn(board().replace(clock(0), clock(6))).checks().length);
});
test('active processes cannot disappear without a recorded disposition', () => {
    const p = { id: 'patrol', owner: 'ENTITIES #hero', status: 'active', accounted_through: time(0), next_at: time(12), note: 'walking' };
    const d = new DraftTurn(board().replace(register(0), register(0, [p])));
    d.update({ base_revision: 0, content: register(0) });
    assert.match(d.checks().join(), /disappeared/);
});
test('turn stages, audits and returns without mutating caller state or messages', async () => {
    const canonical = board(), context = [{ role: 'user', content: 'Take the note.' }];
    const original = structuredClone(context); let step = 0;
    const result = await runPrivateTurn({ baseline: canonical, context, invoke: () => assert.fail('No tools expected'),
        request: async (messages, allowed) => {
            const p = payload(messages);
            if (p.phase === 'review') { assert.deepEqual(allowed, []); return pass(p); }
            if (!step++) return { calls: [update(0, '[SCENE #safe]\nOpen; empty.\n[ENTITIES #hero]\nHP 20/20; gold 200; note.')] };
            return { text: 'You take the note.' };
        },
    });
    assert.equal(canonical, board()); assert.deepEqual(context, original);
    assert.match(result.draft.head, /gold 200; note/);
    assert.equal(result.stats.reviews, 4);
});
test('repair cannot reroll; preserves exact dice receipt and does not advance time twice', async () => {
    let rolls = 0, simulations = 0, repairs = 0, reviews = 0;
    const result = await runPrivateTurn({ baseline: board(), context: [], invoke: async () => { rolls++; return 'The result is: 4. Individual rolls: 4'; },
        request: async messages => {
            const p = payload(messages);
            if (p.phase === 'review') {
                if (!reviews++) return repair(p);
                assert.equal(p.rolls.length, 1); assert.equal(p.rolls[0].result, 'The result is: 4. Individual rolls: 4'); return pass(p);
            }
            if (p.phase === 'simulate') {
                if (!simulations++) return { calls: [{ name: 'RollTheDice', arguments: { formula: '1d20' } }, update(0, clock(6) + '\n' + register(6))] };
                return { text: 'Candidate.' };
            }
            if (!repairs++) return { calls: [{ name: 'RollTheDice', arguments: { formula: '1d20' } }, update(1, '[ENTITIES #hero]\nHP 20/20; gold 200; at door.')] };
            assert.match(JSON.stringify(p.receipts), /Tool forbidden in repair/);
            return { text: 'Corrected.' };
        },
    });
    assert.equal(rolls, 1); assert.equal(result.stats.reviews, 5);
    assert.equal(processRegister(result.draft.head).through, time(6));
});
test('repeated malformed reports stop without world repairs', async () => {
    let reviews = 0;
    await assert.rejects(runPrivateTurn({ baseline: board(), context: [], invoke: () => {},
        request: async messages => {
            const p = payload(messages);
            if (p.phase !== 'review') return { text: 'Draft.' };
            reviews++; return { text: 'not valid JSON' };
        },
    }), /invalid report/);
    assert.equal(reviews, 2);
});
test('cancellation after network response discards turn before tool effects', async () => {
    const controller = new AbortController(); let invoked = false;
    await assert.rejects(runPrivateTurn({ baseline: board(), context: [], signal: controller.signal,
        invoke: () => { invoked = true; }, request: async () => { controller.abort(); return { calls: [{ name: 'RollTheDice' }] }; },
    }));
    assert.equal(invoked, false);
});
test('chat switch detected after response prevents updates and audit', async () => {
    let switched = false;
    await assert.rejects(runPrivateTurn({ baseline: board(), context: [], invoke: () => {},
        assertCurrent: () => { if (switched) throw new Error('switched'); },
        request: async () => { switched = true; return { text: 'Draft' }; },
    }), /switched/);
});
test('background remains queued and unexecuted before commit', async () => {
    let step = 0;
    const result = await runPrivateTurn({ baseline: board(), context: [], invoke: () => assert.fail('Premature side effect'),
        request: async messages => {
            const p = payload(messages);
            if (p.phase === 'review') return pass(p);
            return step++ ? { text: 'Draft' } : { calls: [{ name: 'SetSceneBackground', arguments: { prompt: 'Dark room' } }] };
        },
    });
    assert.deepEqual(result.draft.background, { prompt: 'Dark room' });
});

test('failed staging update prevents dependent dice in the same batch', async () => {
    let step = 0;
    await runPrivateTurn({ baseline: board(), context: [], invoke: () => assert.fail('Must not roll after failed preparation'),
        request: async messages => {
            const p = payload(messages);
            if (p.phase === 'review') return pass(p);
            if (!step++) return { calls: [update(99, '[SCENE #safe]\nOpen'), { name: 'RollTheDice', arguments: { formula: '1d20' } }] };
            assert.match(JSON.stringify(p.receipts), /dependent tools deferred/);
            return { text: 'No action resolved.' };
        },
    });
});
test('truncated model output cannot become a committed candidate', async () => {
    await assert.rejects(runPrivateTurn({ baseline: board(), context: [], invoke: () => {},
        request: async () => ({ text: 'A partial answer', finishReason: 'max_tokens' }),
    }), /output limit/);
});
test('closed processes can retain their actual completion time', () => {
    const p = { id: 'patrol', owner: 'ENTITIES #hero', status: 'completed', accounted_through: time(0), next_at: null, note: 'Finished' };
    assert.ok(processRegister(board(6).replace(register(6), register(6, [p]))));
});


for (const failurePhase of ['simulate', 'review', 'repair']) test(`resume pending ${failurePhase} request preserves versions, dice and review budget`, async () => {
    let checkpoint, rolls = 0, outage = true, simulations = 0, reviews = 0;
    const opts = { baseline: board(), context: [{role:'user',content:'Original action'}],
        saveCheckpoint: async value => { checkpoint = JSON.parse(JSON.stringify(value)); },
        invoke: async () => { rolls++; return 'The result is: 7. Individual rolls: 7'; },
        request: async messages => {
            const p = payload(messages);
            if (outage && ((p.phase === failurePhase && p.receipts.length) || (failurePhase === 'repair' && p.phase === 'repair'))) {
                outage = false; throw new Error('429');
            }
            if (p.phase === 'review') {
                if (failurePhase === 'repair' && !reviews++) return repair(p);
                return pass(p);
            }
            if (p.phase === 'repair') return {text:'Corrected answer'};
            if (!simulations++) return {calls:[update(0, clock(6)+'\n'+register(6)),{name:'RollTheDice',arguments:{formula:'1d20'}}]};
            return {text:'Candidate'};
        },
    };
    await assert.rejects(runPrivateTurn(opts), /429/);
    assert.equal(checkpoint.pending.messages.at(-1).content.includes(failurePhase), true);
    const priorRequests = checkpoint.stats.requests;
    const frozenRequest = structuredClone(checkpoint.pending.messages);
    let first = true;
    const result = await runPrivateTurn({...opts, checkpoint, context:[{role:'user',content:'Must not replace saved context'}],
        request: async (...args) => { if(first){assert.deepEqual(args[0],frozenRequest);first=false;} return opts.request(...args); },
    });
    assert.equal(rolls,1); assert.equal(result.draft.rolls[0].result,'The result is: 7. Individual rolls: 7');
    assert.equal(processRegister(result.draft.head).through,time(6));
    assert.ok(result.stats.requests >= priorRequests);
    assert.equal(result.stats.repairs, failurePhase === 'repair' ? 1 : 0);
});

test('resume halfway through a tool batch executes only remaining calls', async () => {
    let checkpoint, rolls=0, interrupted=false;
    const controller=new AbortController();
    const opts={baseline:board(),context:[],invoke:async()=>{rolls++;return 'The result is: 11. Individual rolls: 11';},
        saveCheckpoint:async state=>{checkpoint=structuredClone(state);if(state.callIndex===1&&!interrupted){interrupted=true;controller.abort();}},
        request:async messages=>{
            const p=payload(messages);if(p.phase==='review')return pass(p);
            if(!p.receipts.length)return {calls:[{name:'RollTheDice',arguments:{formula:'1d20'}},update(0,'[ENTITIES #hero]\nHP 19/20; gold 200.')]};
            return {text:'Finished'};
        }};
    await assert.rejects(runPrivateTurn({...opts,signal:controller.signal}));
    assert.equal(checkpoint.callIndex,1);assert.equal(rolls,1);
    const result=await runPrivateTurn({...opts,checkpoint});
    assert.equal(rolls,1);assert.match(result.draft.head,/HP 19/);
});

test('crash during an external tool leaves an uncertain marker and forbids replay', async () => {
    let durable, rolls=0;
    const opts={baseline:board(),context:[],invoke:async()=>{rolls++;return 'The result is: 9. Individual rolls: 9';},
        request:async()=>({calls:[{name:'RollTheDice',arguments:{formula:'1d20'}}]}),
        saveCheckpoint:async state=>{if(state.callIndex===1)throw new Error('disk full');durable=structuredClone(state);}};
    await assert.rejects(runPrivateTurn(opts),/disk full/);
    assert.equal(rolls,1);assert.equal(durable.inFlightTool.name,'RollTheDice');
    await assert.rejects(runPrivateTurn({...opts,checkpoint:durable,saveCheckpoint:async()=>{}}),/uncertain/);
    assert.equal(rolls,1);
});

test('storage failure before invocation prevents the dice tool entirely',async()=>{
    await assert.rejects(runPrivateTurn({baseline:board(),context:[],invoke:()=>assert.fail('No uncheckpointed dice'),
        request:async()=>({calls:[{name:'RollTheDice',arguments:{formula:'1d20'}}]}),
        saveCheckpoint:async state=>{if(state.inFlightTool)throw new Error('storage unavailable');}}),/storage unavailable/);
});

test('completed review resumes publication without another API call',async()=>{
    let checkpoint;
    await runPrivateTurn({baseline:board(),context:[],saveCheckpoint:async s=>{checkpoint=structuredClone(s);},request:async messages=>payload(messages).phase==='review'?pass(payload(messages)):{text:'Finished'}});
    const result=await runPrivateTurn({baseline:board(),checkpoint,request:()=>assert.fail('No new requests')});
    assert.equal(result.candidate,'Finished');assert.equal(result.stats.requests,5);
});


test('tool exception with unknown outcome stops rather than inviting a reroll',async()=>{
    let checkpoint,rolls=0;
    const options={baseline:board(),context:[],saveCheckpoint:async s=>{checkpoint=structuredClone(s);},
        request:async()=>({calls:[{name:'RollTheDice',arguments:{formula:'1d20'}}]}),
        invoke:async()=>{rolls++;throw new Error('result lost');}};
    await assert.rejects(runPrivateTurn(options),/result lost/);
    await assert.rejects(runPrivateTurn({...options,checkpoint}),/uncertain/);assert.equal(rolls,1);
});
