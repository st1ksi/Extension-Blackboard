// Optional browser regression: real entry point, handlers, templates, and host CSS.
// ST services are local doubles: no chats, saved settings, or model APIs are touched.
// ST_TEST_ROOT points to a SillyTavern installation (read-only assets).
// PLAYWRIGHT_MODULE_PATH may point to an existing Playwright package directory.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const hostRoot = resolve(process.env.ST_TEST_ROOT, 'public');
const prefix = '/scripts/extensions/third-party/Extension-Blackboard/';
const output = process.env.BB_SCREENSHOTS;
const stub = `
export async function renderExtensionTemplateAsync(_path, name) { return await (await fetch('${prefix}' + name + '.html')).text(); }
export function registerBlackboardPrivateRunner() {}
export function getCurrentUserHandle() { return 'preview-user'; }
export const SlashCommand = { fromProps: value => value };
export const ARGUMENT_TYPE = { STRING: 'string' }, SlashCommandArgument = SlashCommand, SlashCommandNamedArgument = SlashCommand;
export const commonEnumProviders = {};
export const SlashCommandParser = { commands: {}, addCommandObject() {} };
`;
const fixture = `<!DOCTYPE html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="${prefix}style.css">
<style>body { margin:0; background:#16191d; color:#d8dde2; font-family:Arial,sans-serif; overflow:hidden; }
#extensions_settings2 { position:absolute; left:24px; top:30px; width:400px; max-width:95vw; max-height:90vh; overflow:auto; padding:20px; background:#252930; border-radius:8px; }
.blackboard_settings > .inline-drawer > .inline-drawer-content { display:block; }
.blackboard_settings .inline-drawer-content .inline-drawer-content { display:none; }
</style><body><div id="extensions_settings2"></div><div id="extensionsMenu"></div>
<script src="/lib/jquery-3.5.1.min.js"></script><script>
window.notices = []; window.registered = new Map(); window.injected = new Map(); window.saves = 0;
window.toastr = Object.fromEntries(['info','success','warning','error'].map(type => [type, text => window.notices.push({type,text})]));
const metadata = { variables: {} };
const handlers = new Map();
const events = ['CHAT_CHANGED','MESSAGE_DELETED','MESSAGE_SWIPED','GENERATION_STARTED','MESSAGE_RECEIVED','MESSAGE_SENT','TOOL_CALLS_PERFORMED','GENERATE_BEFORE_COMBINE_PROMPTS'];
window.emit = async (name, ...args) => { for (const handler of handlers.get(name)||[]) await handler(...args); };
window.context = { chat: [], chatId:'Preview campaign', characterId:1, characters:[{}, {avatar:'preview-hero.png'}], chatMetadata:metadata, extensionSettings:{blackboard:{simulationFidelity:'ultra',privateReview:true,executionModeVersion:1}},
eventTypes:Object.fromEntries(events.map(e=>[e,e])), eventSource:{on(name,fn){const list=handlers.get(name)||[]; list.push(fn); handlers.set(name,list);}}, registerFunctionTool:tool=>registered.set(tool.name,tool), unregisterFunctionTool:name=>registered.delete(name),
setExtensionPrompt:(key,value)=>injected.set(key,value), saveSettingsDebounced:()=>saves++,saveMetadataDebounced(){},saveChatDebounced(){},
variables:{local:{get:key=>context.chatMetadata.variables[key],set:(key,value)=>context.chatMetadata.variables[key]=value}} };
window.SillyTavern = {getContext:()=>context};
</script><script type="module">window.bbApi = await import("${prefix}index.js");</script></body></html>`;

