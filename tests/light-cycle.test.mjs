// State-machine fixtures verify routing, durable findings and side effects;
// they intentionally make no claim about a real model's semantic judgement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPrivateTurn, processRegister } from '../transaction.js';
import { REVIEW_STAGES } from '../review.js';
import { payload, report, citations } from './review-fixtures.mjs';

const board = `[MISC #world_clock]
Time: Day 1, 01:00:00
[MISC #simulation_processes]
{"version":1,"through":"Day 1, 01:00:00","processes":[]}
[ENTITIES #hero]
HP 20/20; gold 200. Location: hall.
[SCENE #hall]
Hero waits by the door. Desk contains a note.`;
const label = p => `${p.phase === 'review' ? p.review_kind : p.phase}:${p.audit?.stage ?? p.stage ?? ''}`;
const update = (p, content) => ({ calls: [{ name: 'UpdateBlackboard', arguments: { base_revision: p.head_revision, content } }] });
function lightReport(p, verdict = 'pass', problem) {
    const assessment = report(p, verdict, problem);
    for (const issue of assessment.issues) issue.affected = ['candidate'];
    return assessment;
}
const detection = (p, finding = false) => ({ text: JSON.stringify(lightReport(p, finding ? 'repair' : 'pass')) });
function correction(p, candidate = 'Corrected.', status = 'resolved') {
    return { text: JSON.stringify({ revision: p.head_revision, candidate_id: p.candidate_id, candidate, issue_resolutions: p.issues_to_fix.map(issue => ({
        id: issue.id, status, reason: 'Compared the recorded finding with the corrected candidate.',
        evidence: [{ source: 'candidate', quote: candidate }],
    })) }) };
}

for (const mode of ['diff', 'full']) for (const finding of [false, true]) test(`${mode}: light mode has one detection and one correction (${finding ? 'recorded finding' : 'empty finding queue'})`, async () => {
    let checkpoint;
    const sequence = [], context = [{ role: 'user', content: 'Wait by the door.' }];
    const result = await runPrivateTurn({ baseline: board, mode, reviewMode: 'light', context,
        saveCheckpoint: async value => { checkpoint = value; },
        invoke: () => assert.fail('No external side effect belongs in review/correction'),
        request: async (messages, allowed) => {
            const p = payload(messages); sequence.push(label(p));
            if (p.phase === 'simulate') return { text: 'Original.' };
            assert.equal(messages.length, 2, 'Auditor/corrector have independent roles');
            assert.deepEqual(p.reference_context, context);
            assert.equal(p.format, mode);
            assert.deepEqual(p.versions[0], { revision: 0, text: board });
            if (p.phase === 'review') {
                assert.equal(p.audit.stage, 'light');
                assert.equal(p.review_kind, 'detect');
                assert.deepEqual(allowed, []);
                return detection(p, finding);
            }
            assert.equal(p.phase, 'repair');
            assert.equal(p.stage, 'light');
            assert.deepEqual(allowed, ['UpdateBlackboard']);
            assert.equal(p.issues_to_fix.length, Number(finding));
            return correction(p, finding ? 'Corrected.' : 'Original.');
        } });
    assert.deepEqual(sequence, ['simulate:', 'detect:light', 'repair:light']);
    assert.equal(result.candidate, finding ? 'Corrected.' : 'Original.');
    assert.equal(result.stats.reviewMode, 'light');
    assert.equal(result.stats.reviews, 1);
    assert.equal(result.stats.repairs, 1);
    assert.equal(result.stats.requests, 3);
    assert.equal(result.review.verdict, 'pass');
    assert.equal(checkpoint.version, 4);
    assert.equal(checkpoint.reviewMode, 'light');
    assert.equal(checkpoint.phase, 'done');
    assert.ok(result.issueLedger.every(issue => issue.status === 'resolved'));
    assert.deepEqual(Object.keys(result.stageFindings), ['light']);
});

