import { SYSTEM_BUNDLES } from './prompts/system-bundles.js';
import { DEFAULT_BACKGROUND_SYSTEM_PROMPT, backgroundInstructions } from './background-instructions.js';
export { DEFAULT_BACKGROUND_SYSTEM_PROMPT };
import { installPrivateRunner, downloadPrivateReport, clearPrivateReport } from './private-runner.js';
import { GAME_SYSTEMS, gameSystem, composeGamePrompt, resolveQualityPrompt, GENERIC_PROGRESSION_TOOL } from './game-profiles.js';
import { executionInstructions, migrateExecutionSettings } from './turn-instructions.js';
import { privateTurnCapabilities } from './capabilities.js';
import { installSettingsDashboard } from './dashboard.js';
import { installBoardInspector } from './inspector.js';
import { createPanelWorkspace } from './panel-workspace.js';
import { PROMPT_ULTRA } from './prompts/ultra.js';
export { PROMPT_ULTRA };
import { parseBlocks, serializeBlocks, applyUpdate, validateBoard, readProgression, reconcileAges, staleBlocks, budget, findSnapshot, writeSnapshot, redactToolLog } from './state.js';
export { parseBlocks, serializeBlocks };
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { commonEnumProviders } from '../../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

export { MODULE_NAME };

const MODULE_NAME = 'blackboard';
const TEMPLATE_PATH = 'third-party/Extension-Blackboard';
const VARIABLE_NAME = 'world_blackboard';
const PROMPT_INJECTION_KEY = 'blackboard_system_prompt';
const BG_PROMPT_INJECTION_KEY = 'blackboard_bg_prompt';
let boardInspector, settingsDashboard, panelWorkspace;



/**
 * Prompt presets for the 4 Simulation Fidelity levels.
 */
export const PROMPT_LOW = SYSTEM_BUNDLES.low.base;
export const PROMPT_MID = SYSTEM_BUNDLES.mid.base;
export const PROMPT_HIGH = SYSTEM_BUNDLES.high.base;

export const FIDELITY_PRESETS = Object.freeze({
    low: {
        id: 'low',
        name: 'Low (Lean)',
        minTokens: 1000,
        maxTokens: 2000,
        prompt: PROMPT_LOW,
        description: 'Local determinism: all next-action contacts prepared, closed contents, compact actor motives, immediate processes and preserved consequences. No mandatory wider-world expansion.',
    },
    mid: {
        id: 'mid',
        name: 'Mid (Balanced)',
        minTokens: 2000,
        maxTokens: 4000,
        prompt: PROMPT_MID,
        description: 'Connected episode: full next-contact preparation, distance-2 skeletons for alternative branches, witnesses/pursuers and scheduled consequences.',
    },
    high: {
        id: 'high',
        name: 'High (Deep)',
        minTokens: 4000,
        maxTokens: 8000,
        prompt: PROMPT_HIGH,
        description: 'Active surroundings: full immediate contacts, structured distance-2 approaches, distance-3 agendas, multiple agents and information routes; no full Ultra distance-2 inventories.',
    },
    ultra: {
        id: 'ultra',
        name: 'Ultra (Living World)',
        minTokens: 6000,
        maxTokens: 21000,
        prompt: PROMPT_ULTRA,
        description: 'Ultra v6: full preparation through distance 2 (2–3 meaningful actions), structured distance-3 connections, causal continuity and off-screen simulation. Game rules, Private Turns and scene backgrounds are configured separately.',
    },
    custom: {
        id: 'custom',
        name: 'Custom (User Defined)',
        minTokens: 2000,
        maxTokens: 4000,
        prompt: null,
        description: 'User-defined token budget corridor and custom system prompt instructions.',
    },
});

// Default extension settings
const defaultSettings = Object.freeze({
    functionTool: true,
    autoInjectPrompt: true,
    historyRollback: true,
    privateReview: false,
    executionModeVersion: 1,
    privateReviewFormat: 'diff',
    simulationFidelity: 'mid',
    gameSystem: 'dnd5e',
    targetMinTokens: 2000,
    targetMaxTokens: 4000,
    customPrompt: '',
    autoSceneBackground: true,
    customBackgroundPrompt: '',
});

let chatDebounceTimer = null;
/**
 * Safe helper to trigger debounced chat saving.
 */
function saveChatSafe() {
    try {
        const context = SillyTavern.getContext();
        if (typeof context.saveChatDebounced === 'function') {
            context.saveChatDebounced();
            return;
        }
        if (typeof context.saveChat === 'function') {
            if (chatDebounceTimer) clearTimeout(chatDebounceTimer);
            chatDebounceTimer = setTimeout(() => {
                context.saveChat();
            }, 800);
        }
    } catch (e) {
        console.warn('Blackboard: Could not save chat', e);
    }
}

/**
 * Safe helper to register or unregister an extension prompt.
 */
function setExtensionPromptSafe(key, value, position, depth, scan = false, role = 0) {
    try {
        const context = SillyTavern.getContext();
        if (typeof context.setExtensionPrompt === 'function') {
            context.setExtensionPrompt(key, value, position, depth, scan, role);
        }
    } catch (e) {
        console.warn('Blackboard: Could not set extension prompt', e);
    }
}

/**
 * Gets or initializes extension settings.
 */
function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    migrateExecutionSettings(extensionSettings[MODULE_NAME]);
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

/**
 * Resolves the currently active system prompt depending on chosen Fidelity Tier or custom override.
 * @returns {string}
 */
