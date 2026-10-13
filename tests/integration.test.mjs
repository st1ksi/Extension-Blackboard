import { pass, report } from './review-fixtures.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as state from '../state.js';
import { browserEnvironment } from './browser-fixtures.mjs';

// Loads the real extension entry point. Only SillyTavern/DOM services are doubles.
async function host(initialSettings = {}, environment = browserEnvironment()) {
    const handlers = new Map(), tools = new Map(), prompts = new Map(), errors = [];
    const names = ['GENERATE_BEFORE_COMBINE_PROMPTS','MESSAGE_SENT','CHAT_CHANGED','MESSAGE_DELETED','MESSAGE_SWIPED','GENERATION_STARTED','MESSAGE_RECEIVED','TOOL_CALLS_PERFORMED'];
    const ctx = {
        chat: [], chatMetadata: { variables: {} },
        extensionSettings: { blackboard: { simulationFidelity: 'ultra', functionTool: true, autoInjectPrompt: true, historyRollback: true, ...initialSettings } },
        eventTypes: Object.fromEntries(names.map(n => [n, n])),
        eventSource: { on: (event, f) => { const list = handlers.get(event) || []; list.push(f); handlers.set(event, list); } },
        registerFunctionTool: t => tools.set(t.name, t), unregisterFunctionTool: name => tools.delete(name),
        setExtensionPrompt: (key, value) => prompts.set(key, value),
        saveChatDebounced() {}, saveMetadataDebounced() {}, saveSettingsDebounced() {},
    };
    ctx.variables = { local: { get: k => ctx.chatMetadata.variables?.[k], set: (k, v) => { ctx.chatMetadata.variables ??= {}; ctx.chatMetadata.variables[k] = v; } } };
    let initialize, privateRunner, privateOptions;
    const notices = [];
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
                if(key==='trigger')return event=>{for(const [name,handler] of events)if(name.split('.')[0]===event)handler.call(element);};
                return ()=>element;
            }});
            elements.set(selector,element);
        }
        return elements.get(selector);
    }
    const sandbox = vm.createContext({ ...environment, SillyTavern: { getContext: () => ctx },
        jQuery: f => { initialize = f; }, $, document: { getElementById: () => null },
        console: { log() {}, debug() {}, warn() {}, error: (...args) => errors.push(args) },
        toastr: { info() {}, success() {}, warning: message => notices.push(message), error() {}, clear() {} }, structuredClone, setTimeout, clearTimeout,
    });
    const stubClass = { fromProps: props => props };
    const stubs = {
        registerBlackboardPrivateRunner: (callback, options) => { privateRunner = callback; privateOptions = options; },
        renderExtensionTemplateAsync: async () => '<div></div>', POPUP_TYPE: {}, POPUP_RESULT: {}, Popup: class {},
        SlashCommand: stubClass, ARGUMENT_TYPE: { STRING: 'string' }, SlashCommandArgument: stubClass,
        SlashCommandNamedArgument: stubClass, commonEnumProviders: {}, SlashCommandParser: { commands: {}, addCommandObject() {} },
    };
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const entry = new vm.SourceTextModule(source, { context: sandbox });
    const cache = new Map();
    async function linker(specifier) {
        if (cache.has(specifier)) return cache.get(specifier);
        if (['./board-drafts.js', './board-source.js', './inspector.js', './panel-workspace.js', './dashboard.js', './capabilities.js', './private-runner.js', './transaction.js', './review.js', './issue-ledger.js', './tool-journal.js', './dice.js', './prompts/ultra.js', './game-profiles.js', './prompts/system-bundles.js', './turn-instructions.js', './background-instructions.js'].includes(specifier)) {
            const mod = new vm.SourceTextModule(await readFile(new URL('../' + specifier.slice(2), import.meta.url), 'utf8'), { context: sandbox });
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
    return { ctx, tools, prompts, notices, failPrivate: (...args) => privateOptions.onFailure(...args), ui: $, imageCommands: stubs.SlashCommandParser.commands, getReport: () => cache.get('./private-runner.js').namespace.getPrivateReport(), runPrivate: (...args) => privateRunner(...args), api: entry.namespace, emit: async (name, ...args) => { for (const f of handlers.get(name) || []) await f(...args); } };
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