test('correction tool continuations do not spawn another semantic audit and retain the original dice result', async () => {
    let simulation = 0, repairs = 0, rolls = 0;
    const sequence = [];
    const result = await runPrivateTurn({ baseline: board, reviewMode: 'light', context: [],
        invoke: async (name, args) => {
            assert.equal(name, 'RollTheDice'); assert.equal(args.formula, '1d20'); rolls++;
            return 'The result is: 4. Individual rolls: 4';
        }, request: async (messages, allowed) => {
            const p = payload(messages); sequence.push(label(p));
            if (p.phase === 'simulate') return !simulation++
                ? { calls: [{ name: 'RollTheDice', arguments: { formula: '1d20' } }] }
                : { text: 'Original.' };
            assert.equal(p.rolls[0].result, 'The result is: 4. Individual rolls: 4');
            if (p.phase === 'review') return detection(p, true);
            assert.deepEqual(allowed, ['UpdateBlackboard']);
            if (!repairs++) return { calls: [
                { name: 'RollTheDice', arguments: { formula: '1d20' } },
                { name: 'SetSceneBackground', arguments: { prompt: 'Forbidden correction artwork.' } },
            ] };
            if (repairs === 2) {
                assert.match(JSON.stringify(p.receipts), /Tool forbidden in repair/);
                return update(p, '[ENTITIES #hero]\nHP 20/20; gold 200; note. Location: hall.\n[SCENE #hall]\nHero waits by the door. Desk is empty.');
            }
            assert.equal(p.head_revision, 1);
            return correction(p);
        } });
    assert.equal(rolls, 1);
    assert.equal(result.stats.reviews, 1);
    assert.equal(result.stats.repairs, 1);
    assert.deepEqual(sequence, ['simulate:', 'simulate:', 'detect:light', 'repair:light', 'repair:light', 'repair:light']);
    assert.equal(result.draft.rolls.length, 1);
    assert.equal(processRegister(result.draft.head).through, 'Day 1, 01:00:00');
    assert.match(result.draft.head, /Desk is empty/);
    assert.equal(result.draft.background, null);
});

for (const boundary of ['review', 'repair']) test(`429 during light ${boundary} resumes the frozen request without replaying gameplay or rolling again`, async () => {
    let checkpoint, frozen, rolls = 0, simulations = 0, outage = true;
    const options = { baseline: board, reviewMode: 'light', context: [{ role: 'user', content: 'Original action.' }],
        saveCheckpoint: async value => { checkpoint = JSON.parse(JSON.stringify(value)); },
        invoke: async () => { rolls++; return 'The result is: 7. Individual rolls: 7'; },
        request: async messages => {
            const p = payload(messages);
            if (p.phase === 'simulate') return !simulations++
                ? { calls: [{ name: 'RollTheDice', arguments: { formula: '1d20' } }] }
                : { text: 'Original.' };
            if (p.phase === boundary && outage) { outage = false; frozen = structuredClone(messages); throw new Error('429'); }
            return p.phase === 'review' ? detection(p, true) : correction(p);
        } };
    await assert.rejects(runPrivateTurn(options), /429/);
    const requests = checkpoint.stats.requests;
    assert.equal(checkpoint.reviewMode, 'light');
    assert.equal(checkpoint.draft.rolls.length, 1);
    let first = true;
    const result = await runPrivateTurn({ ...options, checkpoint, context: [{ role: 'user', content: 'Must not replace frozen context.' }],
        request: async messages => {
            if (first) { first = false; assert.deepEqual(messages, frozen); }
            assert.notEqual(payload(messages).phase, 'simulate');
            return options.request(messages);
        } });
    assert.equal(rolls, 1);
    assert.equal(result.stats.requests, 4);
    assert.ok(result.stats.requests >= requests);
    assert.equal(result.stats.reviews, 1);
    assert.equal(result.stats.repairs, 1);
    assert.equal(result.issueLedger[0].status, 'resolved');
});

for (const initial of ['light', 'heavy']) test(`saved ${initial} turn rejects switching review mode on resume before any provider call`, async () => {
    let checkpoint;
    await assert.rejects(runPrivateTurn({ baseline: board, reviewMode: initial, context: [],
        saveCheckpoint: async value => { checkpoint = value; }, request: async () => { throw new Error('429'); } }), /429/);
    await assert.rejects(runPrivateTurn({ baseline: board, checkpoint, reviewMode: initial === 'light' ? 'heavy' : 'light', context: [],
        request: () => assert.fail('No network call with changed mode') }), /mode.*changed|changed.*mode/i);
});

test('version-4 checkpoint without reviewMode resumes the existing heavy workflow', async () => {
    let checkpoint;
    await assert.rejects(runPrivateTurn({ baseline: board, context: [], saveCheckpoint: async value => { checkpoint = value; },
        request: async () => { throw new Error('429'); } }), /429/);
    delete checkpoint.reviewMode;
    delete checkpoint.stats.reviewMode;
    const stages = [];
    const result = await runPrivateTurn({ baseline: board, checkpoint, reviewMode: 'heavy', context: [], request: async messages => {
        const p = payload(messages);
        if (p.phase === 'simulate') return { text: 'Original.' };
        stages.push(p.audit.stage); return detection(p);
    } });
    assert.deepEqual(stages, REVIEW_STAGES.map(stage => stage.id));
    assert.equal(result.stats.reviewMode, 'heavy');
    assert.equal(result.stats.reviews, 4);
    assert.equal(result.stats.repairs, 0);
});