/**
 * Generates an objective, live diagnostic block of the current Blackboard state.
 * Informs the model of its exact character/token budget status, block count, and explicit directives (e.g. Cold Start / Expansion).
 * @returns {string}
 */

function getEngine() {
    const context = SillyTavern.getContext();
    const metadata = context.chatMetadata ?? context.chat_metadata;
    if (!metadata) throw new Error('Chat metadata is unavailable.');
    const turn = (context.chat || []).filter(m => m.is_user && !m.is_system).length;
    if (!metadata.blackboard_engine || metadata.blackboard_engine.version !== 1) {
        metadata.blackboard_engine = { version: 1, turn, ages: {}, baseline: getBlackboard() };
    }
    const engine = metadata.blackboard_engine;
    engine.turn = turn;
    engine.ages = reconcileAges(getBlackboard(), engine.ages, turn);
    return engine;
}

export function getBlackboardMonitorStatus() {
    try {
        const limits = budget(getSettings(), FIDELITY_PRESETS);
        const bb = getBlackboard();
        const blocks = parseBlocks(bb).blocks;
        const estimated = Math.ceil(bb.length / 4);
        const directive = !bb.trim()
            ? `COLD START: initialize reality before resolving the first action; target ${limits.min}–${limits.max} tokens.`
            : estimated < limits.min
                ? `UNDER-BUDGET: expand meaningful contact coverage to at least ${limits.min} tokens. Preserve existing canon; this is NOT a cold start.`
                : estimated > limits.max
                    ? `ABOVE CEILING: compress low-contact resolved material without losing canon, active state or the progression ledger.`
                    : 'WITHIN SIZE CORRIDOR: still verify contact coverage and active processes.';
        const engine = getEngine();
        const stale = staleBlocks(bb, engine.ages, engine.turn, 3);
        let progression = gameSystem(getSettings()) === 'universal' ? '\n- Progression: campaign-owned record; no automatic game-specific calculations.' : '';
        try {
            const p = readProgression(bb, { gameSystem: gameSystem(getSettings()) });
            if (p) progression = `\n- Progression (calculated): level ${p.level}; ${p.mode === 'xp' ? `${p.xp} XP, eligible level ${p.eligible_level}, next threshold ${p.next_level_xp ?? 'MAX'}` : 'milestone mode'}; proficiency +${p.proficiency_bonus}; pending choices: ${p.pending_choices.length}.`;
        } catch {
            progression = '\n- Progression ledger is invalid. Repair it; do not invent an XP total.';
        }
        return `\n\n[BLACKBOARD ENGINE MONITOR]\n- Live State Size: ~${estimated} tokens (estimate: characters/4; ${bb.length} chars; ${blocks.length} blocks).\n- Required Corridor: ${limits.min}–${limits.max} (${limits.name}).\n- Directive: ${directive}\n- STALE age unit: user messages, NOT game time. Static facts may remain unchanged.\n${stale.map(s => `- STALE: [${s.id}] — ${s.age} user turns since content changed; verify time-dependent facts.`).join('\n')}${progression}\n`;
    } catch (error) {
        console.warn('Blackboard: monitor unavailable', error);
        return '';
    }
}

export function getActiveSystemPrompt() {
    const settings = getSettings();
    const promptContent = composeGamePrompt(settings, FIDELITY_PRESETS).text + '\n\n' + executionInstructions(settings);

    const monitor = getBlackboardMonitorStatus();
    if (promptContent.includes('{{getvar::world_blackboard}}')) {
        return promptContent.replace('{{getvar::world_blackboard}}', '{{getvar::world_blackboard}}' + monitor);
    }
    return promptContent + monitor;
}

/**
 * Synchronizes the injected extension prompt with SillyTavern.
 * If autoInjectPrompt is enabled, injects into the end of the System Prompt (position: 0 = IN_PROMPT, role: 0 = SYSTEM).
 * If disabled, unsets the prompt.
 */
/**
 * Resolves the active background generation system prompt instructions.
 * @returns {string}
 */
export function getActiveBackgroundSystemPrompt() {
    return backgroundInstructions(getSettings());
}

/**
 * Synchronizes the injected extension prompt with SillyTavern.
 * If autoInjectPrompt is enabled, injects into the end of the System Prompt (position: 0 = IN_PROMPT, role: 0 = SYSTEM).
 * If autoSceneBackground is enabled, also injects the scene background instructions.
 */
export function syncExtensionPrompt() {
    const settings = getSettings();
    setExtensionPromptSafe(PROMPT_INJECTION_KEY,
        settings.functionTool && settings.autoInjectPrompt ? getActiveSystemPrompt() : '',
        settings.functionTool && settings.autoInjectPrompt ? 0 : -1, 0, false, 0);
    setExtensionPromptSafe(BG_PROMPT_INJECTION_KEY,
        settings.autoSceneBackground && settings.autoInjectPrompt ? getActiveBackgroundSystemPrompt() : '',
        settings.autoSceneBackground && settings.autoInjectPrompt ? 0 : -1, 0, false, 0);
    boardInspector?.refresh();
}

/**
 * Gets the current raw text from the blackboard variable.
 * @returns {string}
 */
export function getBlackboard() {
    try {
        const context = SillyTavern.getContext();
        const valFromContext = context.variables?.local?.get(VARIABLE_NAME);
        if (typeof valFromContext === 'string' && valFromContext.length > 0) {
            return valFromContext;
        }
        const valFromMetadata = context.chatMetadata?.variables?.[VARIABLE_NAME]
            ?? context.chat_metadata?.variables?.[VARIABLE_NAME];
        if (typeof valFromMetadata === 'string' && valFromMetadata.length > 0) {
            return valFromMetadata;
        }
        if (valFromContext !== undefined && valFromContext !== null) {
            return String(valFromContext);
        }
    } catch (e) {
        console.warn('Blackboard: Error in getBlackboard', e);
    }
    return '';
}

