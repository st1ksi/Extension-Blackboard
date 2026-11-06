import test from 'node:test';
import assert from 'node:assert/strict';
import { runPrivateTurn, DraftTurn } from '../transaction.js';
import { createPrivateRequest } from '../private-api.js';
import { rollBlackboardDice, DICE_TOOL_NAME } from '../dice-engine.js';
import { diceResult } from '../dice.js';
import { publicJournal, renderJournal } from '../tool-journal.js';
import { redactToolLog } from '../state.js';

const board = '[MISC #world_clock]\nTime: Day 1, 01:00:00\n[MISC #simulation_processes]\n{"version":1,"through":"Day 1, 01:00:00","processes":[]}';
const packet = messages => JSON.parse(messages.at(-1).content.split('\n').slice(1).join('\n'));
const call = args => ({ name: DICE_TOOL_NAME, arguments: args });

test('private transport supplies its own dice schema without any external dice tool; narration gets none', async () => {
    let wire;
    const request = createPrivateRequest({ settings: {}, getModel: () => 'fixture',
        createParameters: async () => ({ generate_data: { tools: [{ type:'function',function:{name:'Unrelated',parameters:{}} }] } }),
        context: { eventSource: { emit: async () => {} }, eventTypes: {}, getRequestHeaders: () => ({}), extractMessageFromData: () => 'OK' },
        fetchRequest: async (_, init) => { wire = JSON.parse(init.body); return {ok:true,json:async()=>({choices:[{message:{content:'OK'}}]})}; },
    });
    await request([], [DICE_TOOL_NAME]);
    assert.deepEqual(wire.tools.map(t => t.function.name), [DICE_TOOL_NAME]);
    assert.equal(wire.tools[0].function.parameters.properties.faces.items.type, 'string');
    assert.ok(!JSON.stringify(wire.tools).includes('anyOf'));
    await request([], []);
    assert.equal(wire.tools, undefined);
});

test('invalid built-in formula consumes no RNG and defers dependent board updates until correction', async () => {
    let step = 0, draws = 0;
    const result = await runPrivateTurn({ baseline: board, context: [], reviewEnabled: false,
        invoke: async (name, args) => { assert.equal(name,DICE_TOOL_NAME); return rollBlackboardDice(args,{randomUint32:()=>{draws++;return 16;}}); },
        request: async (messages, allowed) => {
            assert.ok(allowed.includes(DICE_TOOL_NAME));
            const p=packet(messages);
            if (!step++) return {calls:[call({formula:'1d20+bad'}),{name:'UpdateBlackboard',arguments:{base_revision:0,content:'[MISC #bad]\nMust not happen'}}]};
            if(step===2){
                assert.equal(draws,0);assert.equal(p.rolls.length,0);
                assert.equal(p.receipts[0].result.rolled,false);
                assert.match(p.receipts[1].result.message,/deferred/);
                return {calls:[call({formula:'1d20+5'})]};
            }
            assert.equal(p.rolls[0].result.total,22);
            return {text:'Resolved from the actual roll.'};
        },
    });
    assert.equal(draws,1);assert.equal(result.draft.rolls.length,1);assert.equal(result.draft.head,board);
});

test('completed built-in roll survives request failure and resume without another random draw', async () => {
    let checkpoint, step=0, draws=0;
    const options={baseline:board,context:[],reviewEnabled:false,saveCheckpoint:async s=>{checkpoint=structuredClone(s);},
        invoke:async(_,args)=>rollBlackboardDice(args,{randomUint32:()=>{draws++;return 3;}}),
        request:async()=>{if(!step++)return {calls:[call({formula:'1d8'})]};throw new Error('provider unavailable');}};
    await assert.rejects(runPrivateTurn(options),/provider unavailable/);
    assert.equal(checkpoint.draft.rolls[0].result.total,4);
    const result=await runPrivateTurn({...options,checkpoint,invoke:()=>assert.fail('No reroll'),request:async messages=>{
        assert.equal(packet(messages).rolls[0].result.total,4);return {text:'The original result is four.'};}});
    assert.equal(draws,1);assert.equal(result.draft.rolls.length,1);
});

test('unfinished exploding roll preserves partial faces and blocks model/RNG replay on resume', async () => {
    let checkpoint, draws=0;
    const options={baseline:board,context:[],reviewEnabled:false,saveCheckpoint:async s=>{checkpoint=structuredClone(s);},
        invoke:async(_,args)=>rollBlackboardDice(args,{randomUint32:()=>{draws++;return 5;}}),
        request:async()=>({calls:[call({formula:'1d6!'})]})};
    await assert.rejects(runPrivateTurn(options),/safety limit/);
    assert.equal(checkpoint.inFlightTool.name,DICE_TOOL_NAME);
    assert.equal(checkpoint.inFlightTool.result.status,'incomplete');
    assert.equal(checkpoint.inFlightTool.result.rolls.length,100);
    assert.equal(checkpoint.inFlightTool.error.uncertain,true);
    await assert.rejects(runPrivateTurn({...options,checkpoint,invoke:()=>assert.fail('No reroll'),request:()=>assert.fail('No model request')}),/uncertain/);
    assert.equal(draws,100);
});

test('symbolic custom receipts are binding successes, never fabricated numeric totals or public secret labels', async () => {
    const args={faces:['Hidden assassin identity','Public blank'],count:2};
    let step=0,draw=0;
    const result=await runPrivateTurn({baseline:board,context:[],reviewEnabled:false,
        invoke:async(_,args)=>rollBlackboardDice(args,{randomUint32:()=>draw++}),
        request:async messages=>{
            if(!step++)return {calls:[call(args)]};
            assert.deepEqual(packet(messages).rolls[0].result.face_values,args.faces);
            return {text:'The symbolic roll is resolved without revealing its private labels.'};
        }});
    assert.equal(result.draft.rolls[0].result.total,null);
    assert.equal(diceResult(result.draft.rolls[0].result).status,'success');
    const journal=publicJournal(result.draft.rolls,{status:'not_requested'},result.draft.receipts);
    assert.equal(journal.rolls[0].symbolic,true);
    const html=renderJournal(journal);
    assert.match(html,/symbolic result; face indices: 1, 2/);
    assert.doesNotMatch(html,/Hidden assassin|Public blank|not recognized/);
    const message={mes:'',extra:{tool_invocations:[{name:DICE_TOOL_NAME,parameters:JSON.stringify(args),result:JSON.stringify(result.draft.rolls[0].result)}]}};
    assert.equal(redactToolLog(message),true);
    assert.doesNotMatch(message.mes,/Hidden assassin|Public blank/);
    assert.match(message.extra.tool_invocations[0].result,/Hidden assassin/,'Original tool metadata remains intact for the model.');
});

test('incomplete or malformed own receipts never pass local state checks as completed rolls',()=>{
    const receipt=rollBlackboardDice({formula:'1d6'},{randomUint32:()=>0});
    for(const invalid of [{...receipt,status:'incomplete'},{...receipt,face_values:[]},{...receipt,total:null}]){
        const draft=new DraftTurn(board);draft.rolls.push({tool:DICE_TOOL_NAME,arguments:{formula:'1d6'},result:invalid});
        assert.match(draft.checks().join(),/Unconfirmed dice result/);
    }
});
