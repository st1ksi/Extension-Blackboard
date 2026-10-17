import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DraftTurn, runPrivateTurn } from '../transaction.js';
import { makeAudit, quoteMatches, validateAudit } from '../review.js';
import { captureIssues, pendingIssues } from '../issue-ledger.js';
import { payload, pass, report, citations } from './review-fixtures.mjs';
import { freezeCampaignLayers } from '../campaign-layers.js';

const original = `[MISC #world_clock]
Time: Day 1, 01:18:19
[MISC #simulation_processes]
${JSON.stringify({version:1,through:'Day 1, 01:18:19',processes:[{id:'tea',owner:'ENTITIES #servant_bran',status:'active',accounted_through:'Day 1, 01:18:19',next_at:'Day 1, 01:25:00',note:'Preparing tea.'}]},null,2)}
[ENTITIES #servant_bran]
Location: kitchen. Task: boiling tea.
[SCENE #hall]
Bran is in the kitchen.
[NARRATIVE #timeline]
Bran will discover the body at 01:25:00.`;
const advanced = original.replaceAll('Day 1, 01:18:19','Day 1, 02:30:00').replace('"status": "active"','"status": "completed"').replace('"next_at": "Day 1, 01:25:00"','"next_at": null').replace('Preparing tea.','Found body and raised alarm.');
const fixed = advanced.replace('Location: kitchen. Task: boiling tea.','Location: hall. Task: giving testimony.').replace('Bran is in the kitchen.','Bran is giving testimony in the hall.').replace('Bran will discover the body at 01:25:00.','Bran discovered the body at 01:25:00.');
const issue = { target:'actor:entities #servant_bran',problem:'Bran is still boiling tea although his process reports the alarm.',repair:'Reconcile Bran and scene with the resolved discovery and ensuing activity.' };
const update = (p, text) => ({calls:[{name:'UpdateBlackboard',arguments:{base_revision:p.head_revision,content:text}}]});
const encode = r => ({text:JSON.stringify(r)});
const packet = d => ({...d.packet(),current_board:d.head,audit:makeAudit(d,'time',1),candidate_id:1,candidate:'The alarm is raised.'});

test('JSON quotations ignore layout but preserve values, punctuation and token boundaries',()=>{
    const data=JSON.stringify({id:'patrol',owner:'ENTITIES #watch',note:'north  gate',n:12},null,2);
    assert.ok(quoteMatches(data,'{"id": "patrol", "owner": "ENTITIES #watch"'));
    assert.ok(quoteMatches(data,'"owner":"ENTITIES #watch"'));
    assert.ok(quoteMatches(data,'"note":"north  gate"'));
    assert.equal(quoteMatches(data,'"note":"north gate"'),false);
    assert.equal(quoteMatches(data,'"owner":"ENTITIES #other"'),false);
    assert.equal(quoteMatches(data,'"n":2'),false);
    assert.equal(quoteMatches(data,'"id":"patrol" "owner":"ENTITIES #watch"'),false);
    assert.equal(quoteMatches(data,'{"id":"patrol",...}'),false);
    assert.ok(quoteMatches('Bran\n is in the kitchen.','Bran is in the kitchen.'));
});

test('owner bundle exposes stale owner alongside completed process; process-only proof is rejected',()=>{
    const d=new DraftTurn(original);d.update({base_revision:0,content:advanced});
    const p=packet(d), bundle=p.audit.owner_bundles.find(b=>b.block_id==='entities #servant_bran');
    assert.match(bundle.current,/boiling tea/);assert.match(bundle.processes.current[0].note,/alarm/);
    assert.ok(bundle.related_records.some(r=>r.block_id==='scene #hall'));
    const r=report(p), actor=r.checks.find(c=>c.target===issue.target);
    actor.evidence=citations(p,[{source:'current',block_id:'misc #simulation_processes'}]);
    assert.throws(()=>validateAudit(r,p.audit,d,p.candidate,[]),/Missing required evidence/);
    assert.ok(makeAudit(d,'continuity',1).targets.some(t=>t.id==='owner:entities #servant_bran'));
});