/**
 * Saves a snapshot of the blackboard state into a message's extra metadata.
 * message.extra is stored in chat JSONL files but completely ignored by Vector Storage and LLM context.
 * @param {number} [targetIndex] Target message index in chat (defaults to latest message)
 * @param {string} [snapshot] Blackboard content to snapshot (defaults to current blackboard)
 */

export function stampSnapshot(targetIndex = null, snapshot = null) {
    const context = SillyTavern.getContext();
    const chat = context.chat;
    if (!Array.isArray(chat) || !chat.length) return;
    const idx = Number.isInteger(targetIndex) ? targetIndex : chat.length - 1;
    if (idx < 0 || idx >= chat.length) return;
    writeSnapshot(chat[idx], snapshot ?? getBlackboard(), getEngine());
    saveChatSafe();
}

function restoreState(snapshot, reason) {
    const context = SillyTavern.getContext();
    const metadata = context.chatMetadata ?? context.chat_metadata;
    // Restore ages even if the board text is identical across two alternatives.
    metadata.blackboard_engine = snapshot.engine ?? { version: 1, turn: 0, ages: {}, baseline: snapshot.text };
    setBlackboard(snapshot.text, { skipSnapshot: true, reason, restore: true });
    syncExtensionPrompt();
}

function turnStart(chat, end = chat.length - 1) {
    // Retain completed tool messages which the host keeps in history when only
    // regenerating the final prose. Removing the entire turn restores the user checkpoint.
    return findSnapshot(chat, end);
}

export function syncBlackboardFromHistory(triggerReason = 'history', targetIndex = null) {
    if (!getSettings().historyRollback) return false;
    const chat = SillyTavern.getContext().chat || [];
    const index = Number.isInteger(targetIndex) ? targetIndex : chat.length - 1;
    const msg = chat[index];
    const newSwipe = triggerReason === 'message_swiped' && Number.isInteger(msg?.swipe_id) && msg.swipe_id >= (msg.swipes?.length ?? 0);
    const snapshot = newSwipe ? turnStart(chat, index - 1) : findSnapshot(chat, index);
    if (snapshot) {
        restoreState(snapshot, `restored ${triggerReason}`);
        return true;
    }
    if (triggerReason !== 'chat_changed') {
        const baseline = getEngine().baseline || '';
        restoreState({ text: baseline, engine: { version: 1, turn: 0, ages: {}, baseline } }, 'restored baseline');
    }
    return false;
}

export function setBlackboard(content, { skipSnapshot = false, reason = null, restore = false } = {}) {
    const context = SillyTavern.getContext();
    const metadata = context.chatMetadata ?? context.chat_metadata;
    if (!metadata) throw new Error('Cannot save Blackboard without chat metadata.');
    const raw = typeof content === 'string' ? content : String(content ?? '');
    // Manual edits allow explicit corrections. Model changes are validated in applyUpdate.
    // Old snapshots are restored verbatim, not migrated or rewritten during rollback.
    const value = restore ? raw : validateBoard(raw, null, { gameSystem: gameSystem(getSettings()) }).text;
    const engine = restore ? metadata.blackboard_engine : getEngine();
    const nextAges = reconcileAges(value, engine.ages, engine.turn);
    if (context.variables?.local?.set) context.variables.local.set(VARIABLE_NAME, value);
    metadata.variables ??= {};
    metadata.variables[VARIABLE_NAME] = value;
    engine.ages = nextAges;
    if (!context.chat?.length) engine.baseline = value;
    context.saveMetadataDebounced?.();
    if (!skipSnapshot) stampSnapshot(null, value);
    syncExtensionPrompt();
    return value;
}

/**
 * @typedef {{ category: string, tagId: string, rawHeader: string, blockKey: string, content: string }} BlackboardBlock
 * @typedef {{ preamble: string, blocks: BlackboardBlock[] }} ParsedBlackboard
 */

/**
 * Parses markdown text into modular [CATEGORY #id] blocks.
 * @param {string} rawText
 * @returns {ParsedBlackboard}
 */

export async function handleUpdateBlackboard(args) {
    try {
        const result = applyUpdate(getBlackboard(), args, { gameSystem: gameSystem(getSettings()) });
        setBlackboard(result.text, { skipSnapshot: true, reason: `tool ${result.action}` });
        // The host appends a tool message after this returns; its event stamps the post-state.
        // Keep the pre-action user snapshot intact so regeneration cannot double-apply effects.
        return JSON.stringify({ status: 'success', action: result.action, changed: result.changed, total_blocks: result.parsed.blocks.length,
            board_size: { characters: result.text.length, estimated_tokens: Math.ceil(result.text.length / 4), estimate_method: 'characters/4' },
            progression: result.progression, persistence: 'updated_in_memory; host_chat_save_scheduled' });
    } catch (error) {
        return JSON.stringify({ status: 'error', message: String(error?.message || error), state_changed: false });
    }
}

/**
 * JSON Schema for UpdateBlackboard tool definition.
 */
