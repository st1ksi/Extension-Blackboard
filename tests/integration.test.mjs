import { pass, report } from './review-fixtures.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as state from '../state.js';
import { browserEnvironment } from './browser-fixtures.mjs';
import { reportDatabase } from './report-store-fixtures.mjs';

// Loads the real extension entry point. Only SillyTavern/DOM services are doubles.
async function host(initialSettings = {}, environment = browserEnvironment({indexedDB:reportDatabase()}), initialMetadata = null) {
    const handlers = new Map(), tools = new Map(), prompts = new Map(), errors = [];
    const names = ['GENERATE_BEFORE_COMBINE_PROMPTS','MESSAGE_SENT','CHAT_CHANGED','MESSAGE_DELETED','MESSAGE_SWIPED','GENERATION_STARTED','MESSAGE_RECEIVED','TOOL_CALLS_PERFORMED'];
    const ctx = {
        chat: [], chatId:'Test campaign', characterId:0, characters:[{avatar:'hero.png'}], chatMetadata: structuredClone(initialMetadata ?? { variables: {} }),
        extensionSettings: { blackboard: { simulationFidelity: 'ultra', functionTool: true, autoInjectPrompt: true, historyRollback: true, ...initialSettings } },
        eventTypes: Object.fromEntries(names.map(n => [n, n])),
        eventSource: { on: (event, f) => { const list = handlers.get(event) || []; list.push(f); handlers.set(event, list); } },
        registerFunctionTool: t => tools.set(t.name, t), unregisterFunctionTool: name => tools.delete(name),
        setExtensionPrompt: (key, value) => prompts.set(key, value),
        saveChatDebounced() {}, saveMetadataDebounced() {}, saveSettingsDebounced() {},
    };
    ctx.variables = { local: { get: k => ctx.chatMetadata.variables?.[k], set: (k, v) => { ctx.chatMetadata.variables ??= {}; ctx.chatMetadata.variables[k] = v; } } };
    let initialize, privateRunner, privateOptions;
    const notices = [], exported = [], blobs = new Map();
    const jq = new Proxy({}, { get: (_, key) => key === 'length' ? 1 : key === 'val' ? (...args) => args.length ? jq : '' : () => jq });
    const elements = new Map();
    function $(selector) {
        if (selector && typeof selector === 'object' && selector.uiElement) return selector;
        if (typeof selector !== 'string' || !selector.startsWith('#')) return jq;
        if (!elements.has(selector)) {
            let value, text;
            const properties = new Map();
            const events = new Map();
            const element = new Proxy({}, { get: (_,key) => {
                if(key==='uiElement')return true;
                if(key==='length')return 1;
                if(key==='val')return (...args)=>args.length ? (value=args[0],element) : value;
                if(key==='text')return (...args)=>args.length ? (text=args[0],element) : text;
                if(key==='css')return (name,...args)=>args.length ? (properties.set('css:'+name,args[0]),element) : properties.get('css:'+name);
                if(key==='prop')return (name,...args)=>args.length ? (properties.set(name,args[0]),element) : properties.get(name);
                if(key==='on')return (event,handler)=>{events.set(event,handler);return element;};
                if(key==='trigger')return event=>{for(const [name,handler] of events)if(name.split(/\s+/).some(token=>token.split('.')[0]===event))handler.call(element);};
                return ()=>element;
            }});
            elements.set(selector,element);
        }
        return elements.get(selector);
    }
    const sandbox = vm.createContext({ ...environment, SillyTavern: { getContext: () => ctx },
        jQuery: f => { initialize = f; }, $, document: { getElementById: () => null,
            createElement: () => ({click() { exported.push(blobs.get(this.href)); }}),
        }, Blob, URL:{createObjectURL:blob=>{const key='blob:test-'+blobs.size;blobs.set(key,blob);return key;},revokeObjectURL:key=>blobs.delete(key)},
        console: { log() {}, debug() {}, warn() {}, error: (...args) => errors.push(args) },
        toastr: { info:message=>notices.push(message), success() {}, warning: message => notices.push(message), error:message=>notices.push(message), clear() {} }, structuredClone, setTimeout, clearTimeout, confirm: () => true,
    });
    const stubClass = { fromProps: props => props };
    const stubs = {
        registerBlackboardPrivateRunner: (callback, options) => { privateRunner = callback; privateOptions = options; },
        renderExtensionTemplateAsync: async () => '<div></div>', POPUP_TYPE: {}, POPUP_RESULT: {}, Popup: class {},
        SlashCommand: stubClass, ARGUMENT_TYPE: { STRING: 'string' }, SlashCommandArgument: stubClass,
        SlashCommandNamedArgument: stubClass, commonEnumProviders: {}, SlashCommandParser: { commands: {}, addCommandObject() {} },
        getCurrentUserHandle: () => ctx.account ?? 'tester',
    };
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const dynamicImport = async specifier => {
        const mod = await linker(specifier);
        if (mod.status === 'unlinked') await mod.link(linker);
        if (mod.status === 'linked') await mod.evaluate();
        return mod;
    };
    const entry = new vm.SourceTextModule(source, { context: sandbox, importModuleDynamically: dynamicImport });
    const cache = new Map();
    async function linker(specifier) {
        if (cache.has(specifier)) return cache.get(specifier);
        if (['./campaign-settings.js', './board-drafts.js', './board-source.js', './inspector.js', './panel-workspace.js', './dashboard.js', './capabilities.js', './private-modes.js', './private-runner.js', './private-report-store.js', './transaction.js', './review.js', './issue-ledger.js', './tool-journal.js', './dice.js', './prompts/ultra.js', './game-profiles.js', './prompts/system-bundles.js', './turn-instructions.js', './background-instructions.js'].includes(specifier)) {
            const mod = new vm.SourceTextModule(await readFile(new URL('../' + specifier.slice(2), import.meta.url), 'utf8'), { context: sandbox, importModuleDynamically: dynamicImport });
            cache.set(specifier, mod); await mod.link(linker); return mod;
        }
        const obj = specifier === './state.js' ? state : stubs;
        const mod = new vm.SyntheticModule(Object.keys(obj), function () { for (const [k, v] of Object.entries(obj)) this.setExport(k, v); }, { context: sandbox });
        cache.set(specifier, mod); return mod;
    }
    await entry.link(linker);
    await entry.evaluate();
    await initialize();
    assert.deepEqual(errors, [], 'The real entry point must initialize without swallowed errors.');
    return { ctx, tools, prompts, notices, exported,
        clearReport:()=>cache.get('./private-runner.js').namespace.clearPrivateReport(),
        exportReport:()=>cache.get('./private-runner.js').namespace.downloadPrivateReport(),
        failPrivate: (...args) => privateOptions.onFailure(...args), ui: $, imageCommands: stubs.SlashCommandParser.commands, getReport: () => cache.get('./private-runner.js').namespace.getPrivateReport(), runPrivate: (...args) => privateRunner(...args), api: entry.namespace, emit: async (name, ...args) => { for (const f of handlers.get(name) || []) await f(...args); } };
}

for (const privateReview of [false, true]) test(`background checkbox gates real prompt and tool independently of private mode (${privateReview})`, async () => {
    const h = await host({ privateReview, executionModeVersion:1, autoSceneBackground:false, customBackgroundPrompt:'CUSTOM_BACKGROUND_SENTINEL' });
    const settings = h.ctx.extensionSettings.blackboard;
    const quality = h.prompts.get('blackboard_system_prompt');
    assert.equal(h.tools.has('SetSceneBackground'),false);
    assert.equal(h.prompts.get('blackboard_bg_prompt'),'');
    assert.equal(h.api.getActiveBackgroundSystemPrompt(),'');
    assert.doesNotMatch(quality,/SetSceneBackground|DYNAMIC SCENE VISUALIZATION/);
    assert.match(h.ui('#blackboard_background_status').text(),/Disabled/);
    h.ui('#blackboard_auto_scene_background').prop('checked',true).trigger('change');
    const oldAction = h.tools.get('SetSceneBackground').action;
    assert.match(h.prompts.get('blackboard_bg_prompt'),/CUSTOM_BACKGROUND_SENTINEL/);
    assert.match(h.prompts.get('blackboard_bg_prompt'),privateReview ? /BACKGROUND EXECUTION — PRIVATE/ : /BACKGROUND EXECUTION — STANDARD/);
    assert.equal(h.prompts.get('blackboard_system_prompt'),quality);
    h.ui('#blackboard_auto_scene_background').prop('checked',false).trigger('change');
    assert.equal(settings.customBackgroundPrompt,'CUSTOM_BACKGROUND_SENTINEL');
    assert.equal(settings.privateReview,privateReview);
    assert.equal(h.tools.has('SetSceneBackground'),false);
    assert.equal(h.prompts.get('blackboard_bg_prompt'),'');
    h.imageCommands.imagine={callback:()=>assert.fail('A stale tool action cannot generate images while disabled')};
    const receipt=JSON.parse(await oldAction({prompt:'View'}));
    assert.equal(receipt.status,'notice');
    assert.match(receipt.message,/disabled/);
});

