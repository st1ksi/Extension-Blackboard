import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoardDrafts } from '../board-drafts.js';
import { isClearlyMobile, supportsPairedPanels } from '../panel-workspace.js';

test('live model updates preserve manual drafts and require conflict resolution before save', () => {
    const drafts = createBoardDrafts();
    drafts.sync('campaign', 'initial');
    drafts.edit('manual');
    const conflict = drafts.sync('campaign', 'model update');
    assert.equal(conflict.text, 'manual');
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.base, 'initial');
    drafts.accept('model update');
    assert.deepEqual(drafts.current, {base:'model update', text:'model update', conflict:false});
    assert.equal(drafts.sync('campaign', 'next model update').text, 'next model update');
});

test('chat and branch drafts are isolated across repeated switching', () => {
    const drafts = createBoardDrafts();
    drafts.sync('chat A', 'A'); drafts.edit('draft A');
    drafts.sync('chat B', 'B'); drafts.edit('draft B');
    assert.equal(drafts.sync('chat A', 'A').text, 'draft A');
    assert.equal(drafts.current.conflict, false);
    assert.equal(drafts.sync('chat B', 'B2').text, 'draft B');
    assert.equal(drafts.current.conflict, true);
    assert.equal(drafts.sync('chat A branch', 'A').text, 'A');
});

test('matching an external update resolves the draft without a false conflict', () => {
    const drafts = createBoardDrafts();
    drafts.sync('chat', 'old'); drafts.edit('new');
    assert.deepEqual(drafts.sync('chat', 'new'), {base:'new', text:'new', conflict:false});
});

for (const [name, navigator] of [
    ['Windows touch laptop', {platform:'Win32', userAgent:'Windows NT 10.0', maxTouchPoints:10}],
    ['Mac', {platform:'MacIntel', userAgent:'Macintosh', maxTouchPoints:0}],
    ['Linux touch desktop', {platform:'Linux x86_64', userAgent:'X11; Linux x86_64', maxTouchPoints:10}],
    ['masked desktop-site phone', {platform:'Linux x86_64', userAgent:'X11; Linux x86_64', maxTouchPoints:5}],
    ['unknown device', {}],
]) test(`${name}: ambiguous or desktop identity keeps desktop behavior`, () => {
    const env = {navigator, innerWidth:1440};
    assert.equal(isClearlyMobile(env), false);
    assert.equal(supportsPairedPanels(env), true);
    assert.equal(supportsPairedPanels({...env,innerWidth:900}), false, 'A narrow window still needs a fitting layout.');
});

for (const navigator of [{userAgent:'Android 14; Mobile'}, {userAgent:'iPhone'}, {userAgent:'iPad'}, {userAgent:'X11; Linux', userAgentData:{platform:'Android'}}]) {
    test(`explicit mobile identity opens one panel: ${JSON.stringify(navigator)}`, () => {
        assert.equal(isClearlyMobile({navigator}), true);
        assert.equal(supportsPairedPanels({navigator,innerWidth:1440}), false);
    });
}