test('malformed correction is saved and resumed as correction only, with open findings retained', async () => {
    let checkpoint;
    const options = { baseline: board, reviewMode: 'light', context: [], saveCheckpoint: async value => { checkpoint = value; },
        request: async messages => {
            const p = payload(messages);
            return p.phase === 'simulate' ? { text: 'Original.' } : p.phase === 'review' ? detection(p, true) : { text: 'Not the required correction JSON.' };
        } };
    await assert.rejects(runPrivateTurn(options), /invalid|correction.*report|repair.*report/i);
    assert.equal(checkpoint.phase, 'repair');
    assert.equal(checkpoint.haltKind, 'format');
    assert.equal(checkpoint.issueLedger[0].status, 'open');
    const result = await runPrivateTurn({ ...options, checkpoint, request: async messages => {
        const p = payload(messages); assert.equal(p.phase, 'repair'); assert.equal(p.issues_to_fix.length, 1);
        return correction(p);
    } });
    assert.equal(result.stats.reviews, 1);
    assert.equal(result.stats.repairs, 1);
    assert.equal(result.issueLedger[0].status, 'resolved');
});

test('light mode cannot publish a mechanically invalid corrected board even when the model closes its findings', async () => {
    let checkpoint, repairs = 0;
    await assert.rejects(runPrivateTurn({ baseline: board, reviewMode: 'light', context: [],
        saveCheckpoint: async value => { checkpoint = value; }, request: async messages => {
            const p = payload(messages);
            if (p.phase === 'simulate') return { text: 'Original.' };
            if (p.phase === 'review') return detection(p, true);
            if (!repairs++) return update(p, '[MISC #world_clock]\nTime: Day 1, 01:00:01');
            return correction(p);
        } }), /mechanical|world_clock|unresolved|publication/i);
    assert.notEqual(checkpoint.phase, 'done');
    assert.equal(checkpoint.stats.reviews, 1, 'Mechanical gate must not add a third model assessment');
    assert.ok(checkpoint.issueLedger.some(issue => !['resolved', 'rejected'].includes(issue.status)));
});

test('a blocked correction preserves the finding and draft without requesting a third semantic pass', async () => {
    let checkpoint;
    const sequence = [];
    await assert.rejects(runPrivateTurn({ baseline: board, reviewMode: 'light', context: [],
        saveCheckpoint: async value => { checkpoint = value; }, request: async messages => {
            const p = payload(messages); sequence.push(label(p));
            return p.phase === 'simulate' ? { text: 'Original.' } : p.phase === 'review' ? detection(p, true) : correction(p, 'Still blocked.', 'blocked');
        } }), /blocked|unresolved|without publication/i);
    assert.deepEqual(sequence, ['simulate:', 'detect:light', 'repair:light']);
    assert.equal(checkpoint.issueLedger[0].status, 'blocked');
    assert.notEqual(checkpoint.phase, 'done');
});

for (const defect of ['missing-resolution', 'stale-revision', 'stale-candidate']) test(`light correction rejects ${defect} without dropping its recorded finding`, async () => {
    let checkpoint;
    await assert.rejects(runPrivateTurn({ baseline: board, reviewMode:'light', context:[],
        saveCheckpoint:async value=>{checkpoint=value;}, request:async messages=>{
            const p=payload(messages);
            if(p.phase==='simulate')return {text:'Original.'};
            if(p.phase==='review')return detection(p,true);
            const reply=JSON.parse(correction(p).text);
            if(defect==='missing-resolution')reply.issue_resolutions=[];
            if(defect==='stale-revision')reply.revision=p.head_revision+1;
            if(defect==='stale-candidate')reply.candidate_id=p.candidate_id+1;
            return {text:JSON.stringify(reply)};
        } }), /invalid|correction.*report|repair.*report/i);
    assert.equal(checkpoint.phase,'repair');
    assert.equal(checkpoint.haltKind,'format');
    assert.equal(checkpoint.issueLedger[0].status,'open');
    assert.equal(checkpoint.candidate,'Original.','An invalid envelope must not overwrite the candidate being corrected');
    assert.equal(checkpoint.stats.reviews,1);
});