test('background mode instructions and UI track private mode and prompt injection', async () => {
    const h=await host({privateReview:false,executionModeVersion:1,autoSceneBackground:true});
    assert.match(h.prompts.get('blackboard_bg_prompt'),/BACKGROUND EXECUTION — STANDARD/);
    h.ui('#blackboard_private_review').prop('checked',true).trigger('change');
    assert.match(h.prompts.get('blackboard_bg_prompt'),/BACKGROUND EXECUTION — PRIVATE/);
    assert.match(h.ui('#blackboard_background_status').text(),/private turn/);
    h.ui('#blackboard_auto_inject_prompt').prop('checked',false).trigger('change');
    assert.equal(h.prompts.get('blackboard_bg_prompt'),'');
    assert.match(h.ui('#blackboard_background_status').text(),/Auto-injection is disabled/);
    h.ui('#blackboard_auto_inject_prompt').prop('checked',true).trigger('change');
    assert.match(h.prompts.get('blackboard_bg_prompt'),/BACKGROUND EXECUTION — PRIVATE/);
});

test('ordinary background execution confirms success, reports missing generator, and respects disable during generation', async () => {
    const h=await host({privateReview:false,executionModeVersion:1});
    assert.equal(JSON.parse(await h.api.executeSetSceneBackground('View')).status,'notice');
    h.imageCommands.imagine={callback:async args=>{assert.equal(args.quiet,'true');return '/user/images/mock.png';}};
    const good=JSON.parse(await h.api.executeSetSceneBackground('View'));
    assert.equal(good.status,'success'); assert.equal(h.ui('#bg1').css('background-image'),'url("/user/images/mock.png")');
    h.imageCommands.imagine.callback=async()=>{
        h.ui('#blackboard_auto_scene_background').prop('checked',false).trigger('change');
        return '/user/images/not-applied.png';
    };
    assert.equal(JSON.parse(await h.api.executeSetSceneBackground('View')).status,'notice');
    assert.equal(h.ui('#bg1').css('background-image'),'url("/user/images/mock.png")');
});

test('registered private runner excludes disabled tool and cannot execute an unsolicited call', async () => {
    const h=await host({autoSceneBackground:false}); h.api.setBlackboard(privateBoard); await user(h);
    let first=true;
    const result=await h.runPrivate({type:'normal',api:'openai',canTools:true,messages:[],
        invoke:()=>assert.fail('Background must never be executed'),request:async(messages,allowed)=>{
            const p=privatePayload(messages);assert.ok(!allowed.includes('SetSceneBackground'));
            if(p.phase==='review')return pass(p);
            if(first){first=false;return {calls:[{name:'SetSceneBackground',arguments:{prompt:'Unsolicited'}}]};}
            assert.equal(p.receipts[0].result.status,'error');return {text:'You wait.'};
        }});
    result.commit();h.ctx.chat.push({is_user:false,mes:'You wait.'});await result.afterSave();
    assert.equal(h.getReport().background.status,'disabled');
    assert.equal(h.getReport().backgroundRequests.length,0);
    assert.match(h.ctx.chat.at(-1).mes,/disabled in settings/);
});

test('queued private image is skipped if backgrounds are disabled before afterSave', async () => {
    const h=await host();h.api.setBlackboard(privateBoard);await user(h);let first=true;
    const result=await h.runPrivate({type:'normal',api:'openai',canTools:true,messages:[],
        invoke:()=>assert.fail('Deferred disabled request must not execute'),request:async messages=>{
            const p=privatePayload(messages);if(p.phase==='review')return pass(p);
            if(first){first=false;return {calls:[{name:'SetSceneBackground',arguments:{prompt:'View'}}]};}
            return {text:'You enter.'};
        }});
    assert.equal(h.getReport().background.status,'queued');
    result.commit();h.ctx.chat.push({is_user:false,mes:'You enter.'});
    h.ui('#blackboard_auto_scene_background').prop('checked',false).trigger('change');
    await result.afterSave();assert.equal(h.getReport().background.status,'disabled');
});

const sheet = '[ENTITIES #hero]\nHP 20/20; monk level 3.';

test('universal profile reaches live prompt, tool schema, monitor, updates and snapshots', async () => {
    const h = await host({gameSystem:'universal'});
    const prompt=h.prompts.get('blackboard_system_prompt');
    assert.match(prompt,/GAME SYSTEM PROFILE — UNIVERSAL/);
    assert.doesNotMatch(prompt,/5e-2014|base_xp|proficiency_bonus|six seconds/);
    const tool=h.tools.get('UpdateBlackboard');
    assert.doesNotMatch(tool.description,/totals are computed/);
    assert.doesNotMatch(tool.parameters.properties.content.description,/base_xp|computed by/);
    const original='[MISC #character_progression]\nApprentice mechanic; learned soldering.';
    h.api.setBlackboard(original); await user(h);
    const result=await update(h,'[MISC #character_progression]\nMechanic; learned circuit repair.');
    assert.equal(result.status,'success');
    assert.equal(h.ctx.chat[0].extra.blackboard_snapshot,original);
    assert.match(h.api.getBlackboard(),/circuit repair/);
    assert.doesNotMatch(h.api.getBlackboardMonitorStatus(),/eligible level|proficiency \+/);
});

test('game-system selector changes prompt and tools without resetting quality, custom text or board', async () => {
    const h=await host();
    h.api.setBlackboard('[SCENE #room]\nExisting canon.');
    const original=h.api.getBlackboard();
    const settings=h.ctx.extensionSettings.blackboard;
    const before={fidelity:settings.simulationFidelity,custom:settings.customPrompt};
    h.ui('#blackboard_game_system').val('universal').trigger('change');
    assert.equal(settings.gameSystem,'universal');
    assert.match(h.prompts.get('blackboard_system_prompt'),/GAME SYSTEM PROFILE — UNIVERSAL/);
    assert.doesNotMatch(h.tools.get('UpdateBlackboard').parameters.properties.content.description,/base_xp/);
    assert.equal(settings.simulationFidelity,before.fidelity);assert.equal(settings.customPrompt,before.custom);
    assert.equal(h.api.getBlackboard(),original);
    assert.doesNotMatch(h.ui('#blackboard_custom_prompt').val(),/5e-2014/);
    h.ui('#blackboard_game_system').val('dnd5e').trigger('change');
    assert.match(h.prompts.get('blackboard_system_prompt'),/5e-2014/);
    assert.match(h.tools.get('UpdateBlackboard').parameters.properties.content.description,/base_xp/);
    assert.equal(h.api.getBlackboard(),original);
});

test('universal progression survives the complete registered private runner and commit', async () => {
    const h=await host({gameSystem:'universal'});
    h.api.setBlackboard(privateBoard+'\n[MISC #character_progression]\nApprentice.');
    await user(h,'Complete training.');let step=0;
    const result=await h.runPrivate({type:'normal',api:'openai',canTools:true,messages:[],invoke:async()=>{},request:async messages=>{
        const p=privatePayload(messages);
        if(p.phase==='review')return pass(p);
        if(!step++)return {calls:[{name:'UpdateBlackboard',arguments:{base_revision:0,block_id:'MISC #character_progression',content:'Training completed; learned repair.'}}]};
        return {text:'Training is complete.'};
    }});
    result.commit();assert.match(h.api.getBlackboard(),/learned repair/);
    assert.equal(h.getReport().gameSystem,'universal');result.release();
});
const progression = (awards = []) => ({ version: 1, character_id: 'hero', ruleset: '5e-2014', mode: 'xp', base_xp: 900, baseline_reason: 'Existing level 3', level: 3, classes: [{ name: 'Monk', level: 3 }], awards, pending_choices: [] });
const ledger = p => `[MISC #character_progression]\n${JSON.stringify(p)}`;
const board = () => sheet + '\n' + ledger(progression()) + '\n[SCENE #study]\nClosed box.';
async function update(h, content) { return JSON.parse(await h.tools.get('UpdateBlackboard').action({ action: 'upsert', content })); }
async function user(h, mes = 'act') { h.ctx.chat.push({ is_user: true, mes }); await h.emit('MESSAGE_SENT', h.ctx.chat.length - 1); }
async function toolMessage(h) {
    const m = { is_system: true, extra: { tool_invocations: [{ name: 'UpdateBlackboard', parameters: 'SECRET', result: 'success' }] } };
    h.ctx.chat.push(m); await h.emit('TOOL_CALLS_PERFORMED'); return m;
}

