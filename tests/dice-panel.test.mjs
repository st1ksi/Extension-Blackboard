import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCustomFaces, formatDiceReceipt } from '../dice-panel.js';

test('custom face input preserves duplicates and only parses entirely numeric faces', () => {
    assert.deepEqual(parseCustomFaces('1\r\n2\r\n2\r\n\n-1.5'), [1, 2, 2, -1.5]);
    assert.deepEqual(parseCustomFaces('Success\nBlank\nSuccess'), ['Success', 'Blank', 'Success']);
    assert.deepEqual(parseCustomFaces('1\nBlank\n2'), ['1', 'Blank', '2']);
    assert.deepEqual(parseCustomFaces('Infinity\nNaN'), ['Infinity', 'NaN']);
    assert.throws(() => parseCustomFaces(' \n\r\n'), /at least one custom face/);
});

test('receipt distinguishes kept and dropped dice and applies the modifier once', () => {
    const text = formatDiceReceipt({ status:'success', formula:'2d20kh1+5', mode:'advantage', total:22, modifier:5,
        groups:[{kind:'standard',selection:{operation:'kh',count:1},dice:[{values:[3],total:3,kept:false},{values:[17],total:17,kept:true}]}] });
    assert.match(text, /\[3\] \(dropped\), \[17\] \(kept\)/);
    assert.equal(text.match(/Modifier: \+5/g).length, 1);
    assert.match(text, /Total: 22/);
});

test('symbolic receipt shows actual labels, never numeric face indices as faces', () => {
    const text = formatDiceReceipt({status:'success',formula:'2 custom dice',mode:'normal',total:null,rolls:[2,1],rolls_kind:'face_indices',face_values:['Success','Blank'],
        groups:[{kind:'custom',faces:['Blank','Success','Success'],dice:[{values:['Success'],kept:true},{values:['Blank'],kept:true}]}]});
    assert.match(text, /Custom faces.*"Blank", "Success", "Success"/);
    assert.match(text, /Dice: \["Success"\], \["Blank"\]/);
    assert.match(text, /no numeric total/);
    assert.doesNotMatch(text, /Dice: 2, 1/);
});

test('copied custom labels cannot become HTML or break Markdown code spans', () => {
    const text = formatDiceReceipt({status:'success',total:null,groups:[{kind:'custom',faces:['<script>alert(1)</script>','```'],dice:[{values:['<script>alert(1)</script>'],kept:true}]}]});
    assert.doesNotMatch(text, /<script>|```/);
    assert.match(text, /\\u003cscript\\u003e/);
    assert.match(text, /\\u0060\\u0060\\u0060/);
});

test('partial receipt retains known faces but never claims a completed total', () => {
    const text = formatDiceReceipt({status:'uncertain',formula:'1d6!',total:24,groups:[{kind:'standard',dice:[{values:[6,6,6,6],total:24,kept:true}]}]});
    assert.match(text, /outcome uncertain/);
    assert.match(text, /6 \+ 6 \+ 6 \+ 6 = 24/);
    assert.doesNotMatch(text, /Total: 24/);
});