const blackboardSchema = Object.freeze({
    type: 'object',
    properties: {
        action: {
            type: 'string',
            description: 'Action to perform: "upsert" (add or overwrite a specific block, default), "delete" (permanently remove an obsolete/resolved block), "replace_all" (completely replace all blackboard contents with new markdown), Full replacements must preserve existing block IDs. Use the user inspector for intentional resets.',
            enum: ['upsert', 'delete', 'replace_all'],
        },
        block_id: {
            type: 'string',
            description: 'Identifier for the block, e.g. "SCENE #dock_warehouse", "ENTITIES #assassin", "NARRATIVE #poison_origin", or "MISC #world_clock". Required for action="delete" and single-block "upsert".',
        },
        block_key: {
            type: 'string',
            description: 'Alias for block_id.',
        },
        content: {
            type: 'string',
            description: 'Complete replacement body for one block, or a batch of full [CATEGORY #id] blocks. Omitted fields inside an overwritten block are lost. MISC #character_progression uses the version-1 JSON ledger: preserve base_xp and existing awards; append unique award IDs. XP totals, eligibility and proficiency are computed by the extension. A level-up must include the updated player ENTITIES sheet in the same batch.',
        },
        blackboard_content: {
            type: 'string',
            description: 'Complete markdown snapshot of all active blocks. Provided for backward compatibility.',
        },
    },
});

/**
 * Registers the UpdateBlackboard native function tool with SillyTavern.
 */
/**
 * Generates and sets a new scene background using SillyTavern's image generation extension.
 * @param {string} rawPrompt
 * @returns {Promise<string>}
 */
export async function executeSetSceneBackground(rawPrompt) {
    if (!getSettings().autoSceneBackground) {
        return JSON.stringify({ status: 'notice', message: 'Background generation is disabled in Blackboard settings.' });
    }
    if (!rawPrompt || typeof rawPrompt !== 'string' || rawPrompt.trim().length === 0) {
        return JSON.stringify({ status: 'error', message: 'Prompt is required for SetSceneBackground.' });
    }

    const prompt = rawPrompt.trim();
    const slashImagine = SlashCommandParser.commands?.['imagine']
        || SlashCommandParser.commands?.['image']
        || SlashCommandParser.commands?.['sd'];

    if (!slashImagine || typeof slashImagine.callback !== 'function') {
        toastr.warning('Image Generation extension is not active in SillyTavern.', 'Blackboard');
        return JSON.stringify({
            status: 'notice',
            message: 'Image Generation extension is not enabled or available in SillyTavern. Background was not generated.',
        });
    }

    try {
        toastr.info('Generating new scene background...', 'Blackboard');
        console.log('[Blackboard] Requesting scene background generation for prompt:', prompt);

        // Execute imagine callback with string arguments ('true' / 'false') so isTrueBoolean / isFalseBoolean in SillyTavern do not throw TypeError
        const url = await slashImagine.callback({
            quiet: 'true',
            gallery: 'false',
        }, prompt);

        if (!url || typeof url !== 'string' || url.trim().length === 0) {
            console.warn('[Blackboard] Image generation returned empty URL.');
            toastr.warning('Image generation did not return a valid image URL.', 'Blackboard');
            return JSON.stringify({ status: 'error', message: 'Image generation failed or returned empty result.' });
        }

        if (!getSettings().autoSceneBackground) {
            return JSON.stringify({ status: 'notice', message: 'Image generated but background setting was disabled before application.', url });
        }
        console.log('[Blackboard] Scene background generated successfully:', url);

        const context = SillyTavern.getContext();
        const eventSource = context?.eventSource;
        const eventTypes = context?.eventTypes ?? context?.event_types;
        const bgUrlFormatted = `url("${encodeURI(url)}")`;

        if (eventSource && (eventTypes?.FORCE_SET_BACKGROUND || eventSource.has?.('force_set_background'))) {
            const ev = eventTypes.FORCE_SET_BACKGROUND || 'force_set_background';
            await eventSource.emit(ev, {
                url: bgUrlFormatted,
                path: url,
            });
        }
        $('#bg1').css('background-image', bgUrlFormatted);

        toastr.success('Scene background updated!', 'Blackboard');
        return JSON.stringify({ status: 'success', message: 'Scene background generated and applied.', url });
    } catch (err) {
        console.error('Blackboard: Error in SetSceneBackground', err);
        toastr.error('Failed to generate scene background: ' + (err?.message || err), 'Blackboard');
        return JSON.stringify({ status: 'error', message: 'Error generating scene background: ' + (err?.message || String(err)) });
    }
}

/**
 * Registers the UpdateBlackboard and SetSceneBackground native function tools with SillyTavern.
 */