test('entry point defaults to the separated v6 Ultra and tools', async () => {
    const h = await host();
    assert.match(h.prompts.get('blackboard_system_prompt'), /### 21\. CHARACTER PROGRESSION/);
    assert.match(h.prompts.get('blackboard_system_prompt'), /COLD START:/);
    assert.ok(h.tools.has('UpdateBlackboard'));
    assert.ok(h.tools.has('SetSceneBackground'));
    assert.doesNotMatch(h.tools.get('UpdateBlackboard').parameters.properties.action.enum.join(','), /clear/);
    assert.equal(h.api.PROMPT_ULTRA, await readFile(new URL('../prompts/systems/compact-base.md', import.meta.url), 'utf8'));
    assert.equal(h.ui('#blackboard_custom_prompt').val(),h.api.PROMPT_ULTRA);
    assert.doesNotMatch(h.api.PROMPT_ULTRA,/D&D|VERSION PACKET|SetSceneBackground/);
});

test('selecting Ultra or resetting a saved v6 override gives the same v6 base and game profile',async()=>{
    const bundles=JSON.parse((await readFile(new URL('../prompts/system-bundles.js',import.meta.url),'utf8')).split('export const SYSTEM_BUNDLES = ')[1].trim().replace(/;$/,''));
    const h=await host({customPrompt:bundles.compact.legacy});
    const before=h.prompts.get('blackboard_system_prompt');
    h.ui('#blackboard_reset_prompt').trigger('click');
    assert.equal(h.ctx.extensionSettings.blackboard.customPrompt,'');
    assert.equal(h.prompts.get('blackboard_system_prompt'),before);
    h.ui('#blackboard_fidelity_select').val('low').trigger('change');
    h.ui('#blackboard_fidelity_select').val('ultra').trigger('change');
    assert.equal(h.prompts.get('blackboard_system_prompt'),before);
    assert.equal(h.ui('#blackboard_game_profile_preview').val(),bundles.compact.dnd5e);
    h.ui('#blackboard_game_system').val('universal').trigger('change');
    assert.equal(h.ui('#blackboard_custom_prompt').val(),h.api.PROMPT_ULTRA);
    assert.equal(h.ui('#blackboard_game_profile_preview').val(),bundles.compact.universal);
});
test('short populated board is expansion, never another cold start', async () => {
    const h = await host(); h.api.setBlackboard('[SCENE #room]\nSmall.');
    const monitor = h.api.getBlackboardMonitorStatus();
    assert.match(monitor, /UNDER-BUDGET/);
    assert.doesNotMatch(monitor, /COLD START:/);
});
test('monitor uses the custom user corridor', async () => {
    const h = await host(); Object.assign(h.ctx.extensionSettings.blackboard, { simulationFidelity: 'custom', targetMinTokens: 4200, targetMaxTokens: 9000 });
    assert.match(h.api.getBlackboardMonitorStatus(), /4200–9000/);
});
test('registered tool atomically rejects an invalid XP batch and does not touch old state', async () => {
    const h = await host(); await update(h, board());
    const before = h.api.getBlackboard();
    const p = progression([{ id: 'dupe', delta: 100, reason: 'goal', at: 'Day 1' }, { id: 'dupe', delta: 100, reason: 'goal', at: 'Day 1' }]);
    const result = await update(h, '[SCENE #study]\nStolen box.\n' + ledger(p));
    assert.equal(result.status, 'error');
    assert.equal(result.state_changed, false);
    assert.equal(h.api.getBlackboard(), before);
});
test('pre-action user snapshot is not overwritten by later tool saves', async () => {
    const h = await host(); h.api.setBlackboard(board()); await user(h);
    const before = h.ctx.chat[0].extra.blackboard_snapshot;
    const p = progression([{ id: 'goal', delta: 100, reason: 'goal', at: 'Day 1' }]);
    await update(h, ledger(p)); await toolMessage(h);
    assert.equal(state.readProgression(h.ctx.chat[0].extra.blackboard_snapshot).xp, 900);
    assert.equal(h.ctx.chat[0].extra.blackboard_snapshot, before);
    assert.equal(state.readProgression(h.ctx.chat[1].extra.blackboard_snapshot).xp, 1000);
    assert.doesNotMatch(h.ctx.chat[1].mes, /SECRET/);
});
test('deleting a complete response with its tools restores world, XP and ages together', async () => {
    const h = await host(); h.api.setBlackboard(board()); await user(h);
    await update(h, ledger(progression([{ id: 'goal', delta: 100, reason: 'goal', at: 'Day 1' }])));
    await toolMessage(h);
    h.ctx.chat.push({ is_user: false, mes: 'done' }); await h.emit('MESSAGE_RECEIVED', 2);
    h.ctx.chat.splice(1); await h.emit('MESSAGE_DELETED');
    assert.equal(state.readProgression(h.api.getBlackboard()).xp, 900);
    assert.equal(h.ctx.chatMetadata.blackboard_engine.ages['misc #character_progression'].changedAt, 0);
});
test('regenerating only final prose retains surviving tool results; dry runs change nothing', async () => {
    const h = await host(); h.api.setBlackboard(board()); await user(h);
    await update(h, ledger(progression([{ id: 'goal', delta: 100, reason: 'goal', at: 'Day 1' }]))); await toolMessage(h);
    h.ctx.chat.push({ is_user: false, mes: 'done' }); await h.emit('MESSAGE_RECEIVED', 2);
    await h.emit('GENERATION_STARTED', 'regenerate', {}, true);
    assert.equal(state.readProgression(h.api.getBlackboard()).xp, 1000);
    await h.emit('GENERATION_STARTED', 'regenerate', {}, false);
    assert.equal(state.readProgression(h.api.getBlackboard()).xp, 1000);
    const repeat = await update(h, ledger(progression([{ id: 'goal', delta: 100, reason: 'goal', at: 'Day 1' }])));
    assert.equal(repeat.progression.xp, 1000);
});
test('STALE advances with user turns, unchanged upsert cannot clear it', async () => {
    const h = await host(); h.api.setBlackboard('[SCENE #wall]\nStone.');
    for (let i = 0; i < 3; i++) { await user(h); await update(h, '[SCENE #wall]\nStone.'); }
    assert.match(h.api.getBlackboardMonitorStatus(), /STALE: \[SCENE #wall\] — 3 user turns/);
    await update(h, '[SCENE #wall]\nCracked.');
    assert.doesNotMatch(h.api.getBlackboardMonitorStatus(), /STALE: \[SCENE #wall\]/);
});
test('chat switching never uses another chat engine or XP ledger', async () => {
    const h = await host(); h.api.setBlackboard(board()); await user(h);
    h.ctx.chatMetadata = { variables: { world_blackboard: '[SCENE #other]\nOther campaign.' } };
    h.ctx.chat = [{ is_user: false, mes: 'other opening' }];
    await h.emit('CHAT_CHANGED');
    assert.match(h.api.getBlackboard(), /Other campaign/);
    assert.equal(state.readProgression(h.api.getBlackboard()), null);
    assert.equal(h.ctx.chatMetadata.blackboard_engine.turn, 0);
});
test('equal board text restores different age metadata when switching swipes', async () => {
    const h = await host(); h.api.setBlackboard('[SCENE #wall]\nStone.');
    for (let i = 0; i < 4; i++) await user(h);
    const text = h.api.getBlackboard();
    const m = { is_user: false, swipe_id: 0, swipes: ['A', 'B'], swipe_info: [{}, {}] };
    const age = changedAt => ({ version: 1, turn: 4, baseline: '', ages: { 'scene #wall': { content: 'Stone.', changedAt } } });
    state.writeSnapshot(m, text, age(1)); m.swipe_id = 1; state.writeSnapshot(m, text, age(4));
    h.ctx.chat.push(m); m.swipe_id = 0; await h.emit('MESSAGE_SWIPED', 4);
    assert.match(h.api.getBlackboardMonitorStatus(), /STALE: \[SCENE #wall\] — 3/);
    m.swipe_id = 1; await h.emit('MESSAGE_SWIPED', 4);
    assert.doesNotMatch(h.api.getBlackboardMonitorStatus(), /STALE: \[SCENE #wall\]/);
});

const privateBoard = '[MISC #world_clock]\n- Time: Day 1, 02:15:00\n[MISC #simulation_processes]\n' + JSON.stringify({version:1,through:'Day 1, 02:15:00',processes:[]}) + '\n[ENTITIES #hero]\nHP 20/20; owns note.';
const privatePayload = messages => JSON.parse(messages.at(-1).content.split('\n').slice(1).join('\n'));

for (const tier of ['low','mid','high','ultra','custom']) {
    test(`private checkbox alone controls generation at ${tier} fidelity`, async()=>{
        const h=await host({simulationFidelity:tier,privateReview:true,executionModeVersion:1});
        h.api.setBlackboard(privateBoard);await user(h);
        let reviews=0;
        const result=await h.runPrivate({type:'normal',api:'openai',canTools:true,messages:[],invoke:async()=>{},request:async messages=>{
            const p=privatePayload(messages);
            if(p.phase==='review'){reviews++;return pass(p);}
            return {text:'The room is unchanged.'};
        }});
        assert.equal(reviews,4);result.release();
        const settings=h.ctx.extensionSettings.blackboard;
        const quality=h.ui('#blackboard_custom_prompt').val();
        const snapshot=h.api.getBlackboard();
        h.ui('#blackboard_private_review').prop('checked',false).trigger('change');
        assert.equal(settings.privateReview,false);
        assert.equal(h.ui('#blackboard_private_format').prop('disabled'),true);
        assert.equal(h.ui('#blackboard_custom_prompt').val(),quality);
        assert.equal(h.api.getBlackboard(),snapshot);
        assert.match(h.prompts.get('blackboard_system_prompt'),/EXECUTION MODE — STANDARD/);
        assert.doesNotMatch(h.prompts.get('blackboard_system_prompt'),/EXECUTION MODE — PRIVATE TURNS/);
        assert.equal(await h.runPrivate({type:'normal',api:'kobold',canTools:false,request:()=>assert.fail('No private requests when disabled')}),null);
        h.ui('#blackboard_private_review').prop('checked',true).trigger('change');
        assert.equal(settings.privateReview,true);
        assert.match(h.prompts.get('blackboard_system_prompt'),/EXECUTION MODE — PRIVATE TURNS/);
        assert.equal(h.ui('#blackboard_private_format').prop('disabled'),false);
    });
}

test('legacy Mid starts in standard mode and changing fidelity does not enable private turns',async()=>{
    const h=await host({simulationFidelity:'mid',privateReview:true});
    assert.equal(h.ctx.extensionSettings.blackboard.privateReview,false);
    h.ui('#blackboard_fidelity_select').val('ultra').trigger('change');
    assert.equal(h.ctx.extensionSettings.blackboard.privateReview,false);
    assert.match(h.prompts.get('blackboard_system_prompt'),/EXECUTION MODE — STANDARD/);
});

test('Ultra corridor is 6000–21000 in preset, UI and monitor, including old saved token values',async()=>{
    const h=await host({targetMinTokens:3500,targetMaxTokens:21000});
    for (const [id, preset] of Object.entries(h.api.FIDELITY_PRESETS)) {
        assert.equal(h.ui(`#blackboard_fidelity_select option[value="${id}"]`).text(), id === 'custom'
            ? preset.name : `${preset.name} — ${preset.minTokens.toLocaleString()}–${preset.maxTokens.toLocaleString()} tokens`);
    }
    assert.equal(h.api.FIDELITY_PRESETS.ultra.minTokens,6000);
    assert.equal(h.api.FIDELITY_PRESETS.ultra.maxTokens,21000);
    assert.equal(h.ui('#blackboard_min_tokens').val(),6000);
    assert.equal(h.ui('#blackboard_max_tokens').val(),21000);
    assert.match(h.api.getBlackboardMonitorStatus(),/Required Corridor: 6000–21000/);
    assert.match(h.prompts.get('blackboard_system_prompt'),/Maintain 6,000–21,000 tokens/);
    const header='[SCENE #hall]\n';
    for(const [tokens,expected] of [[5999,'UNDER-BUDGET'],[6000,'WITHIN SIZE CORRIDOR'],[21000,'WITHIN SIZE CORRIDOR'],[21001,'ABOVE CEILING']]) {
        // Fixed-length synthetic state tests boundary arithmetic, not semantic fullness.
        h.api.setBlackboard(header+'x'.repeat(tokens*4-header.length));
        assert.ok(h.api.getBlackboardMonitorStatus().includes(expected));
    }
    assert.deepEqual(['low','mid','high'].map(t=>[h.api.FIDELITY_PRESETS[t].minTokens,h.api.FIDELITY_PRESETS[t].maxTokens]),
        [[1000,2000],[2000,4000],[4000,8000]]);
});

for (const [tier, min, max] of [['low',1000,2000],['mid',2000,4000],['high',4000,8000]]) {
    test(`${tier}: updated source and corridor reach initialization, selector, reset and monitor`, async()=>{
        const h=await host({simulationFidelity:tier,targetMinTokens:300,targetMaxTokens:600});
        const source=await readFile(new URL(`../prompts/systems/${tier}-base.md`,import.meta.url),'utf8');
        const assertPreset=()=>{
            assert.equal(h.ui('#blackboard_custom_prompt').val(),source);
            const monitoredSource=source.trim().replace('{{getvar::world_blackboard}}','{{getvar::world_blackboard}}'+h.api.getBlackboardMonitorStatus());
            assert.ok(h.prompts.get('blackboard_system_prompt').startsWith(monitoredSource));
            assert.equal(h.ui('#blackboard_min_tokens').val(),min);
            assert.equal(h.ui('#blackboard_max_tokens').val(),max);
            assert.ok(h.api.getBlackboardMonitorStatus().includes(`Required Corridor: ${min}–${max}`));
        };
        assertPreset();
        h.ui('#blackboard_fidelity_select').val('ultra').trigger('change');
        h.ui('#blackboard_fidelity_select').val(tier).trigger('change');
        assertPreset();
        h.ui('#blackboard_custom_prompt').val('My override');
        h.ui('#blackboard_save_prompt').trigger('click');
        assert.equal(h.ctx.extensionSettings.blackboard.customPrompt,'My override');
        h.ui('#blackboard_reset_prompt').trigger('click');
        assert.equal(h.ctx.extensionSettings.blackboard.customPrompt,'');
        assertPreset();
        const header='[SCENE #hall]\n';
        for(const [tokens,expected] of [[min-1,'UNDER-BUDGET'],[min,'WITHIN SIZE CORRIDOR'],[max,'WITHIN SIZE CORRIDOR'],[max+1,'ABOVE CEILING']]) {
            h.api.setBlackboard(header+'x'.repeat(tokens*4-header.length));
            assert.ok(h.api.getBlackboardMonitorStatus().includes(expected));
        }
    });
}

test('downgrading a populated Ultra campaign preserves canon, processes, XP, snapshots and independent options', async()=>{
    const h=await host({privateReview:true,executionModeVersion:1,autoSceneBackground:false});
    const processes={version:1,through:'Day 1, 02:15:00',processes:[{id:'watch_route',owner:'ENTITIES #watch',status:'active',accounted_through:'Day 1, 02:15:00',next_at:'Day 1, 02:20:00',note:'Travelling to the gate.'}]};
    const original=state.validateBoard(board()+'\n[MISC #world_clock]\nTime: Day 1, 02:15:00\n[MISC #simulation_processes]\n'+JSON.stringify(processes)+'\n[ENTITIES #watch]\nTravelling; owns a key.\n[LORE #canon_log]\n'+ 'Established consequences. '.repeat(500)).text;
    h.api.setBlackboard(original);await user(h);
    const saved=JSON.stringify(h.ctx.chat[0].extra);
    const ages=JSON.stringify(h.ctx.chatMetadata.blackboard_engine);
    for(const tier of ['low','mid','high','ultra']) {
        h.ui('#blackboard_fidelity_select').val(tier).trigger('change');
        assert.equal(h.api.getBlackboard(),original);
        assert.equal(JSON.stringify(h.ctx.chat[0].extra),saved);
        assert.equal(JSON.stringify(h.ctx.chatMetadata.blackboard_engine),ages);
        assert.equal(h.ctx.extensionSettings.blackboard.privateReview,true);
        assert.equal(h.ctx.extensionSettings.blackboard.autoSceneBackground,false);
        assert.equal(h.ctx.extensionSettings.blackboard.gameSystem,'dnd5e');
        assert.equal(h.tools.has('SetSceneBackground'),false);
        assert.equal(state.readProgression(h.api.getBlackboard()).xp,900);
    }
});

test('ordinary successful update returns size of the complete resulting board, not only the edited block',async()=>{
    const h=await host({gameSystem:'universal',privateReview:false,executionModeVersion:1});
    h.api.setBlackboard('[SCENE #hall]\nLarge hall.\n[ENTITIES #guard]\nWaiting.');
    const result=await update(h,'[ENTITIES #guard]\nPatrolling the east door.');
    assert.equal(result.status,'success');
    assert.equal(result.board_size.characters,h.api.getBlackboard().length);
    assert.equal(result.board_size.estimated_tokens,Math.ceil(h.api.getBlackboard().length/4));
    assert.equal(result.board_size.estimate_method,'characters/4');
    assert.ok(result.board_size.characters>'[ENTITIES #guard]\nPatrolling the east door.'.length);
});
test('actual private controller leaves chat and canonical state untouched until reviewed commit', async () => {
    const h = await host(); h.api.setBlackboard(privateBoard); await user(h, 'Drop note.');
    const before = JSON.stringify(h.ctx.chat); const canonical = h.api.getBlackboard(); let step = 0;
    const result = await h.runPrivate({ type:'normal', api:'openai', canTools:true, messages:[],
        invoke: () => assert.fail('No native tool expected'),
        request: async messages => {
            const p = privatePayload(messages);
            assert.equal(h.api.getBlackboard(), canonical);
            assert.equal(JSON.stringify(h.ctx.chat), before);
            if (p.phase === 'review') return pass(p);
            if (!step++) return {calls:[{name:'UpdateBlackboard',arguments:JSON.stringify({base_revision:0,content:'[ENTITIES #hero]\nHP 20/20; note dropped.'})}]};
            return {text:'You drop the note.'};
        },
    });
    assert.equal(h.api.getBlackboard(), canonical);
    result.commit(); assert.match(h.api.getBlackboard(), /note dropped/);
    h.ctx.chat.push({is_user:false,mes:'You drop the note.'});
    await h.emit('MESSAGE_RECEIVED', h.ctx.chat.length-1);
    await result.afterSave();
    assert.equal(h.ctx.chat.length, 2);
    assert.equal(h.ctx.chat[1].extra.blackboard_review.reviews, 4);
    assert.equal(h.ctx.chat[1].extra.tool_invocations, undefined);
    assert.equal(h.ctx.chat[1].extra.blackboard_snapshot, h.api.getBlackboard());
    assert.doesNotMatch(h.ctx.chat[1].mes, /PRIVATE|revision|simulation_processes/);
    assert.equal(h.getReport().auditLog.length, 4);
    assert.equal(h.getReport().candidateVersions.length, 1);
    assert.equal(h.getReport().review.stages.length, 4);
    assert.deepEqual(Object.keys(h.getReport().stageFindings), ['time', 'continuity', 'reach', 'narration']);
    assert.equal(h.getReport().invalidationLog.length, 0);
    assert.doesNotMatch(JSON.stringify(h.ctx.chat), /auditLog|candidateVersions|issueLedger|stageFindings|invalidationLog|repair_before|Fixture comparison|"evidence"/);
});

test('issue history is exported privately and never enters published chat metadata',async()=>{
    const h=await host();h.api.setBlackboard(privateBoard);await user(h,'Wait.');let first=true;
    const r=await h.runPrivate({type:'normal',api:'openai',canTools:true,messages:[],invoke:()=>assert.fail('No tools'),request:async messages=>{
        const p=privatePayload(messages);
        if(p.phase!=='review')return {text:'You wait.'};
        if(first){first=false;return {text:JSON.stringify(report(p,'repair','PRIVATE_FINDING_SENTINEL'))};}
        return pass(p);
    }});
    assert.equal(h.getReport().issueLedger[0].status,'resolved');
    assert.match(JSON.stringify(h.getReport()),/PRIVATE_FINDING_SENTINEL/);
    r.commit();h.ctx.chat.push({is_user:false,mes:'You wait.'});await h.emit('MESSAGE_RECEIVED',h.ctx.chat.length-1);await r.afterSave();
    assert.doesNotMatch(JSON.stringify(h.ctx.chat),/PRIVATE_FINDING_SENTINEL|issueLedger|issue_resolutions/);
    assert.doesNotMatch(JSON.stringify(h.ctx.chatMetadata),/PRIVATE_FINDING_SENTINEL|issueLedger|issue_resolutions/);
});
test('private commit rejects a concurrent inspector edit', async () => {
    const h = await host(); h.api.setBlackboard(privateBoard); await user(h);
    const result = await h.runPrivate({type:'normal',api:'openai',canTools:true,messages:[],invoke:()=>{},request: async messages => {
        const p=privatePayload(messages);return p.phase==='review'?pass(p):{text:'Nothing changes.'};
    }});
    h.api.setBlackboard(privateBoard.replace('owns note','owns ring'));
    assert.throws(()=>result.commit(), /changed during/);
    result.release();
});
test('disabled review and quiet generations bypass private runner; unsupported backend fails closed', async () => {
    const h = await host();
    assert.equal(await h.runPrivate({type:'quiet'}), null);
    await assert.rejects(h.runPrivate({type:'normal',api:'kobold',canTools:false}), /Chat Completion/);
    h.ctx.extensionSettings.blackboard.privateReview=false;
    assert.equal(await h.runPrivate({type:'normal'}), null);
});

for (const outcome of ['success', 'error', 'notice', 'unknown', 'throw']) {
    test(`visible dice journal and background report: ${outcome}`, async () => {
        const h = await host(); h.api.setBlackboard(privateBoard); await user(h);
        let step = 0, backgroundCalls = 0;
        const r = await h.runPrivate({type:'normal',api:'openai',canTools:true,messages:[],
            invoke: async name => {
                if (name === 'RollTheDice') return 'Secret NPC rolls a 1d20+5. The result is: 17. Individual rolls: 12';
                backgroundCalls++;
                if (outcome === 'throw') throw new Error('generator failed');
                return outcome === 'unknown' ? 'unrecognized' : JSON.stringify({status:outcome,url:'/user/images/test.png'});
            },
            request: async messages => {
                const p=privatePayload(messages);
                if (p.phase === 'review') return pass(p);
                if (!step++) return {calls:[{name:'RollTheDice',arguments:{formula:'1d20+5',who:'Secret NPC'}},{name:'SetSceneBackground',arguments:{prompt:'Private scene prompt'}}]};
                return {text:'You enter.'};
            },
        });
        assert.equal(backgroundCalls,0);
        assert.equal(h.getReport().background.status,'queued');
        r.commit();
        const m={is_user:false,mes:'You enter.',swipe_id:0,swipes:['You enter.'],swipe_info:[{extra:{}}]};
        h.ctx.chat.push(m);await h.emit('MESSAGE_RECEIVED',1);
        await r.afterSave();await r.afterSave();
        assert.equal(backgroundCalls,1);
        assert.equal(h.getReport().background.status,outcome==='throw'?'error':outcome);
        assert.equal(h.getReport().backgroundRequests.length,1);
        assert.match(m.mes,/RollTheDice: 1d20\+5 — 17; dice: 12/);
        assert.match(m.mes,/SetSceneBackground/);
        assert.doesNotMatch(m.mes,/Secret NPC|Private scene prompt|world_clock/);
        assert.equal(m.extra.tool_invocations,undefined);
        assert.equal(m.swipes[0],m.mes);
        assert.equal(m.swipe_info[0].extra.blackboard_tools.background.status,h.getReport().background.status);
    });
}

test('unsupported browser refuses new opt-in but preserves an existing private setting until explicitly disabled', async () => {
    const env = browserEnvironment({isSecureContext:false,navigator:{},crypto:{}});
    const h = await host({privateReview:false,executionModeVersion:1},env);
    h.api.setBlackboard('[SCENE #room]\nExisting canon.');
    const before = h.api.getBlackboard();
    h.ui('#blackboard_private_review').prop('checked',true).trigger('change');
    assert.equal(h.ctx.extensionSettings.blackboard.privateReview,false);
    assert.equal(h.ui('#blackboard_private_review').prop('checked'),false);
    assert.match(h.ui('#blackboard_private_capabilities').text(),/HTTPS/);
    assert.equal(h.api.getBlackboard(),before);
    const enabled = await host({privateReview:true,executionModeVersion:1},env);
    assert.equal(enabled.ctx.extensionSettings.blackboard.privateReview,true);
    assert.equal(enabled.ui('#blackboard_private_review').prop('checked'),true);
    assert.match(enabled.ui('#blackboard_execution_status').text(),/blocked/);
    assert.equal(enabled.ui('#blackboard_private_format').prop('disabled'),true);
    enabled.ui('#blackboard_private_review').prop('checked',false).trigger('change');
    assert.equal(enabled.ctx.extensionSettings.blackboard.privateReview,false);
    assert.match(enabled.ui('#blackboard_execution_status').text(),/Standard/);
});

test('capability failure is shown directly and replaces stale failure diagnostics',async()=>{
    const h=await host();
    h.failPrivate(new Error('Earlier failure'));
    const message='Private Turns unavailable: missing Web Locks. Use HTTPS.';
    h.failPrivate(Object.assign(new Error(message),{code:'BLACKBOARD_PRIVATE_UNAVAILABLE'}));
    assert.equal(h.notices.at(-1),message);
    assert.equal(h.getReport().status,'blocked');
    assert.equal(h.getReport().reason,message);
});

for (const privateReview of [false,true]) test(`master switch disables simulation while backgrounds still execute (${privateReview})`,async()=>{
    const h=await host({privateReview,executionModeVersion:1,autoSceneBackground:true});
    h.api.setBlackboard('[SCENE #room]\nRetained canon.');
    const original=h.api.getBlackboard(), oldUpdate=h.tools.get('UpdateBlackboard').action;
    h.ui('#blackboard_function_tool').prop('checked',false).trigger('change');
    assert.equal(h.ctx.extensionSettings.blackboard.functionTool,false);
    assert.equal(h.ctx.extensionSettings.blackboard.privateReview,privateReview);
    assert.equal(h.prompts.get('blackboard_system_prompt'),'');
    assert.equal(h.tools.has('UpdateBlackboard'),false);
    assert.equal(h.tools.has('SetSceneBackground'),true);
    assert.match(h.prompts.get('blackboard_bg_prompt'),/BACKGROUND EXECUTION — STANDARD/);
    assert.match(h.prompts.get('blackboard_bg_prompt'),/do not call or wait for UpdateBlackboard/);
    assert.equal(JSON.parse(await oldUpdate({action:'replace_all',content:'erased'})).status,'error');
    assert.equal(h.api.getBlackboard(),original);
    assert.equal(await h.runPrivate({}),null);
    h.imageCommands.imagine={callback:async()=>'/user/images/standalone.png'};
    assert.equal(JSON.parse(await h.tools.get('SetSceneBackground').action({prompt:'A rainy street.'})).status,'success');
    assert.equal(h.ui('#bg1').css('background-image'),'url("/user/images/standalone.png")');
    h.ui('#blackboard_function_tool').prop('checked',true).trigger('change');
    assert.equal(h.tools.has('UpdateBlackboard'),true);
    assert.match(h.prompts.get('blackboard_system_prompt'),/UpdateBlackboard/);
    assert.match(h.prompts.get('blackboard_bg_prompt'),privateReview?/BACKGROUND EXECUTION — PRIVATE/:/BACKGROUND EXECUTION — STANDARD/);
    assert.equal(h.api.getBlackboard(),original);
});

for (const savedMode of [undefined, 'unknown', 'light', 'heavy']) test(`private review mode normalizes existing settings (${savedMode})`, async () => {
    const h = await host({ privateReview:true, executionModeVersion:1, privateReviewMode:savedMode });
    const expected = savedMode === 'light' ? 'light' : 'heavy';
    assert.equal(h.ctx.extensionSettings.blackboard.privateReviewMode, expected);
    assert.equal(h.ui('#blackboard_private_mode').val(), expected);
    assert.equal(h.ui('#blackboard_private_mode').prop('disabled'), false);
});

test('review mode selector preserves light preference across standard/master off and regenerates mode instructions', async () => {
    const h = await host({ privateReview:true, executionModeVersion:1 });
    h.api.setBlackboard('[SCENE #room]\nRetained canon.');
    const board = h.api.getBlackboard();
    h.ui('#blackboard_private_mode').val('light').trigger('change');
    assert.equal(h.ctx.extensionSettings.blackboard.privateReviewMode, 'light');
    assert.match(h.ui('#blackboard_private_mode_desc').text(), /one|single/i);
    assert.match(h.prompts.get('blackboard_system_prompt'), /light|one combined/i);
    h.ui('#blackboard_private_review').prop('checked',false).trigger('change');
    assert.equal(h.ui('#blackboard_private_mode').prop('disabled'), true);
    assert.equal(h.ctx.extensionSettings.blackboard.privateReviewMode, 'light');
    assert.match(h.prompts.get('blackboard_system_prompt'), /EXECUTION MODE — STANDARD/);
    h.ui('#blackboard_private_review').prop('checked',true).trigger('change');
    assert.equal(h.ui('#blackboard_private_mode').prop('disabled'), false);
    assert.equal(h.ui('#blackboard_private_mode').val(), 'light');
    h.ui('#blackboard_function_tool').prop('checked',false).trigger('change');
    assert.equal(h.ui('#blackboard_private_mode').prop('disabled'), true);
    assert.equal(h.ctx.extensionSettings.blackboard.privateReviewMode, 'light');
    assert.equal(h.api.getBlackboard(), board);
});

test('review mode selector is disabled for unsupported browsers without erasing a saved light preference', async () => {
    const h = await host({ privateReview:true, privateReviewMode:'light', executionModeVersion:1 },
        browserEnvironment({isSecureContext:false,navigator:{},crypto:{}}));
    assert.equal(h.ui('#blackboard_private_mode').prop('disabled'), true);
    assert.equal(h.ui('#blackboard_private_mode').val(), 'light');
    assert.equal(h.ctx.extensionSettings.blackboard.privateReviewMode, 'light');
});

test('selected light mode reaches registered runner and commits one final snapshot with its correction report', async () => {
    const h = await host({ privateReview:true, privateReviewMode:'light', executionModeVersion:1, autoSceneBackground:false });
    h.api.setBlackboard(privateBoard); await user(h, 'Wait.');
    const sequence = [];
    const result = await h.runPrivate({type:'normal',api:'openai',canTools:true,messages:[],
        invoke:()=>assert.fail('No random or external effects in review/correction'),request:async messages=>{
            const p = privatePayload(messages); sequence.push(p.phase);
            if(p.phase==='simulate')return {text:'Original.'};
            if(p.phase==='review'){assert.equal(p.audit.stage,'light');return pass(p);}
            return {text:JSON.stringify({revision:p.head_revision,candidate_id:p.candidate_id,candidate:'You wait.',issue_resolutions:[]})};
        }});
    assert.deepEqual(sequence, ['simulate','review','repair']);
    result.commit(); h.ctx.chat.push({is_user:false,mes:'You wait.'});
    await h.emit('MESSAGE_RECEIVED',h.ctx.chat.length-1); await result.afterSave();
    assert.equal(h.getReport().reviewMode ?? h.getReport().stats?.reviewMode, 'light');
    assert.equal(h.getReport().reviews, 1);
    assert.equal(h.getReport().repairs, 1);
    assert.equal(h.ctx.chat.at(-1).extra.blackboard_snapshot, h.api.getBlackboard());
    assert.ok(!JSON.stringify(h.ctx.chat.at(-1).extra).includes('issue_resolutions'), 'Audit diagnostics remain private');
});

async function completeReportTurn(h, text = 'You wait.', invoke = () => assert.fail('No external tool expected')) {
    h.api.setBlackboard(privateBoard); await user(h, 'Wait.');
    const result = await h.runPrivate({type:'normal',api:'openai',canTools:true,messages:[],invoke,request:async messages=>{
        const p = privatePayload(messages);
        if (p.phase === 'review') return pass(p);
        if (p.phase === 'repair') return {text:JSON.stringify({revision:p.head_revision,candidate_id:p.candidate_id,candidate:text,issue_resolutions:[]})};
        return {text};
    }});
    result.commit(); h.ctx.chat.push({is_user:false,mes:text});
    await h.emit('MESSAGE_RECEIVED',h.ctx.chat.length-1); await result.afterSave(); result.release();
}

test('completed Light report survives CHAT_CHANGED clearing memory and exports without entering chat storage', async () => {
    const h = await host({privateReview:true,privateReviewMode:'light',executionModeVersion:1,autoSceneBackground:false});
    await completeReportTurn(h);
    assert.equal(h.getReport().status,'committed');
    await h.emit('CHAT_CHANGED');
    assert.equal(h.getReport(),null,'Chat changes discard only the tab cache, not the persistent archive.');
    await h.exportReport();
    assert.equal(h.exported.length,1);
    const exported = JSON.parse(await h.exported[0].text());
    assert.equal(exported.status,'committed');
    assert.equal(exported.reviewMode,'light');
    assert.equal(exported.reviews,1); assert.equal(exported.repairs,1);
    assert.ok(exported.auditLog.length);
    assert.doesNotMatch(JSON.stringify(h.ctx.chatMetadata),/auditLog|candidateVersions|issueLedger|stageFindings/);
    assert.doesNotMatch(JSON.stringify(h.ctx.chat),/auditLog|candidateVersions|issueLedger|stageFindings/);
});

test('completed report can be exported after a full extension reload using the same browser database', async () => {
    const database = reportDatabase();
    const environment = () => browserEnvironment({indexedDB:database});
    const first = await host({autoSceneBackground:false},environment());
    await completeReportTurn(first,'Reload persistence sentinel.');
    const reloaded = await host({},environment());
    assert.equal(reloaded.getReport(),null);
    await reloaded.exportReport();
    assert.equal(reloaded.exported.length,1);
    assert.equal(JSON.parse(await reloaded.exported[0].text()).candidate,'Reload persistence sentinel.');
});

test('report export is isolated by account, character and chat, including chats with no private history', async () => {
    const h = await host({autoSceneBackground:false});
    await completeReportTurn(h,'Scoped private report sentinel.');
    const original = {chatId:h.ctx.chatId,avatar:h.ctx.characters[0].avatar,account:h.ctx.account,chat:h.ctx.chat,metadata:h.ctx.chatMetadata};
    for (const change of [
        () => { h.ctx.chatId='Unrelated campaign'; },
        () => { h.ctx.characters[0].avatar='different-character.png'; },
        () => { h.ctx.account='other-account'; },
    ]) {
        Object.assign(h.ctx,{chatId:original.chatId,account:original.account});
        h.ctx.characters[0].avatar=original.avatar;
        h.ctx.chat=[];h.ctx.chatMetadata={variables:{}};
        change(); await h.emit('CHAT_CHANGED'); await h.exportReport();
        assert.equal(h.exported.length,0,'A report from another scope must never be downloaded.');
    }
    Object.assign(h.ctx,{chatId:original.chatId,account:original.account,chat:original.chat,chatMetadata:original.metadata});
    h.ctx.characters[0].avatar=original.avatar;
    await h.emit('CHAT_CHANGED'); await h.exportReport();
    assert.equal(h.exported.length,1);
    assert.equal(JSON.parse(await h.exported[0].text()).candidate,'Scoped private report sentinel.');
});

test('a chat with only public summary metadata does not fabricate a lost detailed report', async () => {
    const h = await host();
    h.ctx.chat.push({is_user:false,mes:'Historical answer.',extra:{blackboard_review:{reviewMode:'light',reviews:1,repairs:1}}});
    await h.exportReport();
    assert.equal(h.exported.length,1);
    const summary=JSON.parse(await h.exported[0].text());
    assert.equal(summary.report_kind,'saved_summary'); assert.equal(summary.details_available,false);
    assert.equal(summary.auditLog,undefined); assert.equal(summary.issueLedger,undefined);
    assert.match(h.notices.at(-1),/summary|detail|unavailable|not/i);
});

test('chat switching while loading an archived report cancels download instead of exporting the previous chat',async()=>{
    const database=reportDatabase(),h=await host({autoSceneBackground:false},browserEnvironment({indexedDB:database}));
    await completeReportTurn(h);h.clearReport();
    database.beforeGet=()=>{
        database.beforeGet=null;
        h.ctx.chatId='Chat switched while archive is loading';h.ctx.chat=[];h.ctx.chatMetadata={variables:{}};
    };
    await h.exportReport();
    assert.equal(h.exported.length,0);
    assert.match(h.notices.at(-1),/chat changed|intended chat/i);
});

test('site storage denial before publication retains complete audit in memory and never commits the draft',async()=>{
    const database=reportDatabase(),h=await host({autoSceneBackground:false},browserEnvironment({indexedDB:database}));
    h.api.setBlackboard(privateBoard);await user(h,'Wait.');
    const baseline=h.api.getBlackboard();
    await assert.rejects(h.runPrivate({type:'normal',api:'openai',canTools:true,messages:[],invoke:()=>assert.fail('No tools'),request:async messages=>{
        const p=privatePayload(messages);
        if(p.phase==='review'){
            if(p.audit.stage==='narration')database.error=new Error('Site storage denied during report retention');
            return pass(p);
        }
        return {text:'You wait.'};
    }}),/Site storage denied/);
    assert.equal(h.ctx.chat.length,1);assert.equal(h.api.getBlackboard(),baseline);
    assert.equal(h.getReport().status,'failed');assert.equal(h.getReport().auditLog.length,4);
    assert.equal(h.getReport().candidate,'You wait.');
    await h.exportReport();
    assert.equal(h.exported.length,1,'The surviving in-tab diagnostics remain exportable while browser storage is blocked.');
    assert.equal(JSON.parse(await h.exported[0].text()).auditLog.length,4);
});

test('an unscoped setup failure cannot relabel or overwrite the preceding completed private report',async()=>{
    const h=await host({autoSceneBackground:false});
    await completeReportTurn(h,'Previous committed report.');
    const original=JSON.stringify(h.getReport());
    h.failPrivate(new Error('A new request failed before acquiring a private turn scope'));
    assert.equal(h.getReport().status,'committed');
    assert.equal(JSON.stringify(h.getReport()),original);
    await h.exportReport();
    assert.equal(h.exported.length,1);
    assert.equal(await h.exported[0].text(),JSON.stringify(JSON.parse(original),null,2));
    h.clearReport();await h.exportReport();
    assert.equal(h.exported.length,2);
    assert.equal(await h.exported[1].text(),JSON.stringify(JSON.parse(original),null,2));
});

const campaignState = h => ({chatId:h.ctx.chatId,chat:h.ctx.chat,chatMetadata:h.ctx.chatMetadata});
async function switchCampaign(h, campaign) {
    Object.assign(h.ctx,campaign);
    await h.emit('CHAT_CHANGED');
}
function selectSettingsScope(h, scope) {
    h.ui('#blackboard_settings_scope').val(scope).trigger('change');
}

test('campaign opt-in copies preferences while leaving global settings, canon and rollback snapshots intact', async () => {
    const h = await host({privateReview:false,executionModeVersion:1});
    h.api.setBlackboard('[SCENE #room]\nExisting immutable canon.');
    await user(h,'Look.');
    const originalBoard = h.api.getBlackboard();
    const originalSnapshot = h.ctx.chat[0].extra.blackboard_snapshot;
    const globals = JSON.stringify(h.ctx.extensionSettings.blackboard);
    assert.equal(h.ctx.chatMetadata.blackboard_settings,undefined,'Reading defaults must not opt the chat into a local configuration.');
    selectSettingsScope(h,'chat');
    const record = h.ctx.chatMetadata.blackboard_settings;
    assert.equal(record.version,1); assert.equal(record.enabled,true);
    assert.notEqual(record.values,h.ctx.extensionSettings.blackboard);
    h.ui('#blackboard_fidelity_select').val('low').trigger('change');
    h.ui('#blackboard_game_system').val('universal').trigger('change');
    h.ui('#blackboard_private_mode').val('light').trigger('change');
    h.ui('#blackboard_auto_scene_background').prop('checked',false).trigger('change');
    assert.equal(record.values.simulationFidelity,'low');
    assert.equal(record.values.gameSystem,'universal');
    assert.equal(record.values.privateReviewMode,'light');
    assert.equal(record.values.autoSceneBackground,false);
    assert.equal(JSON.stringify(h.ctx.extensionSettings.blackboard),globals);
    assert.equal(h.api.getBlackboard(),originalBoard);
    assert.equal(h.ctx.chat[0].extra.blackboard_snapshot,originalSnapshot);
    assert.match(h.prompts.get('blackboard_system_prompt'),/GAME SYSTEM PROFILE — UNIVERSAL/);
    assert.doesNotMatch(h.tools.get('UpdateBlackboard').parameters.properties.content.description,/base_xp/);
    assert.equal(h.tools.has('SetSceneBackground'),false);
});

test('campaign switching refreshes native controls, schemas and prompts without carrying local settings into global defaults', async () => {
    const h = await host({privateReview:false,executionModeVersion:1,autoSceneBackground:true});
    selectSettingsScope(h,'chat');
    h.ui('#blackboard_fidelity_select').val('low').trigger('change');
    h.ui('#blackboard_game_system').val('universal').trigger('change');
    h.ui('#blackboard_auto_scene_background').prop('checked',false).trigger('change');
    const a = campaignState(h);
    const b = {chatId:'Campaign B',chat:[],chatMetadata:{variables:{}}};
    await switchCampaign(h,b);
    assert.equal(h.ui('#blackboard_settings_scope').val(),'global');
    assert.equal(h.ui('#blackboard_fidelity_select').val(),'ultra');
    assert.equal(h.ui('#blackboard_game_system').val(),'dnd5e');
    assert.equal(h.ui('#blackboard_auto_scene_background').prop('checked'),true);
    assert.match(h.prompts.get('blackboard_system_prompt'),/5e-2014/);
    assert.match(h.tools.get('UpdateBlackboard').parameters.properties.content.description,/base_xp/);
    assert.equal(h.tools.has('SetSceneBackground'),true);
    h.ui('#blackboard_fidelity_select').val('high').trigger('change');
    h.ui('#blackboard_private_mode').val('light').trigger('change');
    assert.equal(h.ctx.extensionSettings.blackboard.simulationFidelity,'high');
    assert.equal(a.chatMetadata.blackboard_settings.values.simulationFidelity,'low');
    await switchCampaign(h,a);
    assert.equal(h.ui('#blackboard_settings_scope').val(),'chat');
    assert.equal(h.ui('#blackboard_fidelity_select').val(),'low');
    assert.equal(h.ui('#blackboard_game_system').val(),'universal');
    assert.equal(h.ui('#blackboard_auto_scene_background').prop('checked'),false);
    assert.equal(h.ui('#blackboard_private_mode').val(),'heavy','A keeps its copied preference after B changes the global default.');
    assert.match(h.prompts.get('blackboard_system_prompt'),/GAME SYSTEM PROFILE — UNIVERSAL/);
    assert.equal(h.tools.has('SetSceneBackground'),false);
    await switchCampaign(h,b);
    assert.equal(h.ui('#blackboard_fidelity_select').val(),'high');
    assert.equal(h.ui('#blackboard_private_mode').val(),'light');
});

test('two local campaigns isolate every editor action, including custom budgets and prompt Save after a chat switch', async () => {
    const h = await host({privateReview:false,executionModeVersion:1});
    const globals = JSON.stringify(h.ctx.extensionSettings.blackboard);
    selectSettingsScope(h,'chat');
    h.ui('#blackboard_custom_prompt').val('Campaign A saved quality.');
    h.ui('#blackboard_save_prompt').trigger('click');
    h.ui('#blackboard_background_custom_prompt').val('Campaign A background.');
    h.ui('#blackboard_save_bg_prompt').trigger('click');
    h.ui('#blackboard_history_rollback').prop('checked',false).trigger('change');
    const a = campaignState(h);
    h.ui('#blackboard_custom_prompt').val('Campaign A unsaved quality draft.');
    h.ui('#blackboard_background_custom_prompt').val('Campaign A unsaved background draft.');
    await switchCampaign(h,{chatId:'Independent local B',chat:[],chatMetadata:{variables:{}}});
    selectSettingsScope(h,'chat');
    assert.doesNotMatch(h.ui('#blackboard_custom_prompt').val(),/Campaign A/);
    assert.doesNotMatch(h.ui('#blackboard_background_custom_prompt').val(),/Campaign A/);
    h.ui('#blackboard_fidelity_select').val('custom').trigger('change');
    h.ui('#blackboard_min_tokens').val(1350).trigger('change');
    h.ui('#blackboard_max_tokens').val(4850).trigger('change');
    h.ui('#blackboard_custom_prompt').val('Campaign B saved quality.');
    h.ui('#blackboard_save_prompt').trigger('click');
    h.ui('#blackboard_background_custom_prompt').val('Campaign B background.');
    h.ui('#blackboard_save_bg_prompt').trigger('click');
    h.ui('#blackboard_private_review').prop('checked',true).trigger('change');
    h.ui('#blackboard_private_mode').val('light').trigger('change');
    h.ui('#blackboard_private_format').val('full').trigger('change');
    const b = campaignState(h), localB = b.chatMetadata.blackboard_settings.values;
    assert.equal(localB.targetMinTokens,1350); assert.equal(localB.targetMaxTokens,4850);
    assert.equal(localB.privateReview,true); assert.equal(localB.privateReviewMode,'light');
    assert.equal(localB.privateReviewFormat,'full');
    assert.equal(localB.customPrompt,'Campaign B saved quality.');
    assert.equal(a.chatMetadata.blackboard_settings.values.customPrompt,'Campaign A saved quality.');
    assert.equal(a.chatMetadata.blackboard_settings.values.customBackgroundPrompt,'Campaign A background.');
    await switchCampaign(h,a);
    assert.equal(h.ui('#blackboard_custom_prompt').val(),'Campaign A unsaved quality draft.');
    assert.equal(h.ui('#blackboard_background_custom_prompt').val(),'Campaign A unsaved background draft.');
    assert.equal(a.chatMetadata.blackboard_settings.values.customPrompt,'Campaign A saved quality.','Restoring an editor draft must not save it.');
    assert.equal(a.chatMetadata.blackboard_settings.values.customBackgroundPrompt,'Campaign A background.');
    assert.equal(h.ui('#blackboard_history_rollback').prop('checked'),false);
    assert.equal(h.ui('#blackboard_private_review').prop('checked'),false);
    assert.equal(h.ui('#blackboard_private_format').val(),'diff');
    h.ui('#blackboard_save_prompt').trigger('click');
    h.ui('#blackboard_save_bg_prompt').trigger('click');
    assert.equal(a.chatMetadata.blackboard_settings.values.customPrompt,'Campaign A unsaved quality draft.');
    assert.equal(a.chatMetadata.blackboard_settings.values.customBackgroundPrompt,'Campaign A unsaved background draft.');
    assert.equal(localB.customPrompt,'Campaign B saved quality.','Save must never write through a handler captured for a previous chat.');
    assert.equal(localB.customBackgroundPrompt,'Campaign B background.');
    assert.equal(JSON.stringify(h.ctx.extensionSettings.blackboard),globals);
});

test('returning to global settings retains local preferences, and explicit reset copies the latest defaults only into this chat', async () => {
    const h = await host({privateReview:false,executionModeVersion:1,autoSceneBackground:true});
    selectSettingsScope(h,'chat');
    h.ui('#blackboard_game_system').val('universal').trigger('change');
    h.ui('#blackboard_auto_scene_background').prop('checked',false).trigger('change');
    const retained = h.ctx.chatMetadata.blackboard_settings.values;
    selectSettingsScope(h,'global');
    assert.equal(h.ctx.chatMetadata.blackboard_settings.enabled,false);
    assert.equal(retained.gameSystem,'universal');
    assert.equal(h.ui('#blackboard_game_system').val(),'dnd5e');
    h.ui('#blackboard_fidelity_select').val('high').trigger('change');
    const globals = JSON.stringify(h.ctx.extensionSettings.blackboard);
    selectSettingsScope(h,'chat');
    assert.equal(h.ui('#blackboard_game_system').val(),'universal');
    assert.equal(h.ui('#blackboard_auto_scene_background').prop('checked'),false);
    h.ui('#blackboard_reset_chat_settings').trigger('click');
    assert.equal(h.ctx.chatMetadata.blackboard_settings.enabled,true);
    assert.equal(h.ui('#blackboard_game_system').val(),'dnd5e');
    assert.equal(h.ui('#blackboard_fidelity_select').val(),'high');
    assert.equal(h.ui('#blackboard_auto_scene_background').prop('checked'),true);
    assert.equal(JSON.stringify(h.ctx.extensionSettings.blackboard),globals);
});

test('saved local settings survive extension reload and inherited branches become independent copies', async () => {
    const h = await host({privateReview:false,executionModeVersion:1});
    selectSettingsScope(h,'chat');
    h.ui('#blackboard_game_system').val('universal').trigger('change');
    h.ui('#blackboard_fidelity_select').val('low').trigger('change');
    h.ui('#blackboard_custom_prompt').val('Persistent local quality instructions.');
    h.ui('#blackboard_save_prompt').trigger('click');
    const saved = JSON.parse(JSON.stringify(h.ctx.chatMetadata));
    const reloaded = await host({privateReview:false,executionModeVersion:1},undefined,saved);
    assert.equal(reloaded.ui('#blackboard_settings_scope').val(),'chat');
    assert.equal(reloaded.ui('#blackboard_game_system').val(),'universal');
    assert.equal(reloaded.ui('#blackboard_fidelity_select').val(),'low');
    assert.equal(reloaded.ui('#blackboard_custom_prompt').val(),'Persistent local quality instructions.');
    assert.match(reloaded.prompts.get('blackboard_system_prompt'),/Persistent local quality instructions/);
    const original = campaignState(reloaded);
    const branch = {chatId:'Test campaign - Branch #1',chat:structuredClone(original.chat),chatMetadata:structuredClone(original.chatMetadata)};
    await switchCampaign(reloaded,branch);
    assert.equal(reloaded.ui('#blackboard_game_system').val(),'universal');
    reloaded.ui('#blackboard_game_system').val('dnd5e').trigger('change');
    reloaded.ui('#blackboard_custom_prompt').val('Branch-specific quality instructions.');
    reloaded.ui('#blackboard_save_prompt').trigger('click');
    await switchCampaign(reloaded,original);
    assert.equal(reloaded.ui('#blackboard_game_system').val(),'universal');
    assert.equal(reloaded.ui('#blackboard_custom_prompt').val(),'Persistent local quality instructions.');
    assert.equal(branch.chatMetadata.blackboard_settings.values.customPrompt,'Branch-specific quality instructions.');
});

test('campaign master switch and backgrounds remain independent across chat changes', async () => {
    const h = await host({privateReview:false,executionModeVersion:1,autoSceneBackground:false});
    selectSettingsScope(h,'chat');
    h.ui('#blackboard_function_tool').prop('checked',false).trigger('change');
    h.ui('#blackboard_auto_scene_background').prop('checked',true).trigger('change');
    const a = campaignState(h);
    assert.equal(h.tools.has('UpdateBlackboard'),false);
    assert.equal(h.tools.has('SetSceneBackground'),true);
    assert.equal(h.prompts.get('blackboard_system_prompt'),'');
    assert.match(h.prompts.get('blackboard_bg_prompt'),/BACKGROUND EXECUTION — STANDARD/);
    assert.equal(await h.runPrivate({type:'normal'}),null);
    await switchCampaign(h,{chatId:'Global simulation campaign',chat:[],chatMetadata:{variables:{}}});
    assert.equal(h.tools.has('UpdateBlackboard'),true);
    assert.equal(h.tools.has('SetSceneBackground'),false);
    assert.match(h.prompts.get('blackboard_system_prompt'),/UpdateBlackboard/);
    assert.equal(h.prompts.get('blackboard_bg_prompt'),'');
    await switchCampaign(h,a);
    assert.equal(h.ui('#blackboard_function_tool').prop('checked'),false);
    assert.equal(h.ui('#blackboard_auto_scene_background').prop('checked'),true);
    assert.equal(h.tools.has('UpdateBlackboard'),false);
    assert.equal(h.tools.has('SetSceneBackground'),true);
    assert.equal(h.ctx.extensionSettings.blackboard.functionTool,true);
    assert.equal(h.ctx.extensionSettings.blackboard.autoSceneBackground,false);
});

test('local light review and universal profile reach the registered private runner without changing global execution defaults', async () => {
    const h = await host({privateReview:false,executionModeVersion:1,autoSceneBackground:false});
    selectSettingsScope(h,'chat');
    h.ui('#blackboard_game_system').val('universal').trigger('change');
    h.ui('#blackboard_private_review').prop('checked',true).trigger('change');
    h.ui('#blackboard_private_mode').val('light').trigger('change');
    const globals = JSON.stringify(h.ctx.extensionSettings.blackboard);
    await completeReportTurn(h,'The locally configured turn is complete.');
    assert.equal(h.getReport().reviewMode,'light');
    assert.equal(h.getReport().gameSystem,'universal');
    assert.equal(h.getReport().reviews,1); assert.equal(h.getReport().repairs,1);
    assert.equal(JSON.stringify(h.ctx.extensionSettings.blackboard),globals);
    assert.equal(h.ctx.chatMetadata.blackboard_settings.values.privateReview,true);
    assert.equal(h.ctx.chat.at(-1).extra.blackboard_snapshot,h.api.getBlackboard());
    assert.equal(h.ctx.chat.at(-1).extra.blackboard_settings,undefined,'Only the final board is an answer snapshot; campaign preferences stay in chat metadata.');
});

test('settings writes are rejected during a chat-load gap and resume only after CHAT_CHANGED refreshes the displayed configuration', async () => {
    for(const initialScope of ['global','chat']){
        const h=await host({privateReview:false,executionModeVersion:1,autoSceneBackground:true});
        if(initialScope==='chat'){
            selectSettingsScope(h,'chat');
            h.ui('#blackboard_game_system').val('universal').trigger('change');
            h.ui('#blackboard_custom_prompt').val('Campaign A saved instructions.');
            h.ui('#blackboard_save_prompt').trigger('click');
        }
        const globals=h.ctx.extensionSettings.blackboard;
        const oldPreferences=initialScope==='chat'?h.ctx.chatMetadata.blackboard_settings.values:globals;
        const globalBefore=JSON.stringify(globals),oldBefore=JSON.stringify(oldPreferences);
        const newPreferences={...structuredClone(globals),customPrompt:'Campaign B saved instructions.',gameSystem:'dnd5e',privateReview:false};
        h.ctx.chatId='Campaign loading before its event';
        h.ctx.chat=[];
        h.ctx.chatMetadata={variables:{},blackboard_settings:{version:1,enabled:true,values:newPreferences}};
        const newBefore=JSON.stringify(newPreferences);
        // Stock SillyTavern replaces its context before emitting CHAT_CHANGED.
        // The still-visible settings panel must not write into either campaign.
        h.ui('#blackboard_function_tool').prop('checked',false).trigger('change');
        h.ui('#blackboard_auto_scene_background').prop('checked',false).trigger('change');
        selectSettingsScope(h,'global');
        h.ui('#blackboard_custom_prompt').val('Rejected stale quality Save.');
        h.ui('#blackboard_save_prompt').trigger('click');
        h.ui('#blackboard_background_custom_prompt').val('Rejected stale background Save.');
        h.ui('#blackboard_save_bg_prompt').trigger('click');
        assert.equal(JSON.stringify(globals),globalBefore,`${initialScope}: stale controls cannot change global defaults.`);
        assert.equal(JSON.stringify(oldPreferences),oldBefore,`${initialScope}: stale controls cannot change the departed chat.`);
        assert.equal(JSON.stringify(newPreferences),newBefore,`${initialScope}: a loading chat cannot receive writes from the previous view.`);
        assert.equal(h.ctx.chatMetadata.blackboard_settings.enabled,true,'The rejected scope selector must not disable the incoming override.');
        assert.match(h.notices.at(-1),/chat is changing|finish loading/i);
        await h.emit('CHAT_CHANGED');
        assert.equal(h.ui('#blackboard_settings_scope').val(),'chat');
        assert.equal(h.ui('#blackboard_custom_prompt').val(),'Campaign B saved instructions.');
        assert.equal(h.ui('#blackboard_function_tool').prop('checked'),true);
        assert.equal(h.ui('#blackboard_auto_scene_background').prop('checked'),true);
        h.ui('#blackboard_function_tool').prop('checked',false).trigger('change');
        h.ui('#blackboard_custom_prompt').val('Campaign B intentionally edited after loading.');
        h.ui('#blackboard_save_prompt').trigger('click');
        assert.equal(newPreferences.functionTool,false);
        assert.equal(newPreferences.customPrompt,'Campaign B intentionally edited after loading.');
        assert.equal(JSON.stringify(globals),globalBefore);
        assert.equal(JSON.stringify(oldPreferences),oldBefore);
    }
});