test('light correction cannot silently simulate an extra interval by advancing clock and register together', async () => {
    let checkpoint, correctionRequests=0;
    await assert.rejects(runPrivateTurn({baseline:board,reviewMode:'light',context:[],
        saveCheckpoint:async value=>{checkpoint=value;},request:async messages=>{
            const p=payload(messages);
            if(p.phase==='simulate')return {text:'Original.'};
            if(p.phase==='review')return detection(p,true);
            if(!correctionRequests++)return update(p,'[MISC #world_clock]\nTime: Day 1, 01:00:01\n[MISC #simulation_processes]\n{"version":1,"through":"Day 1, 01:00:01","processes":[]}');
            return correction(p);
        }}), /clock|interval|time|publication|mechanical/i);
    assert.notEqual(checkpoint.phase,'done');
    assert.equal(checkpoint.stats.reviews,1);
});

test('a detected clock error can use an explicitly evidenced correction endpoint without another game interval', async () => {
    let simulations=0, repairs=0;
    const timed = seconds => `[MISC #world_clock]\nTime: Day 1, 01:00:0${seconds}\n[MISC #simulation_processes]\n{"version":1,"through":"Day 1, 01:00:0${seconds}","processes":[]}`;
    const result=await runPrivateTurn({baseline:board,reviewMode:'light',context:[{role:'user',content:'Wait for two seconds.'}],
        request:async messages=>{
            const p=payload(messages);
            if(p.phase==='simulate')return !simulations++ ? update(p,timed(3)) : {text:'You wait two seconds.'};
            if(p.phase==='review'){
                const assessment=lightReport(p,'repair','The clock advanced three seconds although the authorized wait was two seconds.');
                assessment.issues[0].affected=['MISC #world_clock','MISC #simulation_processes'];
                assessment.checks.find(check=>check.target==='time').evidence=citations(p,[{source:'current',block_id:'misc #world_clock'},{source:'current',block_id:'misc #simulation_processes'}]);
                assessment.time_correction={through:'Day 1, 01:00:02',reason:'Align the endpoint with the already authorized two-second wait.',evidence:[{source:'context',quote:'Wait for two seconds.'}]};
                return {text:JSON.stringify(assessment)};
            }
            if(!repairs++)return update(p,timed(2));
            const reply=JSON.parse(correction(p,'You wait two seconds.').text);
            reply.issue_resolutions[0].evidence=citations(p,[{source:'current',block_id:'misc #world_clock'},{source:'current',block_id:'misc #simulation_processes'}]);
            return {text:JSON.stringify(reply)};
        }});
    assert.equal(processRegister(result.draft.head).through,'Day 1, 01:00:02');
    assert.equal(result.stats.reviews,1);
    assert.equal(result.stats.repairs,1);
    assert.equal(result.issueLedger[0].status,'resolved');
});

test('light detection must cover each of the four aspects before correction can start', async () => {
    let checkpoint;
    await assert.rejects(runPrivateTurn({baseline:board,reviewMode:'light',context:[],
        saveCheckpoint:async value=>{checkpoint=value;},request:async messages=>{
            const p=payload(messages);
            if(p.phase==='simulate')return {text:'Original.'};
            assert.equal(p.phase,'review','An incomplete audit must not dispatch correction');
            const assessment=lightReport(p,'repair');
            assessment.checks=assessment.checks.slice(0,1);
            return {text:JSON.stringify(assessment)};
        }}), /invalid report/i);
    assert.equal(checkpoint.phase,'review');
    assert.equal(checkpoint.stats.repairs,0);
    assert.equal(checkpoint.issueLedger[0].status,'unconfirmed','Malformed formatting cannot erase the recorded allegation');
});

for (const option of [
    {candidate:'Original.',action:undefined,keep:true},
    {candidate:'Corrected.',action:undefined,keep:false},
    {candidate:'Corrected.',action:'keep',keep:true},
    {candidate:'Corrected.',action:'discard',keep:false},
]) test(`queued background ${option.action ?? 'default'} with ${option.candidate} remains deferred and follows the correction disposition`, async () => {
    let simulation=0;
    const request={prompt:'The known hall and its door.'};
    const result=await runPrivateTurn({baseline:board,reviewMode:'light',context:[],
        invoke:()=>assert.fail('An image cannot execute before reviewed commit'),request:async messages=>{
            const p=payload(messages);
            if(p.phase==='simulate')return !simulation++ ? {calls:[{name:'SetSceneBackground',arguments:request}]} : {text:'Original.'};
            if(p.phase==='review')return detection(p);
            const reply=JSON.parse(correction(p,option.candidate).text);
            if(option.action)reply.background_action=option.action;
            return {text:JSON.stringify(reply)};
        }});
    assert.deepEqual(result.draft.background,option.keep?request:null);
    assert.deepEqual(result.draft.backgroundRequests,[{revision:0,arguments:request}]);
    assert.equal(result.stats.reviews,1);
});