function registerFunctionTools() {
    try {
        const settings = getSettings();
        const { registerFunctionTool, unregisterFunctionTool } = SillyTavern.getContext();

        if (typeof unregisterFunctionTool === 'function') {
            unregisterFunctionTool('UpdateBlackboard');
            unregisterFunctionTool('SetSceneBackground');
        }

        if (typeof registerFunctionTool !== 'function') {
            console.warn('Blackboard: registerFunctionTool is not available in SillyTavern context.');
            return;
        }

        // 1. UpdateBlackboard Tool
        if (settings.functionTool) {
            registerFunctionTool({
                name: 'UpdateBlackboard',
                displayName: 'Update World Blackboard',
                description: 'Updates the persistent objective state (Single Source of Truth / Blackboard) of the campaign world. Call this tool whenever entering a new area/shop, time elapses (updating [MISC #world_clock]), advancing off-screen entities, mutating entity statblocks/inventories/injuries, tracking stealth/alarm timers, or pruning resolved blocks. Supports granular block actions ("upsert", "delete") using block_id (e.g., "SCENE #dock", "NARRATIVE #murderer", "ENTITIES #boss", "MISC #world_clock"), or a complete snapshot ("replace_all"). ' + (gameSystem(settings) === 'universal' ? GENERIC_PROGRESSION_TOOL : 'The progression JSON ledger is validated and its totals are computed; preserve every previous award entry and include the updated player sheet when applying a level-up. Batch updates are validated before changing any state.'),
                parameters: gameSystem(settings) === 'universal' ? { ...blackboardSchema, properties: { ...blackboardSchema.properties, content: { ...blackboardSchema.properties.content, description: 'Complete replacement body for one block or a batch of full blocks. Preserve all unaffected facts. ' + GENERIC_PROGRESSION_TOOL } } } : blackboardSchema,
                action: async (args) => {
                    if (!getSettings().functionTool) return JSON.stringify({ status: 'error', message: 'Simulation Blackboard is disabled.' });
                    try {
                        return await handleUpdateBlackboard(args);
                    } catch (err) {
                        console.error('Blackboard: Error executing UpdateBlackboard', err);
                        return JSON.stringify({ status: 'error', message: String(err?.message || err) });
                    }
                },
                formatMessage: () => '',
            });
            console.debug('Blackboard: UpdateBlackboard tool successfully registered.');
        }

        // 2. SetSceneBackground Tool
        if (settings.autoSceneBackground) {
            registerFunctionTool({
                name: 'SetSceneBackground',
                displayName: 'Set Scene Background',
                description: 'Generates and sets an atmospheric landscape background image for the current scene in the chat. Call this tool AFTER the final confirmed UpdateBlackboard (after any dice rolls) when entering a new location, drastically shifting vantage point, or when the environment changes. Describe ONLY what {{user}} sees from their perspective; no hidden secrets, no character portraits.',
                parameters: Object.freeze({
                    $schema: 'http://json-schema.org/draft-04/schema#',
                    type: 'object',
                    properties: {
                        prompt: {
                            type: 'string',
                            description: 'Detailed, cinematic landscape visual prompt in English describing the environment from {{user}}\'s current perspective, posture, and lighting. Include camera framing, weather, materials, and mood. Scenery only; no hidden elements, no character portraits or dialogue.',
                        },
                    },
                    required: ['prompt'],
                }),
                action: async (args) => {
                    try {
                        return await executeSetSceneBackground(args?.prompt);
                    } catch (err) {
                        console.error('Blackboard: Error executing SetSceneBackground', err);
                        return JSON.stringify({ status: 'error', message: String(err?.message || err) });
                    }
                },
                formatMessage: () => '',
            });
            console.debug('Blackboard: SetSceneBackground tool successfully registered.');
        }
    } catch (error) {
        console.error('Blackboard: Error registering function tools', error);
    }
}

/**
 * Counts tokens using SillyTavern's tokenizer or fallback approximation.
 * @param {string} text
 * @returns {Promise<number>}
 */
async function estimateTokens(text) {
    if (!text) return 0;
    try {
        const { getTokenCountAsync } = SillyTavern.getContext();
        if (typeof getTokenCountAsync === 'function') {
            const count = await getTokenCountAsync(text);
            if (typeof count === 'number' && !isNaN(count)) {
                return count;
            }
        }
    } catch {
        // Fallback
    }
    return Math.ceil(text.length / 4);
}

/** Kept as a public alias for existing callers; all routes share one inspector. */
export async function openBlackboardModal(options = {}) {
    panelWorkspace?.openBoard({ opener: document.activeElement, ...options });
}

function inspectorState() {
    const context = SillyTavern.getContext();
    const chatId = context.chatId ?? context.getCurrentChatId?.();
    const avatar = context.characters?.[context.characterId]?.avatar ?? context.characterId;
    const scope = chatId != null ? JSON.stringify([context.groupId ?? avatar, chatId]) : (context.chatMetadata ?? context.chat_metadata);
    const limits = budget(getSettings(), FIDELITY_PRESETS);
    return { scope, text: getBlackboard(), minTokens: limits.min, maxTokens: limits.max,
        label: chatId ? `Current chat · ${chatId}` : 'Current chat · live world state' };
}

function inspectorSummary(text) {
    let progression;
    try {
        const p = readProgression(text, { gameSystem: gameSystem(getSettings()) });
        progression = p ? `Level ${p.level} | ${p.classes.map(c => `${c.name} ${c.level}`).join(' / ')} | ${p.mode === 'xp' ? `XP ${p.xp} / ${p.next_level_xp ?? 'MAX'} | Earned level ${p.eligible_level}` : 'Milestones'} | Proficiency +${p.proficiency_bonus} | Pending choices: ${p.pending_choices.length}`
            : gameSystem(getSettings()) === 'universal' ? 'Progression: campaign-owned record; no automatic D&D calculations.' : 'Progression: not initialized.';
    } catch (error) { progression = `Progression: ${error.message}`; }
    const engine = getEngine();
    const stale = staleBlocks(text, engine.ages, engine.turn, 3);
    return { progression, stale: stale.length ? `Review unchanged blocks: ${stale.map(s => `[${s.id}] (${s.age} turns)`).join(', ')}` : 'No blocks older than 3 user turns. Static facts need no artificial update.' };
}

/**
 * Registers slash commands for the blackboard.
 */