test('identity mismatch cannot introduce issues; parseable format failure can preserve an allegation',()=>{
    const d=new DraftTurn(original),p=packet(d),ledger=[],r=report(p,'repair');r.issues=[issue];
    captureIssues(ledger,{...r,candidate_id:99},p.audit,0);assert.equal(ledger.length,0);
    captureIssues(ledger,{...r,checks:{}},p.audit,1);
    assert.equal(ledger.length,1);assert.equal(ledger[0].status,'unconfirmed');
    assert.equal(ledger[0].id,'issue-1');
});

test('invalid citation preserves issue through formatting retry, 429, repair and verified closure',async()=>{
    let checkpoint,fail=true,invalid=true,simulated=false,repaired=false;
    const options={baseline:original,context:[],saveCheckpoint:async s=>{checkpoint=structuredClone(s);},request:async messages=>{
        const p=payload(messages);
        if(p.phase==='simulate') {if(!simulated){simulated=true;return update(p,advanced);}return {text:'The alarm is raised.'};}
        if(p.phase==='repair') {
            assert.equal(p.issues_to_fix.length,1);assert.equal(p.issues_to_fix[0].id,'issue-1');
            if(!repaired){repaired=true;return update(p,fixed);}return {text:'Bran gives testimony after raising the alarm.'};
        }
        if(p.audit.stage==='time'&&invalid){invalid=false;const r=report(p,'repair');r.issues=[issue];r.checks[0].evidence=[{source:'candidate',quote:'Nonexistent text'}];return encode(r);}
        if(p.format_feedback){
            assert.equal(p.issue_ledger[0].problem,issue.problem);
            assert.equal(p.format_feedback.previous_report.issues[0].problem,issue.problem);
            if(fail){fail=false;throw new Error('429');}
            const r=report(p,'repair');r.issues=[];return encode(r); // explicit open resolution confirms it
        }
        return pass(p);
    }};
    await assert.rejects(runPrivateTurn(options),/429/);
    assert.equal(checkpoint.issueLedger[0].status,'unconfirmed');
    const frozen=structuredClone(checkpoint.pending.messages);let first=true;
    const result=await runPrivateTurn({...options,checkpoint,request:async messages=>{if(first){first=false;assert.deepEqual(messages,frozen);}return options.request(messages);}});
    assert.match(result.draft.head,/giving testimony/);
    assert.equal(result.issueLedger.length,1);assert.equal(result.issueLedger[0].status,'resolved');
    assert.ok(result.issueLedger[0].history.some(h=>h.event==='open'));
    assert.equal(result.issueLedger[0].verified_revision,result.draft.revision);
    assert.equal(result.stats.repairs,1);
});

test('format retry cannot silently drop an observation or publish a generic pass',async()=>{
    let checkpoint,first=true;
    await assert.rejects(runPrivateTurn({baseline:original,context:[],saveCheckpoint:async s=>{checkpoint=structuredClone(s);},request:async messages=>{
        const p=payload(messages);if(p.phase==='simulate')return {text:'Candidate.'};
        if(first){first=false;const r=report(p,'repair');r.issues=[issue];r.checks[0].evidence=[];return encode(r);}
        const r=report(p);r.issue_resolutions=[];return encode(r);
    }}),/invalid report/);
    assert.equal(checkpoint.issueLedger[0].status,'unconfirmed');
    assert.match(checkpoint.formatFeedback.error,/Pending issues omitted/);
    assert.equal(checkpoint.stats.repairs,0);assert.equal(checkpoint.draft.versions.length,1);
});

test('false observation can be explicitly rejected without editing gameplay',async()=>{
    let first=true;
    const result=await runPrivateTurn({baseline:original,context:[],request:async messages=>{
        const p=payload(messages);if(p.phase==='simulate')return {text:'Still before tea delivery.'};
        if(first){first=false;const r=report(p,'repair');r.issues=[issue];r.checks[0].evidence=[];return encode(r);}
        const r=report(p);if(r.issue_resolutions[0])r.issue_resolutions[0].reason='Original clock is 01:18:19, before the tea deadline; Bran should still be in the kitchen.';
        return encode(r);
    }});
    assert.equal(result.issueLedger[0].status,'rejected');assert.equal(result.draft.head,original);assert.equal(result.stats.repairs,0);
});

