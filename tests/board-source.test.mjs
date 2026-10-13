import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getBoardContentRanges } from '../board-source.js';
import { parseBlocks } from '../state.js';

const fixtures = [
    '', 'Unsectioned notes only.',
    '  Notes. \n\n [scene #first] \n  Body.  \n\n[ENTITIES #second]\nOther body.\n',
    '[SCENE #first]\r\nBody.\r\n\r\n[SCENE #first]\r\nDuplicate draft.\r\n',
    '[MISC #json]\n```json\n{"text":"[SCENE #fake]"}\n```\n[SCENE #real]\nBody.',
    '[MISC #note]\n````text\n[SCENE #fake]\n```\n[ENTITIES #also_fake]\n````\n[SCENE #real]\nBody.',
    '[MISC #note]\n~~~text\n[SCENE #fake]\n~~~~\n[ENTITIES #real]\nBody.',
    '  ```markdown\r\nNotes.\r\n[SCENE #first]\r\nBody.\r\n```  \r\n',
    '```text\n[SCENE #first]\n\n[ENTITIES #second]\nBody.\n```',
    '[SCENE #empty]\n[ENTITIES #next]\nBody.',
    '[SCENE #empty]', '[SCENE #empty]\n  \n\n',
    '[SCENE #a]\rBody.\r[ENTITIES #b]\rOther.',
];

test('editable source ranges match board parsing without normalizing neighboring text', () => {
    for (const raw of fixtures) {
        const parsed = parseBlocks(raw), ranges = getBoardContentRanges(raw);
        assert.equal(ranges.blocks.length, parsed.blocks.length, raw);
        assert.equal(raw.slice(ranges.preamble.start, ranges.preamble.end).replace(/\r\n?/g, '\n'), parsed.preamble, raw);
        for (const [index, range] of ranges.blocks.entries()) {
            assert.equal(raw.slice(range.start, range.end).replace(/\r\n?/g, '\n'), parsed.blocks[index].content, raw);
            const inserted = range.prefix + '- Edited content.' + range.suffix;
            const next = raw.slice(0, range.start) + inserted + raw.slice(range.end);
            const result = parseBlocks(next);
            assert.equal(result.blocks.length, parsed.blocks.length, raw);
            assert.equal(result.blocks[index].content, '- Edited content.', raw);
            assert.equal(next.slice(0, range.start), raw.slice(0, range.start));
            assert.equal(next.slice(range.start + inserted.length), raw.slice(range.end));
        }
    }
});

test('changing a fenced JSON body preserves preamble, sibling formatting and newline style', () => {
    const raw = '  Campaign notes. \r\n\r\n[MISC #json]\r\n```json\r\n{"value":1}\r\n```  \r\n\r\n  [SCENE #room]  \r\n  Stone.\r\n';
    const range = getBoardContentRanges(raw).blocks[0];
    const body = '```json\r\n{"value":2,"nested":"[SCENE #fake]"}\r\n```';
    const next = raw.slice(0, range.start) + body + raw.slice(range.end);
    assert.equal(next, raw.replace('```json\r\n{"value":1}\r\n```', body));
    assert.equal(parseBlocks(next).blocks.length, 2);
});