function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'blackboard',
        aliases: ['bb'],
        helpString: '<div>Manages the objective reality blackboard (world_blackboard).</div><ul><li><code>/bb</code> - opens the Blackboard Inspector modal.</li><li><code>/bb show</code> - displays current blackboard content.</li><li><code>/bb clear</code> - clears the blackboard.</li><li><code>/bb set &lt;text&gt;</code> - sets the blackboard content.</li><li><code>/bb append &lt;text&gt;</code> - appends text to the blackboard.</li></ul>',
        returns: 'Blackboard content or status',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Subcommand: open, show, clear, set <text>, append <text>',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '',
            }),
        ],
        callback: async (args, value) => {
            const raw = String(value || args?._unnamed || '').trim();
            const lower = raw.toLowerCase();

            if (!raw || lower === 'open') {
                await openBlackboardModal();
                return 'Blackboard inspector opened.';
            }

            if (lower === 'show' || lower === 'get' || lower === 'view') {
                const current = getBlackboard();
                if (!current) {
                    toastr.info('Objective Blackboard is currently empty.');
                    return 'Blackboard is empty.';
                }
                const context = SillyTavern.getContext();
                context.sendSystemMessage?.('generic', `### Objective Reality Blackboard\n\n${current}`, { isSmallSys: true });
                return current;
            }

            if (lower === 'clear') {
                setBlackboard('');
                toastr.success('Objective Blackboard cleared.');
                return 'Blackboard cleared.';
            }

            if (lower.startsWith('set ')) {
                const text = raw.substring(4).trim();
                setBlackboard(text);
                toastr.success('Objective Blackboard updated.');
                return 'Blackboard updated.';
            }

            if (lower.startsWith('append ')) {
                const text = raw.substring(7).trim();
                const current = getBlackboard();
                const combined = current ? `${current}\n\n${text}` : text;
                setBlackboard(combined);
                toastr.success('Appended to Objective Blackboard.');
                return 'Blackboard updated.';
            }

            await openBlackboardModal();
            return 'Blackboard inspector opened.';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'bb-clear',
        helpString: 'Clears the objective reality blackboard for the current chat.',
        returns: 'Status message',
        callback: async () => {
            setBlackboard('');
            toastr.success('Objective Blackboard cleared.');
            return 'Blackboard cleared.';
        },
    }));
}

/**
 * Adds the blackboard icon to the wand / extensions menu.
 */
async function addWandButton() {
    try {
        const buttonHtml = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'button');
        const getWandContainer = () => $(document.getElementById('dice_wand_container') ?? document.getElementById('extensionsMenu'));
        getWandContainer().append(buttonHtml);

        $('#blackboard_wand_button').on('click', function () {
            openBlackboardModal({ fromWand: true, opener: this });
        });
        $('#blackboard_control_wand_button').on('click', function () {
            panelWorkspace?.openSettings({ opener: this });
        });
        $('#blackboard_wand_button, #blackboard_control_wand_button').on('keydown', function (event) {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $(this).trigger('click'); }
        });
    } catch (err) {
        console.error('Blackboard: Error adding wand button', err);
    }
}

/**
 * Adds the settings drawer to SillyTavern extension settings.
 */
