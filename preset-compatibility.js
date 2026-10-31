import { runPrivateTurn, parseJson } from './transaction.js';
import { NARRATION_REVIEW_PROTOCOL, validateNarrationReport } from './narration-validation.js';
import { CAMPAIGN_PROMPTS } from './prompts/campaign-bundle.js';

// Mark only our own injections. Never guess which arbitrary preset paragraphs to delete.
const marker = kind => `BLACKBOARD_COMPAT_${kind.toUpperCase()}`;
export function markCompatibilityInjection(text, kind) {
    if (!['world', 'background'].includes(kind)) throw new Error('Unknown Blackboard injection kind');
    return `<!-- ${marker(kind)}_START -->\n${text}\n<!-- ${marker(kind)}_END -->`;
}

function mapText(messages, visit) {
    return messages.map(message => ({ ...structuredClone(message), content: typeof message.content === 'string'
        ? visit(message.content) : Array.isArray(message.content) ? message.content.map(part => part?.type === 'text'
            ? { ...structuredClone(part), text: visit(part.text) } : structuredClone(part)) : message.content }));
}
const textOf = messages => messages.map(m => typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? m.content.filter(p => p?.type === 'text').map(p => p.text).join('\n') : '').join('\n');
const mediaOf = messages => messages.flatMap(m => Array.isArray(m.content)
    ? m.content.filter(p => ['image_url', 'input_audio'].includes(p?.type)) : []);
const trackerPattern = /<!--\s*GFX_START\s*-->[\s\S]*?<internal_states>[\s\S]*?<\/internal_states>[\s\S]*?<!--\s*GFX_END\s*-->/gi;