async function checkInspector(page, dashboard, origin) {
    const inspector = page.locator('#blackboard-inspector');
    const editor = inspector.locator('[data-board-editor]');
    const save = inspector.locator('[data-board-save]');
    const initial = '[MISC #world_clock]\n- Time: Day 1, 01:14:20\n\n[SCENE #van_dorn_study]\n- Geometry: 30 ft east–west, 25 ft north–south. Rain against the northern windows.\n- A heavy desk stands opposite the entrance. The safe behind the painting is locked.\n- Exits: north window to the ledge; south door to the gallery; west panel to the attic.\n\n[ENTITIES #night_watch]\n- Two guards continue their patrol toward the southern gate.\n- Return scheduled: Day 1, 01:24:00.\n\n[NARRATIVE #missing_ledger]\n- The ledger was taken from the hidden desk compartment before the player arrived.';
    await page.setViewportSize({width:1920,height:1080});
    await page.evaluate(text => bbApi.setBlackboard(text), initial);
    await page.locator('#blackboard_control_wand_button').click();
    assert.equal(await dashboard.isVisible(), true);
    await dashboard.getByRole('tab', {name:'Settings',exact:true}).click();
    assert.equal(await inspector.isVisible(), false, 'Settings menu opens only settings from a closed workspace.');
    await dashboard.getByRole('button', {name:/Open board inspector/}).click();
    await inspector.waitFor({state:'visible'});
    assert.equal(await editor.inputValue(), initial);
    assert.equal(await inspector.locator('[data-board-cards]').isVisible(), true, 'The board opens as cards.');
    assert.equal(await inspector.locator('.bb-board-card').count(), 4);
    assert.equal(await inspector.locator('.bb-board-chip').count(), 4);
    assert.equal(await editor.isVisible(), false);
    assert.equal(await dashboard.isVisible(), true);
    let left = await inspector.boundingBox(), right = await dashboard.boundingBox();
    assert.ok(left.x + left.width < right.x && right.x - left.x - left.width <= 16, 'Board is immediately left of settings.');
    assert.ok(left.width > right.width && Math.abs(left.height - right.height) < 1 && left.y === right.y);
    assert.ok(Math.abs(left.y + left.height / 2 - 540) < 2);
    assert.equal(await save.isDisabled(), true);
    await inspector.locator('[data-board-view="source"]').click();
    await editor.fill(initial + '\n- Manual detail.');
    assert.equal(await page.evaluate(() => bbApi.getBlackboard()), initial, 'Drafts never become live state before Save.');
    await inspector.locator('[data-board-close]').click();
    assert.equal(await dashboard.isVisible(), true, 'Board closes independently.');
    await dashboard.getByRole('button', {name:/Open board inspector/}).click();
    assert.match(await editor.inputValue(), /Manual detail/);
    await editor.press('Control+s');
    assert.match(await page.evaluate(() => bbApi.getBlackboard()), /Manual detail/);
    assert.match(await inspector.locator('[data-board-status]').innerText(), /Saved/);
    await page.evaluate(text => bbApi.setBlackboard(text), initial + '\n- Model detail.');
    assert.match(await editor.inputValue(), /Model detail/, 'Clean editors follow live updates.');
    await editor.fill(initial + '\n- Pending manual edit.');
    await page.evaluate(text => bbApi.setBlackboard(text), initial + '\n- New model change.');
    assert.match(await editor.inputValue(), /Pending manual edit/);
    assert.equal(await save.isDisabled(), true);
    assert.equal(await inspector.locator('[data-board-conflict]').isVisible(), true);
    await editor.press('Control+s');
    assert.match(await page.evaluate(() => bbApi.getBlackboard()), /New model change/);
    await page.evaluate(() => Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.copiedDraft=text},configurable:true}));
    await inspector.locator('[data-board-copy]').click();
    assert.match(await page.evaluate(() => copiedDraft), /Pending manual edit/);
    page.once('dialog', dialog => dialog.accept());
    await inspector.locator('[data-board-reload]').click();
    assert.match(await editor.inputValue(), /New model change/);
    assert.equal(await inspector.locator('[data-board-conflict]').isVisible(), false);

    await editor.fill(initial + '\n\n[SCENE #van_dorn_study]\n- Duplicate.');
    await save.click();
    assert.match(await inspector.locator('[data-board-status]').innerText(), /Not saved.*Duplicate/);
    assert.match(await editor.inputValue(), /Duplicate/);
    assert.doesNotMatch(await page.evaluate(() => bbApi.getBlackboard()), /Duplicate/);
    page.once('dialog', dialog => dialog.accept());
    await inspector.locator('[data-board-reload]').click();
    await inspector.locator('[data-board-filter]').fill('night_watch');
    assert.equal(await inspector.locator('.bb-board-chip').count(), 1);
    await inspector.locator('.bb-board-chip').click();
    assert.equal(await inspector.locator('[data-board-cards]').isVisible(), true, 'Chips open the matching card from either view.');
    assert.equal(await inspector.locator('.bb-board-card[data-block-index="2"]').evaluate(e => e === document.activeElement), true);
    assert.equal(await inspector.locator('.bb-board-chip').getAttribute('aria-current'), 'true');
    await inspector.locator('[data-board-filter]').fill('');
    await inspector.getByText('Editing tools', {exact:true}).click();
    await inspector.locator('[data-board-insert="LORE"]').click();
    assert.equal(await editor.evaluate(e => e.value.slice(e.selectionStart,e.selectionEnd)), 'tag');
    assert.match(await editor.inputValue(), /\[LORE #tag\]/);
    page.once('dialog', dialog => dialog.accept());
    await inspector.locator('[data-board-clear]').click();
    assert.equal(await editor.inputValue(), '');
    assert.match(await page.evaluate(() => bbApi.getBlackboard()), /New model change/);
    page.once('dialog', dialog => dialog.accept());
    await inspector.locator('[data-board-reload]').click();
    await inspector.getByText('Editing tools', {exact:true}).click();

    await editor.fill(initial + '\n- Chat A unsaved.');
    await page.evaluate(async () => {
        window.originalChat = {id:context.chatId, metadata:context.chatMetadata, chat:context.chat};
        context.chatId = 'Another campaign'; context.chatMetadata={variables:{world_blackboard:'[SCENE #another]\n- Other campaign.'}}; context.chat=[];
        await emit('CHAT_CHANGED');
    });
    assert.match(await editor.inputValue(), /Other campaign/);
    assert.doesNotMatch(await editor.inputValue(), /Chat A/);
    await editor.fill('[SCENE #another]\n- Chat B unsaved.');
    await page.evaluate(async () => { context.chatId=originalChat.id; context.chatMetadata=originalChat.metadata; context.chat=originalChat.chat; await emit('CHAT_CHANGED'); });
    assert.match(await editor.inputValue(), /Chat A unsaved/);
    assert.doesNotMatch(await page.evaluate(() => bbApi.getBlackboard()), /Chat A unsaved/);
    page.once('dialog', dialog => dialog.accept());
    await inspector.locator('[data-board-reload]').click();

    await dashboard.locator('[data-bb-tier="low"]').click();
    assert.equal(await inspector.locator('[data-board-corridor]').innerText(), '1,000–2,000', 'Board budget follows the adjacent settings.');
    await dashboard.locator('[data-bb-tier="ultra"]').click();
    await dashboard.locator('[data-bb-close]').click();
    assert.equal(await inspector.isVisible(), true, 'Settings close independently.');
    await inspector.locator('[data-board-close]').click();
    await page.locator('#blackboard_wand_button').click();
    assert.equal(await inspector.isVisible(), true);
    assert.equal(await dashboard.isVisible(), true, 'Desktop wand opens both.');
    assert.equal(await page.locator('#blackboard-inspector').count(), 1);
    await checkBlockCards(page, inspector, initial);
    await checkInlineEditing(page, inspector);
    await page.locator('#blackboard_wand_button').click(); // Reopen both after the narrow-screen checks.
    if (output) await page.screenshot({animations:'disabled',path:resolve(output,'workspace-desktop.png')});
    await page.setViewportSize({width:1200,height:800});
    left=await inspector.boundingBox(); right=await dashboard.boundingBox();
    assert.ok(left.x >= 0 && left.x+left.width < right.x && right.x+right.width <= 1200);
    await page.setViewportSize({width:900,height:800});
    await dashboard.waitFor({state:'hidden'});
    assert.equal(await inspector.isVisible(), true);
    assert.equal(await dashboard.isVisible(), false, 'Resizing keeps the last active panel usable.');
    await inspector.locator('[data-board-settings]').click();
    assert.equal(await inspector.isVisible(), false);
    assert.equal(await dashboard.isVisible(), true);
    await dashboard.getByRole('button', {name:/Open board inspector/}).click();
    assert.equal(await inspector.isVisible(), true);
    assert.equal(await dashboard.isVisible(), false);
    for (const width of [390,320]) {
        await page.setViewportSize({width,height:780});
        const box=await inspector.boundingBox();
        assert.ok(box.x>=0 && box.x+box.width<=width && box.y>=0 && box.y+box.height<=780);
        assert.ok(await inspector.evaluate(p=>[p,...p.querySelectorAll('.bb-board-body, .bb-board-footer, .bb-dash-header, .bb-board-chips, .bb-board-cards, .bb-board-card')].every(e=>e.scrollWidth<=e.clientWidth+1)));
        await inspector.locator('[data-board-settings]').click();
        await dashboard.getByRole('button', {name:/Open board inspector/}).click();
        if (output) await page.screenshot({animations:'disabled',path:resolve(output,`inspector-mobile-${width}.png`)});
    }
    // A phone with an unusually wide layout is still single-panel when it identifies itself.
    const browser = page.context().browser();
    const mobile = await browser.newContext({viewport:{width:1440,height:900},hasTouch:true,userAgent:'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 Chrome/130 Safari/537.36'});
    const phone = await mobile.newPage();
    await phone.route('**/*', route=>route.request().url().startsWith(origin)?route.continue():route.abort());
    await phone.goto(origin);
    await phone.waitForSelector('#blackboard_open_dashboard');
    await phone.waitForFunction(()=>document.querySelector('#blackboard-inspector'));
    await phone.locator('#blackboard_wand_button').click();
    assert.equal(await phone.locator('#blackboard-inspector').isVisible(),true);
    assert.equal(await phone.locator('#blackboard-dashboard').isVisible(),false);
    await mobile.close();
    console.log('Inspector checks passed: paired routes, singleton, live updates, conflicts, validation, chat drafts, tools and responsive behavior.');
}

async function checkBlockCards(page, inspector, initial) {
    const editor = inspector.locator('[data-board-editor]');
    const cards = inspector.locator('[data-board-cards]');
    const chips = inspector.locator('[data-board-chips]');
    const source = inspector.locator('[data-board-view="source"]');
    const blocks = inspector.locator('[data-board-view="blocks"]');
    const live = await page.evaluate(() => bbApi.getBlackboard());
    // Draft presentation must never normalize source or interpret HTML/fenced headers.
    const raw = '  Unsectioned notes.\n\n' + initial + '\n\n[LORE #harbor]\n- Fog obscures the old lighthouse.\n\n[MISC #structured]\n```text\n[SCENE #not_a_block]\n<img src=x onerror="window.boardHtmlExecuted=true">\n```\n\n[SCENE #van_dorn_study]\n- A duplicate in an unsaved draft.  \n\n';
    await source.click();
    await editor.fill(raw);
    await blocks.click();
    assert.equal(await inspector.locator('.bb-board-card').count(), 8, 'Preamble and duplicate drafts are visible; fenced headers remain content.');
    assert.equal(await inspector.locator('.bb-board-chip').count(), 7);
    assert.equal(await cards.locator('img').count(), 0);
    assert.equal(await page.evaluate(() => !!window.boardHtmlExecuted), false);
    assert.match(await cards.innerText(), /SCENE #not_a_block/);
    await inspector.locator('[data-board-filter]').fill('van_dorn_study');
    assert.equal(await inspector.locator('.bb-board-chip').count(), 2);
    await inspector.locator('.bb-board-chip').last().press('Enter');
    assert.equal(await inspector.locator('.bb-board-card[data-block-index="6"]').evaluate(e=>e===document.activeElement), true, 'Duplicate headers have distinct navigation targets.');
    await source.click();
    assert.equal(await editor.inputValue(), raw, 'Switching views preserves the exact draft.');
    await blocks.click();
    await inspector.locator('[data-board-copy]').click();
    assert.equal(await page.evaluate(()=>copiedDraft), raw, 'Copy uses the full source from card view.');
    assert.equal(await page.evaluate(()=>bbApi.getBlackboard()), live);

    // A large board and very long tags must fit, with independently scrolling links.
    const categories = ['SCENE','ENTITIES','NARRATIVE','LORE','MISC'];
    const large = categories.map((category, i) => `[${category} #palette_${i}]\n- A readable note.`).concat(
        Array.from({length:80}, (_,i)=>`[${categories[i%5]} #section_${i}_${'long_tag_'.repeat(12)}]\n- ${'long_unbroken_text_'.repeat(28)}\n- Additional detail.`)
    ).join('\n\n');
    await source.click(); await editor.fill(large); await blocks.click();
    await inspector.locator('[data-board-filter]').fill('');
    assert.equal(await inspector.locator('.bb-board-chip').count(), 85);
    assert.ok(await chips.evaluate(e=>e.scrollHeight > e.clientHeight && e.clientHeight <= 110));
    const colors = await inspector.locator('.bb-board-chip').evaluateAll(elements=>elements.slice(0,5).map(e=>getComputedStyle(e).borderColor));
    assert.equal(new Set(colors).size, 5, 'All five categories have distinct colors.');
    assert.ok(await inspector.evaluate(p=>[...p.querySelectorAll('.bb-board-card')].every(card=>getComputedStyle(card).getPropertyValue('--bb-category')===getComputedStyle(p.querySelector(`.bb-board-chip[data-category="${card.dataset.category}"]`)).getPropertyValue('--bb-category'))));
    await inspector.locator('[data-board-filter]').fill('section_79');
    await inspector.locator('.bb-board-chip').click();
    await page.waitForFunction(()=>{
        const card=document.querySelector('.bb-board-card[data-block-index="84"]'), box=document.querySelector('[data-board-cards]').getBoundingClientRect(), target=card.getBoundingClientRect();
        return target.top >= box.top-1 && target.bottom <= box.bottom+1;
    });
    for (const width of [390,320]) {
        await page.setViewportSize({width,height:780});
        assert.ok(await inspector.evaluate(p=>[p,...p.querySelectorAll('.bb-board-body, .bb-board-chips, .bb-board-cards, .bb-board-card')].every(e=>e.scrollWidth<=e.clientWidth+1)), 'Long tags and unbroken content wrap on narrow screens.');
    }
    await page.setViewportSize({width:1920,height:1080});
    await inspector.locator('[data-board-filter]').fill('nothing_matches');
    assert.match(await chips.innerText(), /No matching blocks/);
    assert.equal(await inspector.locator('.bb-board-card').count(), 85, 'Filtering links does not hide board content.');
    await inspector.locator('[data-board-filter]').fill('');
    await inspector.getByText('Editing tools', {exact:true}).click();
    page.once('dialog', dialog=>dialog.accept());
    await inspector.locator('[data-board-clear]').click();
    assert.match(await cards.innerText(), /The board is empty/);
    assert.equal(await editor.inputValue(), '');
    await inspector.getByText('Editing tools', {exact:true}).click();
    page.once('dialog', dialog=>dialog.accept());
    await inspector.locator('[data-board-reload]').click();
    assert.equal(await editor.inputValue(), live);
    assert.equal(await page.evaluate(()=>bbApi.getBlackboard()), live);
    // Use all five categories for the final visual fixture.
    await page.evaluate(text=>bbApi.setBlackboard(text), initial + '\n\n[LORE #verenhall]\n- A harbor city of granite towers, narrow canals and merchant houses.');
    assert.equal(await inspector.locator('.bb-board-card').count(), 5, 'Clean card view follows a committed update.');
    await cards.evaluate(e=>e.scrollTop=0);
    console.log('Block cards passed: exact draft preservation, safe text, fenced/duplicate headers, keyboard jumps, colors, large boards, narrow layouts and live updates.');
}

async function checkInlineEditing(page, inspector) {
    const editor = inspector.locator('[data-board-editor]');
    const source = inspector.locator('[data-board-view="source"]');
    const cardsView = inspector.locator('[data-board-view="blocks"]');
    const pencil = index => inspector.locator(`[data-board-edit-block="${index}"]`);
    const field = inspector.locator('.bb-board-block-editor');
    const save = inspector.locator('[data-board-save]');
    const live = await page.evaluate(() => bbApi.getBlackboard());
    const raw = '  Campaign notes. \n\n[SCENE #room]\n  - Original room.  \n\n[MISC #structured]\n```json\n{"note":"[SCENE #fake]","value":1}\n```  \n\n[SCENE #room]\n- Duplicate draft.\n\n[ENTITIES #empty]\n[LORE #next]\n  - Last content.  \n\n';
    await source.click(); await editor.fill(raw); await cardsView.click();
    assert.equal(await inspector.locator('[data-board-edit-block]').count(), 6, 'Every block and preamble has a pencil.');
    await pencil(1).click();
    assert.equal(await editor.isVisible(), false, 'Inline edits do not switch to Full text.');
    const changedBody = '```json\n{"note":"[SCENE #fake]","value":2}\n```';
    await field.fill(changedBody);
    await field.press('End'); await field.press('Enter'); await field.pressSequentially('- Extra note.');
    await page.waitForFunction(()=>document.querySelector('[data-board-chars]').textContent === Number(document.querySelector('[data-board-editor]').value.length).toLocaleString('en-US'));
    assert.equal(await field.evaluate(e=>e===document.activeElement), true, 'Statistics updates retain inline focus.');
    const expected = raw.replace('```json\n{"note":"[SCENE #fake]","value":1}\n```', changedBody + '\n- Extra note.');
    assert.equal(await editor.inputValue(), expected, 'Only the selected raw fragment changes.');
    assert.equal(await page.evaluate(()=>bbApi.getBlackboard()), live, 'Typing remains a manual draft.');
    await inspector.locator('[data-board-copy]').click();
    assert.equal(await page.evaluate(()=>copiedDraft), expected);
    await inspector.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal(await editor.inputValue(), raw, 'Cancel restores only this editing session.');

    await pencil(2).click(); await field.fill('- Correct duplicate target.');
    await inspector.getByRole('button',{name:'Done',exact:true}).click();
    assert.equal(await editor.inputValue(), raw.replace('- Duplicate draft.', '- Correct duplicate target.'));
    assert.equal(await inspector.locator('.bb-board-block-editor').count(), 0);
    await pencil(0).click(); await field.fill('- Temporary change.'); await field.press('Escape');
    assert.equal(await inspector.isVisible(), true, 'Escape cancels inline edits before closing the inspector.');
    assert.match(await editor.inputValue(), /Original room/);
    assert.match(await editor.inputValue(), /Correct duplicate target/, 'Cancelling one block retains other draft edits.');
    await pencil('preamble').click(); await field.fill('Updated campaign notes.');
    await pencil(3).click(); // Finish one edit and start another in the same view.
    assert.equal(await field.count(), 1);
    await field.fill('- Filled previously empty block.');
    await inspector.getByRole('button',{name:'Done',exact:true}).click();
    assert.match(await editor.inputValue(), /Updated campaign notes/);
    assert.match(await editor.inputValue(), /\[ENTITIES #empty\]\n- Filled previously empty block.\n\n\[LORE #next\]/);
    await source.click();
    assert.match(await editor.inputValue(), /Correct duplicate target/);
    await cardsView.click();
    await save.click();
    assert.match(await inspector.locator('[data-board-status]').innerText(), /Not saved.*Duplicate/, 'Inline editing uses normal Save validation.');
    page.once('dialog',dialog=>dialog.accept()); await inspector.locator('[data-board-reload]').click();

    // A normal inline save commits through the same public state path.
    await pencil(1).click(); await field.fill('- Inline room detail.');
    await field.press('Control+s');
    assert.match(await page.evaluate(()=>bbApi.getBlackboard()), /Inline room detail/);
    assert.equal(await field.count(), 0);
    assert.equal(await save.isDisabled(), true);
    assert.equal(await editor.isVisible(), false);
    const committed = await page.evaluate(()=>bbApi.getBlackboard());
    await pencil(1).click(); await field.fill('- Kept draft despite model update.');
    await page.evaluate(text=>bbApi.setBlackboard(text), committed + '\n- A concurrent model change.');
    assert.equal(await field.count(), 1, 'Dirty inline edits survive a committed update.');
    assert.match(await field.inputValue(), /Kept draft/);
    assert.equal(await save.isDisabled(), true);
    assert.equal(await inspector.locator('[data-board-conflict]').isVisible(), true);
    page.once('dialog',dialog=>dialog.accept()); await inspector.locator('[data-board-reload]').click();
    assert.equal(await field.count(), 0, 'Load latest closes the old editor.');
    assert.match(await editor.inputValue(), /concurrent model change/);
    // Clean open edits follow the saved source without leaving stale textareas.
    await pencil(1).click();
    await page.evaluate(text=>bbApi.setBlackboard(text), committed);
    assert.equal(await field.count(), 0);

    await pencil(1).click(); await field.fill('- Chat A inline draft.');
    await page.evaluate(async()=>{
        window.inlineChat={id:context.chatId,metadata:context.chatMetadata,chat:context.chat};
        context.chatId='Inline other chat';context.chatMetadata={variables:{world_blackboard:'[SCENE #other]\n- Another room.'}};context.chat=[];await emit('CHAT_CHANGED');
    });
    assert.equal(await field.count(), 0);
    assert.match(await editor.inputValue(), /Another room/);
    await pencil(0).click(); await field.fill('- Chat B inline draft.');
    await page.evaluate(async()=>{context.chatId=inlineChat.id;context.chatMetadata=inlineChat.metadata;context.chat=inlineChat.chat;await emit('CHAT_CHANGED');});
    assert.match(await editor.inputValue(), /Chat A inline draft/);
    assert.doesNotMatch(await editor.inputValue(), /Chat B/);
    page.once('dialog',dialog=>dialog.accept()); await inspector.locator('[data-board-reload]').click();
    await pencil(1).click(); await field.fill('- Draft survives closing.');
    await inspector.locator('[data-board-close]').click();
    await page.locator('#blackboard_wand_button').click();
    assert.match(await editor.inputValue(), /Draft survives closing/);
    page.once('dialog',dialog=>dialog.accept()); await inspector.locator('[data-board-reload]').click();

    // The pencil, actions and field also fit the smallest supported layout.
    await page.setViewportSize({width:320,height:780});
    await pencil(0).click();
    assert.ok(await inspector.evaluate(p=>[p,...p.querySelectorAll('.bb-board-card, .bb-board-card-header, .bb-board-block-editor')].every(e=>e.scrollWidth<=e.clientWidth+1)));
    if (output) await page.screenshot({animations:'disabled',path:resolve(output,'inline-editor-mobile-320.png')});
    await inspector.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.setViewportSize({width:1920,height:1080});
    await page.locator('#blackboard_wand_button').click();
    await pencil(1).click();
    if (output) await page.screenshot({animations:'disabled',path:resolve(output,'inline-editor-desktop.png')});
    await inspector.getByRole('button',{name:'Cancel',exact:true}).click();
    console.log('Inline editing passed: exact fragment changes, cancellation, focus, validation, Save, conflicts, per-chat drafts, closing and mobile layout.');
}

const server = createServer(async (request, response) => {
    try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(fixture); return; }
        if ((pathname.startsWith('/scripts/') && !pathname.startsWith(prefix)) || pathname === prefix + 'private-host.js') {
            response.setHeader('Content-Type', 'text/javascript'); response.end(stub); return;
        }
        const base = pathname.startsWith(prefix) ? root : hostRoot;
        const relative = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname.slice(1);
        const path = resolve(base, relative);
        if (!path.startsWith(base + sep)) { response.writeHead(403).end(); return; }
        const mime = { '.js':'text/javascript', '.css':'text/css', '.html':'text/html', '.woff2':'font/woff2', '.woff':'font/woff' }[extname(path)];
        response.setHeader('Content-Type', mime || 'application/octet-stream'); response.end(await readFile(path));
    } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
    browser = await chromium.launch({ channel: process.env.BB_BROWSER_CHANNEL || 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', event => { if (event.type() === 'error' && event.text().includes('Blackboard')) errors.push(event.text()); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.goto(origin);
    await page.waitForFunction(() => document.querySelector('#blackboard-dashboard') && window.registered.has('UpdateBlackboard'));
    const panel = page.locator('#blackboard-dashboard');
    const mirror = id => panel.locator(`[data-bb-control="blackboard_${id}"]`);
    const settings = () => page.evaluate(() => context.extensionSettings.blackboard);
    await page.locator('#blackboard_open_dashboard').click();
    await panel.waitFor({state:'visible'});
    let box = await panel.boundingBox();
    assert.ok(Math.abs(box.y + box.height / 2 - 500) < 2, `Panel is vertically centered: ${JSON.stringify(box)}. ${await panel.evaluate(e => JSON.stringify({ position:getComputedStyle(e).position, top:getComputedStyle(e).top, transform:getComputedStyle(e).transform, bodyTransform:getComputedStyle(document.body).transform }))}`);
    assert.ok(box.x > 800 && 1440 - box.x - box.width < 30, 'Panel is aligned right.');
    assert.equal(await panel.getAttribute('aria-modal'), 'false');
    assert.equal(await panel.locator('[data-bb-tier="ultra"]').getAttribute('aria-checked'), 'true');
    assert.match(await panel.locator('[data-bb-tier="ultra"]').innerText(), /6,000–21,000/);

    await mirror('function_tool').uncheck();
    assert.equal((await settings()).functionTool, false);
    assert.equal(await page.locator('#blackboard_function_tool').isChecked(), false);
    assert.equal(await mirror('auto_scene_background').isChecked(), true);
    assert.ok(await page.evaluate(() => !registered.has('UpdateBlackboard') && registered.has('SetSceneBackground') && injected.get('blackboard_system_prompt') === '' && !!injected.get('blackboard_bg_prompt')));
    assert.equal(await mirror('private_mode').isDisabled(), true, 'Master off disables both mode controls.');
    // Programmatic change from the native/setup UI reflects in the custom view.
    await page.evaluate(() => $('#blackboard_function_tool').prop('checked', true).trigger('change'));
    assert.equal(await mirror('function_tool').isChecked(), true);
    await mirror('private_review').uncheck();
    assert.equal((await settings()).privateReview, false);
    await panel.getByText('Private Turn options', {exact:true}).click();
    assert.equal(await mirror('private_format').isDisabled(), true);
    assert.equal(await mirror('private_mode').isDisabled(), true);
    await mirror('private_review').check();
    assert.equal(await mirror('private_format').isDisabled(), false);
    assert.equal(await mirror('private_mode').inputValue(), 'heavy', 'Existing installations retain the heavy workflow.');
    assert.equal(await mirror('private_mode').isDisabled(), false);
    await mirror('private_mode').selectOption('light');
    assert.equal((await settings()).privateReviewMode, 'light');
    assert.equal(await page.locator('#blackboard_private_mode').inputValue(), 'light');
    assert.match(await panel.locator('[data-bb-text="blackboard_private_mode_desc"]').innerText(), /one|single/i);
    await mirror('private_review').uncheck();
    assert.equal(await mirror('private_mode').isDisabled(), true);
    assert.equal((await settings()).privateReviewMode, 'light', 'Standard mode preserves the chosen review preference.');
    await mirror('private_review').check();
    assert.equal(await mirror('private_mode').inputValue(), 'light');
    await page.evaluate(() => $('#blackboard_private_mode').val('heavy').trigger('change'));
    assert.equal(await mirror('private_mode').inputValue(), 'heavy', 'Native mode changes synchronize the custom panel.');
    await mirror('private_format').selectOption('full');
    assert.equal((await settings()).privateReviewFormat, 'full');
    await panel.getByText('Private Turn options', {exact:true}).click();
    // A native capability rejection must also undo the dashboard switch.
    await mirror('private_review').uncheck();
    await page.evaluate(() => Object.defineProperty(navigator, 'locks', {value:null, configurable:true}));
    await mirror('private_review').click();
    assert.equal(await mirror('private_review').isChecked(), false);
    assert.equal((await settings()).privateReview, false);
    assert.equal(await mirror('private_mode').isDisabled(), true, 'Capability rejection also disables the mirrored mode selector.');
    assert.ok(await page.evaluate(() => notices.some(n => /unavailable/.test(n.text))));
    await page.evaluate(() => delete navigator.locks);
    await mirror('private_review').check();

    await panel.locator('[data-bb-tier="low"]').click();
    assert.equal((await settings()).simulationFidelity, 'low');
    assert.equal((await settings()).targetMinTokens, 1000);
    await panel.locator('[data-bb-tier="custom"]').click();
    await mirror('min_tokens').fill('8500');
    await mirror('max_tokens').focus();
    assert.equal((await settings()).targetMaxTokens, 8500, 'Native budget clamping is reused.');
    assert.equal(await mirror('max_tokens').inputValue(), '8500');
    await mirror('max_tokens').fill('9000');
    await mirror('game_system').focus();
    await mirror('game_system').selectOption('universal');
    assert.equal((await settings()).targetMaxTokens, 9000);
    assert.equal((await settings()).gameSystem, 'universal');
    await mirror('min_tokens').fill('');
    await mirror('max_tokens').focus();
    assert.equal(await mirror('min_tokens').inputValue(), '8500');
    assert.equal((await settings()).targetMinTokens, 8500, 'An invalid budget cannot leave UI and saved settings inconsistent.');

    await panel.getByRole('tab', {name:'Instructions',exact:true}).click();
    const initialCustom = (await settings()).customPrompt;
    await mirror('custom_prompt').fill('DRAFT — not saved');
    assert.equal((await settings()).customPrompt, initialCustom, 'Typing does not save prompt drafts.');
    assert.equal(await page.locator('#blackboard_custom_prompt').inputValue(), 'DRAFT — not saved');
    await mirror('custom_prompt').press('Escape');
    assert.equal(await panel.isVisible(), false);
    assert.equal(await page.locator('#blackboard_open_dashboard').evaluate(e => e === document.activeElement), true);
    await page.locator('#blackboard_open_dashboard').click();
    assert.equal(await mirror('custom_prompt').inputValue(), 'DRAFT — not saved', 'Closing/reopening preserves draft.');
    await panel.getByRole('button', {name:'Save quality prompt',exact:true}).click();
    assert.equal((await settings()).customPrompt, 'DRAFT — not saved');
    await page.evaluate(() => $('#blackboard_custom_prompt').val('NATIVE DRAFT').trigger('input'));
    assert.equal(await mirror('custom_prompt').inputValue(), 'NATIVE DRAFT');
    await panel.getByRole('button', {name:'Reset to preset',exact:true}).click();
    assert.equal((await settings()).customPrompt, '');
    assert.notEqual(await mirror('custom_prompt').inputValue(), 'NATIVE DRAFT');
    await panel.getByText('Background instructions', {exact:true}).first().click();
    await mirror('background_custom_prompt').fill('BACKGROUND DRAFT');
    await panel.getByRole('button', {name:'Save background prompt',exact:true}).click();
    assert.equal((await settings()).customBackgroundPrompt, 'BACKGROUND DRAFT');
    await panel.getByRole('button', {name:'Reset to default',exact:true}).click();
    assert.equal((await settings()).customBackgroundPrompt, '');
    await panel.getByText('Game profile', {exact:false}).filter({hasText:'Read-only'}).first().click();
    assert.equal(await mirror('game_profile_preview').getAttribute('readonly'), '');
    assert.equal(await mirror('game_profile_preview').inputValue(), await page.locator('#blackboard_game_profile_preview').inputValue());
    await panel.getByRole('tab', {name:'Settings',exact:true}).click();
    await panel.locator('[data-bb-tier="ultra"]').click();
    // Reselecting an active preset must preserve its saved custom override.
    await page.evaluate(() => { $('#blackboard_custom_prompt').val('SAVED OVERRIDE'); $('#blackboard_save_prompt').trigger('click'); });
    await panel.locator('[data-bb-tier="ultra"]').click();
    assert.equal((await settings()).customPrompt, 'SAVED OVERRIDE');
    await panel.locator('[data-bb-tier="ultra"]').press('Home');
    assert.equal((await settings()).simulationFidelity, 'low', 'Tier keyboard navigation updates settings.');
    await panel.locator('[data-bb-tier="ultra"]').click();
    await mirror('game_system').selectOption('dnd5e');

    await panel.getByText('Advanced settings', {exact:true}).click();
    await mirror('auto_inject_prompt').uncheck();
    assert.equal((await settings()).autoInjectPrompt, false);
    assert.ok(await page.evaluate(() => !injected.get('blackboard_system_prompt') && !injected.get('blackboard_bg_prompt')));
    await mirror('auto_inject_prompt').check();
    await mirror('history_rollback').uncheck();
    assert.equal((await settings()).historyRollback, false);
    await panel.getByText('Advanced settings', {exact:true}).click();
    await panel.getByRole('button', {name:'Export private turn',exact:true}).click();
    await page.waitForFunction(() => notices.some(n => /No private turn report/.test(n.text)));
    assert.ok(await page.evaluate(() => notices.some(n => /No private turn report/.test(n.text))));

    await panel.locator('.bb-dash-scroll').evaluate(e => e.scrollTop = 0);
    if (output) { await mkdir(output, {recursive:true}); await page.screenshot({animations:'disabled',path:resolve(output,'dashboard-desktop.png')}); }
    for (const width of [390, 320]) {
        await page.setViewportSize({width, height:780});
        box = await panel.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 780, 'Mobile panel fits viewport.');
        const noOverflow = await panel.evaluate(p => [...p.querySelectorAll('.bb-dash-scroll, .bb-dash-pane:not([hidden]), .bb-dash-footer')].every(e => e.scrollWidth <= e.clientWidth + 1));
        assert.equal(noOverflow, true, 'No sideways scrolling on mobile.');
        if (output) await page.screenshot({animations:'disabled',path:resolve(output,`dashboard-mobile-${width}.png`)});
    }
    await panel.getByRole('tab', {name:'Settings',exact:true}).press('ArrowRight');
    assert.equal(await panel.getByRole('tab', {name:'Instructions',exact:true}).getAttribute('aria-selected'), 'true');
    await panel.getByRole('button', {name:'Close settings',exact:true}).click();
    await page.locator('#blackboard_open_dashboard').click();
    assert.equal(await page.locator('#blackboard-dashboard').count(), 1);
    await panel.getByRole('button', {name:/Open board inspector/}).click();
    await page.locator('#blackboard-inspector').waitFor({state:'visible'});
    assert.equal(await panel.isVisible(), false);
    await page.locator('[data-board-close]').click();
    await checkInspector(page, panel, origin);
    await checkCampaignSettings(page, origin);
    await checkPrivateReportExport(page);
    assert.deepEqual(errors, []);
    console.log('Dashboard browser checks passed: real handlers, shared state/drafts, tools/prompts, actions, keyboard, desktop & mobile.');
} finally {
    await browser?.close();
    server.close();
}

async function checkCampaignSettings(parent, origin) {
    const browserContext = await parent.context().browser().newContext();
    const page = await browserContext.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    try {
        await page.setViewportSize({width:1440,height:1000});
        await page.goto(origin);
        await page.waitForSelector('#blackboard_open_dashboard');
        await page.locator('#blackboard_open_dashboard').click();
        const panel = page.locator('#blackboard-dashboard');
        const control = name => panel.locator(`[data-bb-control="blackboard_${name}"]`);
        const local = () => page.evaluate(() => context.chatMetadata.blackboard_settings.values);
        await control('settings_scope').selectOption('chat');
        await control('game_system').selectOption('universal');
        await panel.locator('[data-bb-tier="low"]').click();
        await control('private_mode').selectOption('light');
        await control('auto_scene_background').uncheck();
        assert.equal((await local()).simulationFidelity, 'low');
        assert.equal(await page.evaluate(() => context.extensionSettings.blackboard.simulationFidelity), 'ultra');
        assert.equal(await page.evaluate(() => registered.has('SetSceneBackground')), false);
        await panel.getByRole('tab', {name:'Instructions',exact:true}).click();
        await control('custom_prompt').fill('LOCAL QUALITY SENTINEL');
        await panel.getByRole('button', {name:'Save quality prompt',exact:true}).click();
        await control('custom_prompt').fill('UNSAVED A DRAFT');
        assert.equal((await local()).customPrompt, 'LOCAL QUALITY SENTINEL');
        await page.evaluate(async () => {
            window.campaignA = {chatId:context.chatId,chatMetadata:context.chatMetadata,chat:context.chat};
            context.chatId = 'Independent campaign B'; context.chatMetadata={variables:{}}; context.chat=[];
            await emit('CHAT_CHANGED');
        });
        assert.equal(await control('settings_scope').inputValue(), 'global');
        assert.notEqual(await control('custom_prompt').inputValue(), 'UNSAVED A DRAFT');
        assert.equal(await control('game_system').inputValue(), 'dnd5e');
        assert.equal(await page.evaluate(() => registered.has('SetSceneBackground')), true);
        await page.evaluate(async () => { Object.assign(context,campaignA); await emit('CHAT_CHANGED'); });
        assert.equal(await control('settings_scope').inputValue(), 'chat');
        assert.equal(await control('custom_prompt').inputValue(), 'UNSAVED A DRAFT');
        assert.equal((await local()).customPrompt, 'LOCAL QUALITY SENTINEL');

        // Restore serialized host metadata before the real entry point initializes.
        // This page is an isolated fixture, never the user's server or chat.
        const saved = await page.evaluate(() => ({chatId:context.chatId,chatMetadata:context.chatMetadata,
            chat:context.chat,extensionSettings:context.extensionSettings}));
        await page.addInitScript(saved => {
            window.addEventListener('DOMContentLoaded', () => { Object.assign(window.context,saved); }, {once:true});
        },saved);
        await page.reload();
        await page.waitForSelector('#blackboard_open_dashboard');
        await page.locator('#blackboard_open_dashboard').click();
        assert.equal(await control('settings_scope').inputValue(), 'chat');
        assert.equal(await control('private_mode').inputValue(), 'light');
        assert.equal(await control('game_system').inputValue(), 'universal');
        assert.equal(await control('auto_scene_background').isChecked(), false);
        await panel.getByRole('tab', {name:'Instructions',exact:true}).click();
        assert.equal(await control('custom_prompt').inputValue(), 'LOCAL QUALITY SENTINEL', 'Reload retains saved instructions only.');
        await panel.getByRole('tab', {name:'Settings',exact:true}).click();
        await page.evaluate(async () => {
            window.campaignA={chatId:context.chatId,chatMetadata:context.chatMetadata,chat:context.chat};
            context.chatId += ' - Branch'; context.chatMetadata=structuredClone(context.chatMetadata); context.chat=structuredClone(context.chat);
            await emit('CHAT_CHANGED');
        });
        assert.equal(await control('settings_scope').inputValue(), 'chat');
        await panel.locator('[data-bb-tier="high"]').click();
        await page.evaluate(async () => { Object.assign(context,campaignA); await emit('CHAT_CHANGED'); });
        assert.equal((await local()).simulationFidelity, 'low', 'A branch owns its copied preferences.');
        await control('settings_scope').selectOption('global');
        await panel.locator('[data-bb-tier="mid"]').click();
        await control('settings_scope').selectOption('chat');
        assert.equal((await local()).simulationFidelity, 'low', 'Returning to local restores retained values.');
        const reset = panel.getByRole('button', {name:'Copy global defaults to this chat',exact:true});
        page.once('dialog', dialog => dialog.dismiss());
        await reset.click();
        assert.equal((await local()).simulationFidelity, 'low');
        page.once('dialog', dialog => dialog.accept());
        await reset.click();
        assert.equal((await local()).simulationFidelity, 'mid');
        assert.equal((await local()).gameSystem, 'dnd5e');
        await control('game_system').selectOption('universal');
        if (output) await page.screenshot({animations:'disabled',path:resolve(output,'chat-settings-desktop.png')});
        await page.setViewportSize({width:320,height:780});
        assert.ok(await panel.evaluate(p => [p,...p.querySelectorAll('.bb-dash-scroll, .bb-dash-scope')].every(e => e.scrollWidth <= e.clientWidth + 1)));
        if (output) await page.screenshot({animations:'disabled',path:resolve(output,'chat-settings-mobile-320.png')});
        await page.evaluate(async () => { context.chatId=null; context.chatMetadata={}; context.chat=[]; await emit('CHAT_CHANGED'); });
        assert.equal(await control('settings_scope').inputValue(), 'global');
        assert.equal(await control('settings_scope').locator('option[value="chat"]').evaluate(e => e.disabled), true,
            JSON.stringify(await page.evaluate(() => ({native:document.querySelector('#blackboard_settings_scope option[value="chat"]').disabled,
                mirror:document.querySelector('[data-bb-control="blackboard_settings_scope"] option[value="chat"]').disabled,
                status:document.querySelector('#blackboard_settings_scope_status').textContent, chatId:context.chatId}))));
        assert.equal(await reset.isDisabled(), true);
        assert.deepEqual(errors, []);
        console.log('Campaign settings browser checks passed: real controls, isolated drafts/tools, serialized metadata reload, branches, retained/reset defaults and mobile layout.');
    } finally { await browserContext.close(); }
}

async function checkPrivateReportExport(page) {
    await page.evaluate(async prefix => {
        const {createPrivateReportArchive} = await import(prefix+'private-report-store.js');
        const create=()=>createPrivateReportArchive({getContext:()=>context,getAccount:async()=> 'preview-user'});
        const newer=create(),older=create(),key=await newer.key(),started=Date.now();
        await Promise.all([
            newer.save(key,{status:'committed',attempt_started:started+1,reviewMode:'light',candidate:'Persistent browser report sentinel.',auditLog:[{private:'Saved detector finding'}]}),
            older.save(key,{status:'committed',attempt_started:started,reviewMode:'light',candidate:'Stale concurrent callback.',auditLog:[]}),
        ]);
        if((await create().load(key)).candidate!=='Persistent browser report sentinel.')throw new Error('Concurrent report save overwrote the newer attempt');
    },prefix);
    await page.reload();
    await page.waitForSelector('#blackboard_open_dashboard');
    await page.locator('#blackboard_open_dashboard').click();
    const panel=page.locator('#blackboard-dashboard');
    const pending=page.waitForEvent('download');
    await panel.getByRole('button',{name:'Export private turn',exact:true}).click();
    const download=await pending;
    assert.equal(download.suggestedFilename(),'blackboard-private-turn.json');
    const restored=JSON.parse(await readFile(await download.path(),'utf8'));
    assert.equal(restored.status,'committed');assert.equal(restored.reviewMode,'light');
    assert.equal(restored.auditLog[0].private,'Saved detector finding');
    await page.evaluate(async()=>{context.chatId='Empty unrelated campaign';context.chat=[];context.chatMetadata={variables:{}};await emit('CHAT_CHANGED');});
    await panel.getByRole('button',{name:'Export private turn',exact:true}).click();
    await page.waitForFunction(()=>notices.some(n=>/No private turn report/.test(n.text)));
    assert.equal(await page.evaluate(()=>JSON.stringify(context.chatMetadata).includes('auditLog')),false);
    console.log('Private report browser checks passed: real IndexedDB, page reload, UI download and empty-chat isolation.');
}
