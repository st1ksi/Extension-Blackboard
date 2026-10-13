import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DraftTurn } from '../transaction.js';
import { SYSTEM_BUNDLES } from '../prompts/system-bundles.js';
import { PROMPT_ULTRA } from '../prompts/ultra.js';
import { composeGamePrompt } from '../game-profiles.js';

test('saved pre-expansion v6 editor text resolves to current default while source remains preserved',()=>{
    const b=SYSTEM_BUNDLES.compact;
    const prior=b.priorBases.find(t=>t.includes('Aim for 3,500–21,000')&&!t.includes('VERSION PACKET'));
    assert.ok(prior,'Keep the immediately previous neutral v6 base recognizable');
    const settings={simulationFidelity:'ultra',customPrompt:prior};
    const presets={ultra:{prompt:PROMPT_ULTRA},mid:{prompt:SYSTEM_BUNDLES.mid.legacy}};
    const selected=composeGamePrompt(settings,presets);
    assert.equal(selected.recognized,true);assert.equal(selected.variant,'compact');
    assert.equal(selected.base,PROMPT_ULTRA);assert.equal(settings.customPrompt,prior);
    assert.match(selected.base,/6,000–21,000/);
    assert.doesNotMatch(selected.base,/3,500|distance-2 skeletons|###.*PRIVATE TURN/);
    // This request changes detail horizon/budget only. Preserve every unrelated
    // section, including time, determinism, agency, rules and progression.
    const section=(text,id)=>text.replace(/\r\n/g,'\n').match(new RegExp(`### ${id}\\.[\\s\\S]*?(?=\\n### \\d+\\.|$)`))[0].trim();
    for(const id of [1,4,5,7,8,9,14,16,17,18,19,20,21]) assert.equal(section(selected.base,id),section(prior,id),`Section ${id} changed outside scope`);
});

for(const mode of ['diff','full']) test(`${mode}: current size follows the working revision after updates and survives hydration`,()=>{
    const original='[SCENE #hall]\nEmpty hall.';
    const draft=new DraftTurn(original,mode,'universal');
    assert.equal(draft.packet().board_size.estimated_tokens,Math.ceil(original.length/4));
    const receipt=draft.update({base_revision:0,content:'[ENTITIES #guard]\nLocation: hall; guarding the door.'});
    const p=draft.packet();
    assert.equal(p.versions[0].text,original);
    assert.equal(p.board_size.revision,1);
    assert.deepEqual(receipt.board_size,p.board_size);
    assert.equal(p.board_size.characters,draft.head.length);
    assert.equal(p.board_size.estimated_tokens,Math.ceil(draft.head.length/4));
    assert.notEqual(p.board_size.characters,original.length);
    const restored=Object.assign(new DraftTurn(original,mode,'universal'),structuredClone(draft));
    assert.deepEqual(restored.packet().board_size,p.board_size);
    const noChange=restored.update({base_revision:1,content:'[ENTITIES #guard]\nLocation: hall; guarding the door.'});
    assert.equal(noChange.changed,false);assert.deepEqual(noChange.board_size,p.board_size);
});