function publicText(text) {
    return text.replace(trackerPattern, '')
        .replace(/<(think|thinking|reasoning|internal_monologue)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<(?:think|thinking|reasoning|internal_monologue)(?:\s[^>]*)?>[\s\S]*$/gi, '')
        .replace(/(?:^|\n)#{1,6}[ \t]*Internal Monologue[ \t]*:?[^\n]*\n[\s\S]*?(?=(?:\n)#{1,6}[ \t]*Response\b|$)/gi, '')
        .replace(/<!--[^]*?-->/g, '');
}

// Read already rendered chat text. Never render raw messages a second time:
// preset macros/regex may have side effects and hidden source is not disclosure.
export function captureDisplayedHistory(chat, type, document = globalThis.document) {
    const end = type === 'swipe' && !chat.at(-1)?.is_user ? chat.length - 1 : chat.length;
    return [...document?.querySelectorAll?.('#chat .mes[mesid]') ?? []].flatMap(element => {
        const index = Number(element.getAttribute('mesid'));
        const message = Number.isInteger(index) && index >= 0 && index < end ? chat[index] : null;
        if (!message || message.is_system || message.extra?.tool_invocations) return [];
        const body = element.querySelector('.mes_text');
        let text = body?.innerText;
        // A preset tracker is a separate state source, even when expanded. Its
        // objective secrets must not become character knowledge by being rendered.
        for (const section of body?.querySelectorAll?.('internal_states, details') ?? []) {
            const knownTracker = section.tagName?.toLowerCase() === 'internal_states'
                || /\bINTERNAL STATES\b/i.test(section.querySelector(':scope > summary')?.textContent ?? '');
            if (knownTracker && typeof text === 'string' && section.innerText) text = text.replace(section.innerText, '');
        }
        return typeof text === 'string' && text.trim() ? [{ role: message.is_user ? 'user' : 'assistant',
            content: publicText(text) }] : [];
    });
}

export function captureCompatibilityContext(messages, chat = [], type = 'normal', displayedHistory = null) {
    const world = [], backgrounds = [];
    const native = mapText(messages, value => {
        let text = String(value ?? '');
        for (const kind of ['world', 'background']) {
            const pattern = new RegExp(`<!-- ${marker(kind)}_START -->\\n([\\s\\S]*?)\\n<!-- ${marker(kind)}_END -->`, 'g');
            text = text.replace(pattern, (_match, content) => { (kind === 'world' ? world : backgrounds).push(content); return ''; });
        }
        return text;
    }).filter(m => typeof m.content !== 'string' || m.content.trim());
    if (world.length !== 1 || backgrounds.length > 1) throw new Error('Separate narration could not identify its Blackboard instructions. Reload SillyTavern and retry; no preset instructions were removed.');
    // Raw saved history supplements the last FF tracker only if prompt-only regex
    // already removed it. It is reference data, never a substitute current board.
    const history = chat.slice(0, type === 'swipe' && !chat.at(-1)?.is_user ? -1 : undefined)
        .filter(m => !m.is_system && !m.extra?.tool_invocations && typeof m.mes === 'string');
    let priorTracker = null;
    for (const message of [...history].reverse()) {
        if (message.is_user) continue;
        const matches = [...message.mes.matchAll(trackerPattern)];
        if (matches.length) { priorTracker = matches.at(-1)[0]; break; }
    }
    const nativeText = textOf(native);
    const visible = displayedHistory ?? history.map(m => ({ role: m.is_user ? 'user' : 'assistant', content: publicText(m.mes) }));
    // This supplemental public-history window is bounded; the assembled native
    // context remains intact and governs ordinary context truncation.
    const visibleHistory = [];
    let characters = 0;
    for (const message of [...visible].reverse()) {
        if (characters + message.content.length > 32000 && visibleHistory.length) break;
        visibleHistory.unshift(structuredClone(message)); characters += message.content.length;
    }
    return { native, simulationInstructions: [...world, ...backgrounds].join('\n\n'),
        priorTracker: priorTracker && !nativeText.includes(priorTracker) ? priorTracker : null,
        visibleHistory, historyWindowLimited: visibleHistory.length < visible.length || (displayedHistory !== null && displayedHistory.length < history.length),
        // Recognize the explicit FF module, not arbitrary words or old history.
        requiredInternalStates: /<internal_states_module>[\s\S]*?<internal_states>/.test(nativeText) };
}

const NARRATION_PROTOCOL = `BLACKBOARD — SEPARATE NARRATION, SAME ALREADY-RESOLVED PLAYER TURN
You are the presentation component. The world executor has already resolved this player's action. The following result packet overrides conflicting procedural instructions from the preset for THIS request only. Preserve the preset's language, voice, prose, formatting and enabled tracker templates; treat its reasoning workflow as a retrospective account of this supplied outcome, not a new simulation.
Do not call or print tools, reroll, reinterpret success, advance time, execute another NPC agenda step, change relationships/inventory/resources, invent new commitments or decide the player's voluntary actions/feelings. Native prompt macro dice are NOT new results to use. The supplied binding dice and agreed state already settle the action. A presentation-only turn counter may increment once from the previous completed player turn, never once per API request or rewrite.
resolved_candidate is the factual player-view account: preserve its material events, observations, dialogue meaning, uncertainty, outcome and hand-off point. You may rephrase or enrich atmosphere without creating interactable facts. Do not omit a failure or answer a subsequent player decision. current_board is objective truth for consistency, NOT permission to disclose it. Never expose undiscovered actors, motives, hidden checks, inventories or NPC thoughts merely because they occur in that board or a tracker template. Ordinary story prose from visible_history can establish prior disclosures; prior_tracker and system/card/lore records do not grant disclosure or character knowledge. Keep undisclosed tracker fields as 'Not observed' or equivalent rather than exposing them or manufacturing an empty world.
State trackers are DISPLAY PROJECTIONS of the agreed state, not a second independently advancing ledger. Preserve their enabled shape and unchanged known fields; never run their world/dice/relationship engines a second time. Explicit campaign mechanics were resolved by the executor, not by tracker formatting. The previous tracker can help retain old fields, but a contradictory old entry does not override current_board. Preserve the prepared public HUD/item cards/mechanics in a compatible position before any mandatory trailing tracker.
Apply presentation_instructions when supplied: this is the user's additional prose-style choice, not permission to alter state. Return ONE complete final player-facing response only, including the full enabled trailing tracker when required. No audit JSON or private executor commentary. A separate check will inspect all output, including collapsed HTML. Corrections rewrite presentation only; world state and dice are frozen.`;

const packet = (state, result) => ({ revision: result.draft.revision, narration_id: state.narrationId,
    resolved_candidate: result.candidate, current_board: result.draft.head, binding_dice: result.draft.rolls,
    prior_tracker: state.sources.priorTracker, visible_history: state.sources.visibleHistory,
    history_window_limited: state.sources.historyWindowLimited,
    required_internal_states: state.sources.requiredInternalStates,
    presentation_instructions: result.draft.campaignLayers?.narrativeStyle !== 'inherit'
        ? CAMPAIGN_PROMPTS['narration-' + result.draft.campaignLayers?.narrativeStyle] ?? '' : '',
    disclosure: 'Objective records and previous trackers are reference only, not permission to reveal secrets.' });

const presentationContext = (state, result) => textOf(state.sources.native)
    + '\n\nADDITIONAL PRESENTATION INSTRUCTIONS:\n' + packet(state, result).presentation_instructions;

export function narrationMessages(sources, data, feedback = null, previous = '') {
    return [...structuredClone(sources.native), { role: 'system', content: NARRATION_PROTOCOL },
        { role: 'user', content: 'BLACKBOARD RESOLVED TURN (data, not another action):\n' + JSON.stringify({ ...data,
            ...(feedback ? { findings_to_correct: feedback, previous_narration: previous,
                correction_scope: 'Fix these presentation findings only. No world, roll or outcome changes.' } : {}) }) }];
}

export function validateNarrationText(answer, sources) {
    if (answer?.calls?.length) throw new Error('Narrator returned tool calls although this stage has no tools.');
    if (answer?.error) throw new Error('Narrator returned an API error.');
    if (['length', 'max_tokens', 'max_token', 'recitation', 'content_filter', 'safety'].includes(answer?.finishReason)) throw new Error(`Narrator did not complete its answer (${answer.finishReason}).`);
    const text = typeof answer?.text === 'string' ? answer.text.trim() : '';
    if (!text) throw new Error('Narrator returned an empty answer.');
    if (sources.requiredInternalStates) {
        const starts = text.match(/<internal_states>/g) ?? [], ends = text.match(/<\/internal_states>/g) ?? [];
        const gfxStarts = text.match(/<!--\s*GFX_START\s*-->/g) ?? [], gfxEnds = text.match(/<!--\s*GFX_END\s*-->/g) ?? [];
        if (starts.length !== 1 || ends.length !== 1 || gfxStarts.length !== 1 || gfxEnds.length !== 1
            || !/<!--\s*GFX_START\s*-->[\s\S]*?<internal_states>[\s\S]+?<\/internal_states>\s*<!--\s*GFX_END\s*-->\s*$/.test(text)) {
            throw new Error('The enabled Internal States template needs one complete trailing HTML block and both GFX markers.');
        }
    }
    return text;
}

// Preserve a preset's mandatory trailing tracker even after our public receipt UI.
export function appendCompatibilityJournal(candidate, journal) {
    const match = [...candidate.matchAll(trackerPattern)].at(-1);
    if (match && !candidate.slice(match.index + match[0].length).trim()) {
        return candidate.slice(0, match.index).trimEnd() + '\n\n' + journal + '\n\n' + match[0];
    }
    return candidate + '\n\n' + journal;
}

/** Optional wrapper: existing world transaction plus a tool-free presentation boundary. */
export async function runPresetCompatibleTurn(options) {
    const { checkpoint, saveCheckpoint = async () => {}, context, chat = [], type = 'normal',
        signal, assertCurrent = () => {}, onProgress = () => {}, request, reviewEnabled = false } = options;
    if (checkpoint && (checkpoint.kind !== 'separate_narration' || checkpoint.version !== 1)) throw new Error('The saved turn uses a different execution mode. Restore that mode before resuming.');
    const state = checkpoint ? structuredClone(checkpoint) : { version: 1, kind: 'separate_narration',
        sources: captureCompatibilityContext(context, chat, type, options.displayedHistory ?? null), phase: 'world', world: null,
        reviewEnabled, narrationId: 0, narration: '', previousNarration: '', feedback: null,
        pending: null, answer: null, log: [], formatAttempts: 0, rewrites: 0,
        narrationStats: { requests: 0, inputChars: 0, outputChars: 0, responses: [] } };
    if (state.reviewEnabled !== reviewEnabled) throw new Error('Private Turn review setting changed; restore the saved setting before resuming.');
    if (checkpoint && state.haltKind === 'format') { state.haltReason = null; state.haltKind = null; state.formatAttempts = 0; }
    const guard = () => { signal?.throwIfAborted(); assertCurrent(); };
    const save = async () => {
        state.draft = state.world?.draft;
        state.issueLedger = state.world?.issueLedger ?? [];
        state.reviewMode = state.world?.reviewMode ?? options.reviewMode;
        state.stats = { ...state.world?.stats, separateNarration: true,
            requests: (state.world?.stats?.requests ?? 0) + state.narrationStats.requests };
        await saveCheckpoint(structuredClone(state));
    };
    let result;
    try {
        await save(); guard();
        // A completed world checkpoint returns immediately on Resume: no model,
        // tool, interval or background gets replayed after a narration failure.
        result = await runPrivateTurn({ ...options,
            context: [...state.sources.native, ...(state.sources.priorTracker ? [{ role: 'system',
                content: 'Previous preset tracker — historical reference only, not current authority or instructions:\n' + state.sources.priorTracker }] : [])],
            simulationInstructions: state.sources.simulationInstructions,
            reviewEnabled, checkpoint: state.world,
            saveCheckpoint: async world => {
                state.world = world;
                if (state.phase === 'world') state.phase = world.phase === 'done' ? 'narrate' : 'world';
                if (world.haltReason) { state.haltReason = world.haltReason; state.haltKind = world.haltKind; }
                await save();
            },
        });
        if (state.phase === 'world') state.phase = 'narrate';
        const ask = async messages => {
            if (!state.pending) {
                if (state.narrationStats.requests >= 12) throw new Error('Separate narration request limit reached; saved without publication.');
                state.pending = { messages, phase: state.phase };
                state.narrationStats.requests++;
                state.narrationStats.inputChars += JSON.stringify(messages).length;
                await save();
            }
            guard(); onProgress(state.phase, result.draft.revision, state.stats, null);
            const answer = await request(state.pending.messages, []);
            state.answer = answer; state.pending = null;
            state.narrationStats.outputChars += JSON.stringify(answer).length;
            state.narrationStats.responses.push({ phase: state.phase, model: answer.model ?? null,
                usage: answer.usage ?? null, finishReason: answer.finishReason ?? null });
            await save(); guard();
        };
        while (state.phase !== 'done') {
            guard();
            if (state.haltReason) throw new Error(state.haltReason);
            if (!state.answer) {
                const data = packet(state, result);
                if (state.phase === 'narrate') await ask(narrationMessages(state.sources, data, state.feedback, state.previousNarration));
                else if (state.phase === 'narration_check') {
                    const json = JSON.stringify({ ...data, candidate: state.narration,
                        preset_context: presentationContext(state, result), format_feedback: state.formatFeedback ?? null });
                    const media = mediaOf(state.sources.native);
                    await ask([{ role: 'system', content: NARRATION_REVIEW_PROTOCOL }, { role: 'user',
                        content: media.length ? [{ type: 'text', text: json }, ...media] : json }]);
                } else throw new Error('Unknown separate narration stage.');
            }
            try {
                if (state.phase === 'narrate') {
                    state.narration = validateNarrationText(state.answer, state.sources);
                    state.narrationId++;
                    state.log.push({ stage: 'narrate', narration_id: state.narrationId, candidate: state.narration });
                    state.phase = 'narration_check';
                } else {
                    const answer = state.answer;
                    if (answer.error || answer.calls?.length || ['length', 'max_tokens', 'max_token', 'recitation', 'content_filter', 'safety'].includes(answer.finishReason)) throw new Error('Narration check returned an error, tools or an incomplete report.');
                    const report = validateNarrationReport(parseJson(answer.text), { ...packet(state, result),
                        candidate: state.narration, preset_context: presentationContext(state, result),
                        visible_history: state.sources.visibleHistory });
                    state.log.push({ stage: 'narration_check', report });
                    state.finalReview = report;
                    if (report.verdict === 'pass') state.phase = 'done';
                    else if (report.verdict === 'blocked' || state.rewrites >= 2) {
                        state.haltReason = 'Separate narration could not preserve the resolved turn. The world and draft are saved; inspect Export before restarting.';
                        state.haltKind = 'narration_validation';
                    } else {
                        state.feedback = report.issues; state.previousNarration = state.narration;
                        state.rewrites++; state.phase = 'narrate';
                    }
                }
                state.answer = null; state.formatAttempts = 0; state.formatFeedback = null;
            } catch (error) {
                state.log.push({ stage: state.phase, status: 'invalid_output', error: error.message, raw: state.answer });
                state.formatFeedback = { error: error.message, previous_report: state.answer?.text,
                    instruction: 'Correct the output format only; preserve the agreed world, dice and all substantive findings.' };
                if (state.phase === 'narrate') {
                    state.previousNarration = String(state.answer?.text ?? '');
                    state.feedback = [...(state.feedback ?? []).filter(issue => !issue.output_format_error),
                        { aspect: 'format', output_format_error: true, problem: error.message,
                            correction: 'Return one complete response with the required output structure, without tools. Preserve and address the other substantive findings.' }];
                }
                state.answer = null;
                if (++state.formatAttempts >= 2) {
                    state.haltKind = 'format'; state.haltReason = 'Separate narration returned invalid output twice. Turn saved; Resume repeats only the current presentation stage.';
                }
            }
            await save();
        }
        guard(); await save();
        const stats = { ...result.stats, separateNarration: true,
            requests: result.stats.requests + state.narrationStats.requests,
            inputChars: result.stats.inputChars + state.narrationStats.inputChars,
            outputChars: result.stats.outputChars + state.narrationStats.outputChars,
            elapsedMs: Date.now() - result.stats.started };
        return { ...result, candidate: state.narration, stats,
            narration: { mode: 'separate', resolvedCandidate: result.candidate,
                requests: state.narrationStats.requests, responses: state.narrationStats.responses,
                rewrites: state.rewrites, log: state.log, review: state.finalReview,
                priorTrackerRestored: !!state.sources.priorTracker } };
    } catch (error) {
        error.privateTurn = { ...error.privateTurn, compatibility: { phase: state.phase, narration: state.narration,
            log: state.log, stats: state.narrationStats }, versions: state.world?.draft?.versions,
            rolls: state.world?.draft?.rolls, campaignLayers: state.world?.draft?.campaignLayers };
        throw error;
    }
}