async function addSettingsDrawer() {
    try {
        const settingsHtml = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
        const getSettingsContainer = () => $(document.getElementById('blackboard_container') ?? document.getElementById('extensions_settings2'));
        getSettingsContainer().append(settingsHtml);

        const settings = getSettings();
        $('#blackboard_function_tool').prop('checked', settings.functionTool).on('change', function () {
            settings.functionTool = !!$(this).prop('checked');
            syncExtensionPrompt();
            updateExecutionUI();
            updateBackgroundStatus();
            SillyTavern.getContext().saveSettingsDebounced?.();
            registerFunctionTools();
        });

        $('#blackboard_auto_inject_prompt').prop('checked', settings.autoInjectPrompt).on('change', function () {
            settings.autoInjectPrompt = !!$(this).prop('checked');
            SillyTavern.getContext().saveSettingsDebounced?.();
            syncExtensionPrompt();
        });

        $('#blackboard_history_rollback').prop('checked', settings.historyRollback).on('change', function () {
            settings.historyRollback = !!$(this).prop('checked');
            SillyTavern.getContext().saveSettingsDebounced?.();
        });

        $('#blackboard_private_review').prop('checked', settings.privateReview).on('change', function () {
            const capabilities = privateTurnCapabilities();
            if ($(this).prop('checked') && !capabilities.supported) {
                $(this).prop('checked', settings.privateReview);
                updateExecutionUI();
                toastr.warning(capabilities.message, 'Objective Blackboard');
                return;
            }
            settings.privateReview = !!$(this).prop('checked');
            updateExecutionUI();
            SillyTavern.getContext().saveSettingsDebounced?.();
            syncExtensionPrompt();
        });
        function updateExecutionUI() {
            const capabilities = privateTurnCapabilities();
            $('#blackboard_private_capabilities').text(capabilities.message);
            $('#blackboard_turn_instructions').val(executionInstructions(settings));
            $('#blackboard_private_format').prop('disabled', !settings.functionTool || !settings.privateReview || !capabilities.supported);
            $('#blackboard_execution_status').text(!settings.functionTool
                ? 'Simulation Blackboard is disabled. Private Turns are inactive; their settings are retained.'
                : settings.privateReview
                ? capabilities.supported
                    ? 'Private Turns: separate checks before publication. Available at every fidelity tier.'
                    : 'Private Turns enabled but blocked in this browser. No automatic fallback to standard generation.'
                : 'Standard: self-check within the ordinary generation; no separate audit requests.');
        }
        $('#blackboard_private_format').val(settings.privateReviewFormat).on('change', function () {
            settings.privateReviewFormat = $(this).val() === 'full' ? 'full' : 'diff';
            SillyTavern.getContext().saveSettingsDebounced?.();
        });
        $('#blackboard_private_export').on('click', downloadPrivateReport);
        updateExecutionUI();

        // Populate Fidelity Tier UI
        const $fidelitySelect = $('#blackboard_fidelity_select');
        for (const [id, preset] of Object.entries(FIDELITY_PRESETS)) {
            $(`#blackboard_fidelity_select option[value="${id}"]`).text(id === 'custom'
                ? preset.name : `${preset.name} — ${preset.minTokens.toLocaleString()}–${preset.maxTokens.toLocaleString()} tokens`);
        }
        const $fidelityDesc = $('#blackboard_fidelity_desc');
        const $minTokensInput = $('#blackboard_min_tokens');
        const $maxTokensInput = $('#blackboard_max_tokens');

        function updateFidelityUI() {
            const currentFidelity = settings.simulationFidelity || 'mid';
            $fidelitySelect.val(currentFidelity);
            const preset = FIDELITY_PRESETS[currentFidelity] || FIDELITY_PRESETS.mid;
            $fidelityDesc.text(preset.description || '');

            const isCustom = currentFidelity === 'custom';
            $minTokensInput.val(budget(settings, FIDELITY_PRESETS).min).prop('disabled', !isCustom);
            $maxTokensInput.val(budget(settings, FIDELITY_PRESETS).max).prop('disabled', !isCustom);

            const resolved = composeGamePrompt(settings, FIDELITY_PRESETS);
            const activePrompt = resolved.base;
            $('#blackboard_game_system').val(gameSystem(settings));
            $('#blackboard_game_system_desc').text(GAME_SYSTEMS[gameSystem(settings)].description);
            $('#blackboard_game_profile_preview').val(resolved.profile);
            $('#blackboard_custom_system_notice').text(resolved.custom && !resolved.recognized
                ? 'Custom text is preserved verbatim. Remove any conflicting game-specific instructions yourself when switching profiles.'
                : 'Known presets are separated into shared instructions and the selected game profile. Your saved original text is preserved.');
            $('#blackboard_custom_prompt').val(activePrompt);
        }

        $fidelitySelect.on('change', function () {
            const selected = String($(this).val() || 'mid');
            settings.simulationFidelity = selected;
            if (selected !== 'custom') {
                const preset = FIDELITY_PRESETS[selected] || FIDELITY_PRESETS.mid;
                settings.targetMinTokens = preset.minTokens;
                settings.targetMaxTokens = preset.maxTokens;
                settings.customPrompt = ''; // Reset custom override to track preset
                delete settings.systemPromptVariant;
            }
            updateFidelityUI();
            SillyTavern.getContext().saveSettingsDebounced?.();
            syncExtensionPrompt();
            toastr.info(`Simulation Fidelity switched to ${FIDELITY_PRESETS[selected]?.name || selected}.`);
        });

        $minTokensInput.on('change input', function () {
            const val = parseInt($(this).val(), 10);
            if (!isNaN(val) && val > 0) {
                settings.targetMinTokens = val;
                settings.targetMaxTokens = Math.max(val, settings.targetMaxTokens);
                $maxTokensInput.val(settings.targetMaxTokens);
                syncExtensionPrompt();
                SillyTavern.getContext().saveSettingsDebounced?.();
            }
        });

        $maxTokensInput.on('change input', function () {
            const val = parseInt($(this).val(), 10);
            if (!isNaN(val) && val > 0) {
                settings.targetMaxTokens = Math.max(val, settings.targetMinTokens);
                $maxTokensInput.val(settings.targetMaxTokens);
                syncExtensionPrompt();
                SillyTavern.getContext().saveSettingsDebounced?.();
            }
        });

        $('#blackboard_game_system').on('change', function () {
            settings.gameSystem = $(this).val() === 'universal' ? 'universal' : 'dnd5e';
            updateFidelityUI();
            SillyTavern.getContext().saveSettingsDebounced?.();
            registerFunctionTools();
            syncExtensionPrompt();
            toastr.info('Game profile changed. Existing chat state has not been converted.');
        });

        $('#blackboard_save_prompt').on('click', () => {
            const val = $('#blackboard_custom_prompt').val()?.trim() ?? '';
            settings.systemPromptVariant = resolveQualityPrompt(settings, FIDELITY_PRESETS).variant;
            if (settings.customPrompt && !settings.customPromptBackup) settings.customPromptBackup = settings.customPrompt;
            settings.customPrompt = val;
            SillyTavern.getContext().saveSettingsDebounced?.();
            syncExtensionPrompt();
            toastr.success('Blackboard system prompt saved.');
        });

        $('#blackboard_reset_prompt').on('click', () => {
            const currentFidelity = settings.simulationFidelity || 'mid';
            const preset = FIDELITY_PRESETS[currentFidelity] || FIDELITY_PRESETS.mid;
            settings.customPrompt = '';
            delete settings.systemPromptVariant;
            updateFidelityUI();
            SillyTavern.getContext().saveSettingsDebounced?.();
            syncExtensionPrompt();
            toastr.info(`System prompt reset to ${preset.name} default.`);
        });

        // Background generation settings bindings
        const updateBackgroundStatus = () => {
            $('#blackboard_background_status').text(!settings.autoSceneBackground
                ? 'Disabled: no instructions or tool are provided. The current background and saved instructions are retained.'
                : !settings.autoInjectPrompt
                    ? 'Tool enabled. Auto-injection is disabled: no background instructions are provided.'
                    : settings.functionTool && settings.privateReview
                        ? 'Enabled: the background request runs after the reviewed private turn is published.'
                        : 'Enabled: the background is generated and applied when the tool is called during a standard turn.');
        };
        updateBackgroundStatus();
        $('#blackboard_private_review').on('change.background', updateBackgroundStatus);
        $('#blackboard_auto_inject_prompt').on('change.background', updateBackgroundStatus);
        $('#blackboard_auto_scene_background').prop('checked', !!settings.autoSceneBackground).on('change', function () {
            settings.autoSceneBackground = !!$(this).prop('checked');
            updateBackgroundStatus();
            SillyTavern.getContext().saveSettingsDebounced?.();
            registerFunctionTools();
            syncExtensionPrompt();
        });

        const activeBgPrompt = (typeof settings.customBackgroundPrompt === 'string' && settings.customBackgroundPrompt.trim().length > 0)
            ? settings.customBackgroundPrompt
            : DEFAULT_BACKGROUND_SYSTEM_PROMPT;
        $('#blackboard_background_custom_prompt').val(activeBgPrompt);

        $('#blackboard_save_bg_prompt').on('click', () => {
            const val = $('#blackboard_background_custom_prompt').val()?.trim() ?? '';
            settings.customBackgroundPrompt = val;
            SillyTavern.getContext().saveSettingsDebounced?.();
            syncExtensionPrompt();
            toastr.success('Background generation instructions saved.');
        });

        $('#blackboard_reset_bg_prompt').on('click', () => {
            $('#blackboard_background_custom_prompt').val(DEFAULT_BACKGROUND_SYSTEM_PROMPT);
            settings.customBackgroundPrompt = '';
            SillyTavern.getContext().saveSettingsDebounced?.();
            syncExtensionPrompt();
            toastr.info('Background generation instructions reset to default.');
        });

        updateFidelityUI();

        $('#blackboard_open_from_settings').on('click', () => {
            openBlackboardModal();
        });
        settingsDashboard = installSettingsDashboard({ html: await renderExtensionTemplateAsync(TEMPLATE_PATH, 'dashboard'), presets: FIDELITY_PRESETS });
        if (settingsDashboard) {
            boardInspector = installBoardInspector({ html: await renderExtensionTemplateAsync(TEMPLATE_PATH, 'inspector'),
                read: inspectorState, write: setBlackboard, parse: parseBlocks, tidy: text => serializeBlocks(parseBlocks(text)),
                summarize: inspectorSummary, countTokens: estimateTokens,
                openSettings: opener => panelWorkspace?.openSettings({ opener }),
            });
            panelWorkspace = createPanelWorkspace({ dashboard: settingsDashboard, inspector: boardInspector });
        }
    } catch (err) {
        console.error('Blackboard: Error adding settings drawer', err);
    }
}