test('closure must cite affected owner, cannot use only a completed process or relabel the issue',()=>{
    const d=new DraftTurn(original);d.update({base_revision:0,content:advanced});
    const p=packet(d),ledger=[],r=report(p,'repair');r.issues=[issue];captureIssues(ledger,r,p.audit,0);
    p.issue_ledger=ledger;
    const invalid=report(p);invalid.issue_resolutions[0].evidence=citations(p,[{source:'current',block_id:'misc #simulation_processes'}]);
    assert.throws(()=>validateAudit(invalid,p.audit,d,p.candidate,[],ledger),/Missing required evidence/);
    const relabeled=report(p,'repair');relabeled.issues=[{...issue,id:'issue-1',problem:'A different problem.'}];
    assert.throws(()=>validateAudit(relabeled,p.audit,d,p.candidate,[],ledger),/relabeled/);
    const pretendFixed=report(p);pretendFixed.issue_resolutions[0].status='resolved';
    assert.throws(()=>validateAudit(pretendFixed,p.audit,d,p.candidate,[],ledger),/cannot be fixed/);
    const unknownId=report(p,'repair');unknownId.issues=[{...issue,id:'issue-999'}];
    assert.throws(()=>validateAudit(unknownId,p.audit,d,p.candidate,[],ledger),/Unknown or relabeled/);
});

test('later repair requires fresh verification of previously rejected issues',async()=>{
    let bad=true,later=true;
    const result=await runPrivateTurn({baseline:original,context:[],request:async messages=>{
        const p=payload(messages);if(p.phase!=='review')return {text:'Candidate '+(later?'one':'two')};
        if(p.audit.stage==='time'&&bad){bad=false;const r=report(p,'repair');r.issues=[issue];r.checks[0].evidence=[];return encode(r);}
        if(p.audit.stage==='narration'&&later){later=false;return encode(report(p,'repair','Candidate needs a correction.'));}
        return pass(p);
    }});
    const bran=result.issueLedger[0];
    assert.ok(bran.history.some(h=>h.event==='rejected'));
    assert.ok(bran.history.some(h=>h.event==='recheck_after_revision'));
    assert.equal(bran.verified_candidate,2);
    assert.equal(pendingIssues(result.issueLedger).length,0);
});

test('review uses its own system role and retains campaign evidence and attached media',async()=>{
    const media={type:'image_url',image_url:{url:'data:image/png;base64,fixture'}};
    const context=[{role:'system',content:'Play the DM. Always narrate.'},{role:'user',content:[{type:'text',text:'Look at this room.'},media]}];
    const result=await runPrivateTurn({baseline:original,context,request:async messages=>{
        const p=payload(messages);if(p.phase==='simulate')return {text:'Candidate.'};
        assert.equal(messages.length,2);assert.equal(messages[0].role,'system');
        assert.match(messages[0].content,/independent transition auditor/);
        assert.doesNotMatch(messages[0].content,/Always narrate/);
        assert.deepEqual(p.reference_context,context);
        assert.deepEqual(messages[1].content.at(-1),media);
        return pass(p);
    }});
    assert.equal(result.stats.reviews,4);
});

test('v2 schema migration with current instruction sources salvages rejected allegations for reaudit',async()=>{
    const d=new DraftTurn(original);d.update({base_revision:0,content:advanced});
    d.campaignLayers=freezeCampaignLayers({});
    const p=packet(d),oldReport=report(p,'repair');oldReport.issues=[issue];oldReport.checks[0].evidence=[];
    const checkpoint={version:2,draft:d,context:[],phase:'review',step:0,candidate:p.candidate,candidateId:1,candidateVersions:[{id:1,revision:1,text:p.candidate}],
        auditIndex:2,auditLog:[{stage:'time',revision:1,candidate_id:1,status:'invalid_report',raw:encode(oldReport),targets:p.audit.targets}],
        pending:{messages:[{role:'user',content:'obsolete packet'}],allowed:[]},answer:null,review:null,maxRepairs:4,
        stats:{requests:4,reviews:2,repairs:0,inputChars:0,outputChars:0,started:Date.now()}};
    let first=true;
    const result=await runPrivateTurn({baseline:original,checkpoint,request:async messages=>{
        const q=payload(messages);
        if(first){first=false;assert.equal(q.audit.stage,'time');assert.equal(q.issue_ledger[0].problem,issue.problem);}
        // False-positive fixture rejection exercises explicit migration handling.
        return pass(q);
    }});
    assert.equal(result.issueLedger.length,1);assert.equal(result.issueLedger[0].status,'rejected');
    assert.equal(result.review.stages.length,4);
});