function inventoryFinding(p, affected = ['ENTITIES #hero']) {
    const assessment=lightReport(p,'repair','The hero inventory still shows 200 gold after the authorized payment of ten gold.');
    assessment.issues[0].target='continuity';
    assessment.issues[0].affected=affected;
    assessment.issues[0].repair='Write the resulting 190 gold in the hero inventory.';
    assessment.checks.find(check=>check.target==='continuity').evidence=citations(p,[{source:'current',block_id:'entities #hero'}]);
    return {text:JSON.stringify(assessment)};
}

for (const defect of ['unrelated-evidence','unchanged-owner']) test(`light owner finding cannot be closed with ${defect} and a cosmetic answer edit`, async () => {
    let checkpoint, repairRequests=0;
    await assert.rejects(runPrivateTurn({baseline:board,reviewMode:'light',context:[{role:'user',content:'Pay ten gold.'}],
        saveCheckpoint:async value=>{checkpoint=value;},request:async messages=>{
            const p=payload(messages);
            if(p.phase==='simulate')return {text:'You pay ten gold.'};
            if(p.phase==='review')return inventoryFinding(p);
            if(defect==='unrelated-evidence'&&!repairRequests++)return update(p,'[ENTITIES #hero]\nHP 20/20; gold 190. Location: hall.');
            const reply=JSON.parse(correction(p,'You quietly pay ten gold.').text);
            reply.issue_resolutions[0].evidence=citations(p,[{source:'current',block_id:defect==='unrelated-evidence'?'misc #world_clock':'entities #hero'}]);
            return {text:JSON.stringify(reply)};
        }}), /invalid|correction.*report|repair.*report/i);
    assert.equal(checkpoint.phase,'repair');
    assert.equal(checkpoint.haltKind,'format');
    assert.equal(checkpoint.issueLedger[0].status,'open');
    assert.equal(checkpoint.candidate,'You pay ten gold.');
    assert.deepEqual(checkpoint.issueLedger[0].affected.map(id=>id.toLowerCase()),['entities #hero']);
});

test('light inventory finding closes after an actual owner update with the owner evidence, even when the answer is unchanged', async () => {
    let repairRequests=0;
    const result=await runPrivateTurn({baseline:board,reviewMode:'light',context:[{role:'user',content:'Pay ten gold.'}],request:async messages=>{
        const p=payload(messages);
        if(p.phase==='simulate')return {text:'You pay ten gold.'};
        if(p.phase==='review')return inventoryFinding(p);
        assert.deepEqual(p.issues_to_fix[0].affected.map(id=>id.toLowerCase()),['entities #hero']);
        if(!repairRequests++)return update(p,'[ENTITIES #hero]\nHP 20/20; gold 190. Location: hall.');
        const reply=JSON.parse(correction(p,'You pay ten gold.').text);
        reply.issue_resolutions[0].evidence=citations(p,[{source:'current',block_id:'entities #hero'}]);
        return {text:JSON.stringify(reply)};
    }});
    assert.equal(result.candidate,'You pay ten gold.');
    assert.equal(result.issueLedger[0].status,'resolved');
    assert.match(result.draft.head,/gold 190/);
    assert.equal(result.stats.reviews,1);
    assert.equal(result.stats.repairs,1);
});

for (const affected of [[],['ENTITIES #does_not_exist'],['not a board id'],undefined]) test(`light detection rejects invalid affected references (${JSON.stringify(affected)})`, async () => {
    let checkpoint;
    await assert.rejects(runPrivateTurn({baseline:board,reviewMode:'light',context:[],saveCheckpoint:async value=>{checkpoint=value;},request:async messages=>{
        const p=payload(messages);
        if(p.phase==='simulate')return {text:'Original.'};
        assert.equal(p.phase,'review','Invalid owner binding cannot dispatch correction');
        const assessment=lightReport(p,'repair');
        if(affected===undefined)delete assessment.issues[0].affected;
        else assessment.issues[0].affected=affected;
        return {text:JSON.stringify(assessment)};
    }}), /invalid report/i);
    assert.equal(checkpoint.phase,'review');
    assert.equal(checkpoint.haltKind,'format');
    assert.equal(checkpoint.stats.repairs,0);
});