// Initialize on page load
jQuery(async function () {
    try {
        await addWandButton();
        await addSettingsDrawer();
        registerFunctionTools();
        syncExtensionPrompt();
        registerSlashCommands();

        const context = SillyTavern.getContext();
        const eventSource = context?.eventSource;
        const eventTypes = context?.eventTypes ?? context?.event_types;


        if (eventSource && eventTypes) {
            const on = (name, handler) => { if (eventTypes[name]) eventSource.on(eventTypes[name], handler); };
            on('GENERATE_BEFORE_COMBINE_PROMPTS', syncExtensionPrompt);
            on('MESSAGE_SENT', index => {
                getEngine();
                stampSnapshot(index); // Pre-action state, including the XP ledger and age counters.
                syncExtensionPrompt();
            });
            on('CHAT_CHANGED', () => {
                clearPrivateReport();
                const restored = syncBlackboardFromHistory('chat_changed');
                if (!restored) { getEngine(); stampSnapshot(); }
                syncExtensionPrompt();
            });
            on('MESSAGE_DELETED', () => syncBlackboardFromHistory('message_deleted'));
            on('MESSAGE_SWIPED', index => syncBlackboardFromHistory('message_swiped', index));
            on('GENERATION_STARTED', (type, options, dryRun) => {
                if (dryRun || !getSettings().historyRollback || !['swipe', 'regenerate'].includes(type)) return;
                const chat = SillyTavern.getContext().chat || [];
                const last = chat[chat.length - 1];
                const end = last && !last.is_user && !last.is_system ? chat.length - 2 : chat.length - 1;
                const snapshot = turnStart(chat, end);
                if (snapshot) restoreState(snapshot, 'before regeneration');
            });
            on('MESSAGE_RECEIVED', index => {
                stampSnapshot(index);
                syncExtensionPrompt();
            });
            on('TOOL_CALLS_PERFORMED', () => {
                const ctx = SillyTavern.getContext();
                const last = ctx.chat?.[ctx.chat.length - 1];
                if (last?.extra?.tool_invocations) {
                    // The host has not rendered this message yet. Preserve API tool data in
                    // extra, but do not publish private board contents in its visible body.
                    redactToolLog(last);
                    stampSnapshot(ctx.chat.length - 1);
                }
                syncExtensionPrompt();
            });
        }
        installPrivateRunner({ settings: getSettings, getBoard: getBlackboard, setBoard: setBlackboard,
            synchronize: syncExtensionPrompt,
            disableSimulation: () => {
                getSettings().functionTool = false;
                $('#blackboard_function_tool').prop('checked', false).trigger('change');
                registerFunctionTools(); syncExtensionPrompt();
                SillyTavern.getContext().saveSettingsDebounced?.();
            },
        });
        console.log('[Blackboard] Extension loaded successfully with private transition review.');
    } catch (err) {
        console.error('[Blackboard] Error initializing extension:', err);
    }
});
