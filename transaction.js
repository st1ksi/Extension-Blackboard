import { PRIVATE_PROTOCOL } from './turn-instructions.js';
import { PRIVATE_BACKGROUND_PROTOCOL } from './background-instructions.js';
import { applyUpdate, parseBlocks, validateBoard } from './state.js';
import { normalizeDiceArguments, diceResult, emptyDiceError, recoverEmptyDiceCheckpoint } from './dice.js';
import { REVIEW_STAGES, makeAudit, reviewProtocol, repairProtocol, validateAudit, validateEvidence, affectedReviewStages } from './review.js';
import { normalizePrivateReviewMode, LIGHT_REVIEW_STAGE, LIGHT_REPAIR_PROTOCOL, validateLightCorrection } from './private-modes.js';
import { pendingIssues, captureIssues, acceptIssueReport, reopenIssueVerdicts, stageFindings } from './issue-ledger.js';
import { freezeCampaignLayers, campaignLayersFingerprint, getCampaignReviewCriteria } from './campaign-layers.js';

export const PROCESS_KEY = 'misc #simulation_processes';
const map = text => new Map(parseBlocks(text).blocks.map(b => [b.blockKey, b.content]));
export function diffBoards(before, after) {
    const a = map(before), b = map(after);
    return [...new Set([...a.keys(), ...b.keys()])].flatMap(id => a.get(id) === b.get(id) ? [] : [{
        id, before: a.get(id) ?? null, after: b.get(id) ?? null,
    }]);
}
export function absoluteTime(value) {
    const m = String(value).match(/^Day (\d+),? (\d{2}):(\d{2}):(\d{2})$/);
    if (!m || +m[1] < 1 || +m[2] > 23 || +m[3] > 59 || +m[4] > 59) throw new Error(`Invalid absolute time: ${value}`);
    return (+m[1] - 1) * 86400 + +m[2] * 3600 + +m[3] * 60 + +m[4];
}
export function parseJson(text) {
    return JSON.parse(String(text).trim().replace(/^```(?:json)?\s*\n/, '').replace(/\n```\s*$/, ''));
}
export function processRegister(text) {
    const content = map(text).get(PROCESS_KEY);
    if (!content) return null;
    const value = parseJson(content);
    if (value.version !== 1 || !Array.isArray(value.processes)) throw new Error('Invalid simulation_processes schema');
    absoluteTime(value.through);
    const ids = new Set();
    for (const p of value.processes) {
        if (!p.id || ids.has(p.id) || !['active', 'blocked', 'completed', 'cancelled'].includes(p.status)) throw new Error('Invalid/duplicate process or status');
        ids.add(p.id);
        if (typeof p.owner !== 'string' || !map(text).has(p.owner.toLowerCase())) throw new Error(`Missing process owner: ${p.owner}`);
        if (absoluteTime(p.accounted_through) > absoluteTime(value.through) || (['active', 'blocked'].includes(p.status) && absoluteTime(p.accounted_through) !== absoluteTime(value.through))) throw new Error(`Unaccounted process: ${p.id}`);
        if (p.next_at != null && absoluteTime(p.next_at) <= absoluteTime(value.through)) throw new Error(`Unresolved deadline: ${p.id}`);
        if (['completed', 'cancelled'].includes(p.status) && p.next_at != null) throw new Error(`Closed process has a future deadline: ${p.id}`);
        if (typeof p.note !== 'string' || !p.note.trim()) throw new Error(`Missing disposition: ${p.id}`);
    }
    return value;
}
export class DraftTurn {
    constructor(baseline, mode = 'diff', gameSystem = 'dnd5e') {
        this.gameSystem = gameSystem;
        this.baseline = baseline;
        this.head = baseline;
        this.mode = mode === 'full' ? 'full' : 'diff';
        this.versions = [{ revision: 0, text: baseline }];
        this.receipts = [];
        this.rolls = [];
        this.background = null;
        this.backgroundRequests = [];
    }
    get revision() { return this.versions.length - 1; }
    boardSize() {
        return { revision: this.revision, characters: this.head.length, estimated_tokens: Math.ceil(this.head.length / 4), estimate_method: 'characters/4' };
    }
    update(args) {
        if (args.base_revision !== this.revision) throw new Error(`Stale base_revision. Expected ${this.revision}. Read the current version before editing.`);
        const result = applyUpdate(this.head, args, { gameSystem: this.gameSystem });
        if (result.changed) {
            this.head = result.text;
            this.versions.push({ revision: this.revision + 1, text: this.head });
        }
        return { status: 'staged', base_revision: args.base_revision, revision: this.revision, changed: result.changed, canonical_state_unchanged: true, board_size: this.boardSize() };
    }
    packet() {
        const versions = this.mode === 'full' ? this.versions : this.versions.map((v, i) => i === 0 ? v : ({
            base_revision: i - 1, revision: i, changes: diffBoards(this.versions[i - 1].text, v.text),
        }));
        return { format: this.mode, head_revision: this.revision, board_size: this.boardSize(), versions, receipts: this.receipts, rolls: this.rolls, queued_background: this.background };
    }
    checks() {
        const errors = [];
        if (this.rolls.some(r => diceResult(r.result).status !== 'success')) errors.push('Unconfirmed dice result: never resolve a check using an empty or unrecognized tool return.');
        try { validateBoard(this.head, this.baseline, { model: true, gameSystem: this.gameSystem }); } catch (e) { errors.push(e.message); }
        try {
            const current = processRegister(this.head);
            if (!current) throw new Error('Missing MISC #simulation_processes: reconcile all active processes, or explicitly use an empty processes array.');
            const beforeContent = map(this.baseline).get(PROCESS_KEY);
            const before = beforeContent ? parseJson(beforeContent) : null;
            if (before && absoluteTime(current.through) < absoluteTime(before.through)) throw new Error('Simulation clock moved backwards');
            for (const p of before?.processes ?? []) {
                if (['active', 'blocked'].includes(p.status) && !current.processes.some(x => x.id === p.id)) throw new Error(`Active process disappeared: ${p.id}; close it explicitly first.`);
            }
            const clock = map(this.head).get('misc #world_clock') ?? '';
            const time = clock.match(/(?:Current In-Game Time|Time):\s*(Day \d+,? \d{2}:\d{2}:\d{2})/i)?.[1];
            if (!time || absoluteTime(time) !== absoluteTime(current.through)) throw new Error('world_clock and process register must share an absolute time including seconds');
        } catch (e) { errors.push(e.message); }
        return errors;
    }

}

export { PRIVATE_PROTOCOL } from './turn-instructions.js';

/** Serializable state machine. Checkpoints are private, never chat messages. */
export async function runPrivateTurn({ baseline, mode, reviewMode = 'heavy', gameSystem = 'dnd5e', campaignLayers = null, backgroundsEnabled = true, context, request, invoke, signal, assertCurrent = () => {}, onProgress = () => {}, maxRepairs = 4, checkpoint = null, saveCheckpoint = async () => {} }) {
    const selectedReviewMode = normalizePrivateReviewMode(reviewMode);
    const selectedLayers = structuredClone(campaignLayers ?? freezeCampaignLayers({ gameSystem }));
    const selectedLayerFingerprint = campaignLayersFingerprint(selectedLayers);
    if (selectedLayers.gameProfile.id !== gameSystem) throw new Error('Game system changed or conflicts with the frozen instruction profile. Restore the matching profile before resuming.');
    const state = checkpoint ? structuredClone(checkpoint) : {
        version: 4, draft: new DraftTurn(baseline, mode, gameSystem), context, phase: 'simulate', step: 0,
        reviewMode: selectedReviewMode,
        candidate: '', feedback: null, answer: null, callIndex: 0, failedUpdate: false,
        pending: null, inFlightTool: null, review: null, maxRepairs,
        stats: { mode: mode || 'diff', reviewMode: selectedReviewMode, requests: 0, reviews: 0, repairs: 0, inputChars: 0, outputChars: 0, started: Date.now() },
    };
    if (![1, 2, 3, 4].includes(state.version) || state.draft.baseline !== baseline) throw new Error('Incompatible checkpoint or changed baseline');
    if ((state.draft.gameSystem ?? 'dnd5e') !== gameSystem) throw new Error('Game system changed; restore the checkpoint profile before resuming.');
    const savedLayers = state.draft.campaignLayers;
    if (checkpoint && (!savedLayers || savedLayers.version === 1)) {
        throw new Error('This saved turn predates the separated quality and campaign instructions. Its draft is preserved. Export it, or restore its original extension version and settings to resume; discard only if you want to restart the turn.');
    }
    if (savedLayers) {
        if (campaignLayersFingerprint(savedLayers) !== selectedLayerFingerprint) throw new Error('Campaign instructions changed; restore the saved campaign settings and instruction version before resuming.');
    }
    // Exact text and current-aspect criteria remain private and immutable for
    // this transaction. A later prompt edit cannot reinterpret a paused turn.
    state.draft.campaignLayers = savedLayers ?? selectedLayers;
    // Checkpoints from before review modes are always the original heavy cycle.
    state.reviewMode = normalizePrivateReviewMode(state.reviewMode);
    if (state.reviewMode !== selectedReviewMode) throw new Error('Private review mode changed; restore the checkpoint mode before resuming.');
    state.stats.reviewMode = state.reviewMode;
    const reviewStages = state.reviewMode === 'light' ? [LIGHT_REVIEW_STAGE] : REVIEW_STAGES;
    const isLight = state.reviewMode === 'light';
    const legacyCheckpoint = state.version < 3;
    if (legacyCheckpoint) {
        // Preserve simulation/tools in flight. An old broad approval cannot stand
        // in for the new audits; retain it privately as migration evidence only.
        state.legacyReview = state.review;
        if (['review', 'done'].includes(state.phase)) {
            state.legacyReviewAnswer = state.answer;
            state.phase = 'review'; state.pending = null; state.answer = null; state.review = null;
        }
        if (state.version === 1) state.maxRepairs = maxRepairs;
        state.version = 3;
        if (state.phase !== 'repair') state.auditIndex = 0;
        state.approvals = []; state.formatAttempts = 0;
        state.formatFeedback = null;
    }
    // v3 review packets are compatible with detection; preserve pending/received
    // requests exactly. Preserve in-flight repairs too, then verify their stage.
    // Old approvals are deliberately not reused under the new routing protocol.
    if (state.version < 4) {
        state.approvals = [];
        state.reviewKind = 'detect';
        if (state.phase === 'done') {
            state.legacyReview = state.review;
            state.phase = 'review'; state.auditIndex = 0;
            state.answer = null; state.pending = null; state.review = null;
        }
        if (state.phase === 'repair') {
            state.repairStart = { revision: state.draft.versions.length - 1, candidate: state.candidate, candidate_id: state.candidateId ?? 1, migrated: true };
        }
        state.version = 4;
    }
    state.reviewKind ??= 'detect';
    state.invalidationLog ??= [];
    state.auditIndex ??= 0;
    state.auditLog ??= [];
    state.approvals ??= [];
    state.candidateVersions ??= state.candidate ? [{ id: 1, revision: state.draft.versions.length - 1, text: state.candidate }] : [];
    state.candidateId ??= state.candidateVersions.length;
    state.formatAttempts ??= 0;
    state.repairsByStage ??= {};
    state.issueLedger ??= [];
    if (state.backgroundsEnabled !== undefined && state.backgroundsEnabled !== backgroundsEnabled) throw new Error('Background setting changed; restore the checkpoint setting before resuming.');
    state.backgroundsEnabled = backgroundsEnabled;
    if (!backgroundsEnabled) {
        // Older transactions could queue this tool despite the UI being off.
        // Keep receipts/history for diagnosis, but never execute that request.
        state.draft.background = null;
        if (state.pending?.allowed?.includes('SetSceneBackground')) state.pending = null;
    }
    // Explicit Resume may retry report formatting, without reopening gameplay.
    // The total request budget persists across resumes.
    if (checkpoint && state.haltKind === 'format') {
        state.haltReason = null; state.haltKind = null; state.formatAttempts = 0;
    }
    if ((state.draft.gameSystem ?? 'dnd5e') !== gameSystem) throw new Error('Game system changed; restore the checkpoint profile before resuming.');
    const draft = Object.assign(new DraftTurn(baseline, state.draft.mode, gameSystem), state.draft);
    state.draft = draft;
    if (legacyCheckpoint) {
        // Salvage parseable allegations from old rejected reports as hypotheses.
        // No previous pass closes them under the new protocol.
        for (const [index, entry] of state.auditLog.entries()) {
            try {
                const report = entry.report ?? parseJson(entry.raw?.text);
                const audit = { stage: entry.stage, revision: entry.revision, candidate_id: entry.candidate_id, targets: entry.targets ?? [] };
                captureIssues(state.issueLedger, report, audit, index);
            } catch { /* Raw text remains in auditLog for format/diagnostic review. */ }
        }
    }
    const stats = state.stats;
    const findings = () => stageFindings(state.issueLedger, reviewStages.map(s => s.id));
    const save = () => {
        state.stageFindings = findings();
        return saveCheckpoint(structuredClone(state));
    };
    const repairEvidence = () => state.repairStart ? {
        repair_before: { revision: state.repairStart.revision, candidate_id: state.repairStart.candidate_id,
            board: draft.versions[state.repairStart.revision].text, candidate: state.repairStart.candidate,
            ...(state.repairStart.migrated ? { note: 'Migrated checkpoint boundary; some repair edits may already precede this snapshot. Inspect the complete revision history.' } : {}) },
        repair_changes: diffBoards(draft.versions[state.repairStart.revision].text, draft.head),
    } : {};
    const progressPhase = () => state.phase === 'review' ? state.reviewKind : state.phase;
    const simulationTools = ['UpdateBlackboard', 'RollTheDice', ...(backgroundsEnabled ? ['SetSceneBackground'] : [])];
    const guard = () => { signal?.throwIfAborted(); assertCurrent(); };
    const ask = async () => {
        guard();
        if (!state.pending) {
            if (stats.requests >= 48) throw new Error('Private turn request limit exceeded');
            const phase = state.phase;
            const stage = reviewStages[state.auditIndex].id;
            const allowed = phase === 'review' ? [] : phase === 'repair' ? ['UpdateBlackboard'] : simulationTools;
            const issues = pendingIssues(state.issueLedger, stage);
            const issuePacket = issues.map(({ history, ...issue }) => ({ ...issue,
                first_observation: history.find(h => h.event === 'observed'), last_observation: history.at(-1),
                observed_candidate_text: state.candidateVersions.find(c => c.id === issue.observed_candidate)?.text ?? null }));
            const payload = phase === 'review' ? { candidate: state.candidate, candidate_id: state.candidateId,
                audit: { ...makeAudit(draft, stage, state.candidateId), purpose: state.reviewKind }, review_kind: state.reviewKind,
                ...(state.reviewKind === 'verify' ? repairEvidence() : {}), mechanical_errors: draft.checks(), format_feedback: state.formatFeedback ?? null,
                current_board: draft.head, issue_ledger: issuePacket, pending_issue_ids: issues.map(i => i.id), reference_context: state.context } : { feedback: state.feedback, previous_candidate: state.candidate,
                ...(phase === 'repair' ? { stage, candidate_id: state.candidateId, current_board: draft.head,
                    issues_to_fix: issuePacket.filter(i => isLight || i.status === 'open'), reference_context: state.context,
                    ...(isLight ? { ...repairEvidence(), mechanical_errors: draft.checks(), format_feedback: state.formatFeedback ?? null } : {}) } : {}) };
            let protocol = phase === 'review' ? reviewProtocol(stage, state.reviewKind, draft.campaignLayers) : phase === 'repair' ? (isLight ? LIGHT_REPAIR_PROTOCOL : PRIVATE_PROTOCOL + '\n' + repairProtocol(stage))
                : PRIVATE_PROTOCOL + (backgroundsEnabled ? '\n\n' + PRIVATE_BACKGROUND_PROTOCOL : '');
            if (phase === 'repair') {
                const criteria = getCampaignReviewCriteria(draft.campaignLayers, stage);
                if (criteria) protocol += '\n\nCAMPAIGN CRITERIA — apply only to the recorded findings and their necessary consequences; do not start another audit or advance time.\n' + criteria;
            }
            // The auditor receives campaign context as reference data, with its
            // own system role. It does not inherit the live DM task/assistant role.
            const data = 'PRIVATE TURN DATA (not a new player action):\n' + JSON.stringify({ phase, ...draft.packet(), ...payload });
            const media = phase !== 'simulate' ? state.context.flatMap((m, index) => {
                const parts = Array.isArray(m.content) ? m.content.filter(p => ['image_url', 'input_audio'].includes(p?.type)) : [];
                return parts.length ? [{ type: 'text', text: `Reference media from original context message ${index}:` }, ...parts] : [];
            }) : [];
            const messages = [...(phase !== 'simulate' ? [] : state.context), { role: 'system', content: protocol },
                { role: 'user', content: media.length ? [{ type: 'text', text: data }, ...media] : data }];
            state.pending = { messages, allowed };
            stats.requests++;
            if (phase === 'review') stats.reviews++;
            stats.inputChars += JSON.stringify(messages).length;
            await save();
        }
        onProgress(progressPhase(), draft.revision, stats, state.phase === 'simulate' ? null : reviewStages[state.auditIndex].id);
        const answer = await request(state.pending.messages, state.pending.allowed);
        // Persist the received result even when Stop was clicked at the same
        // boundary. Resuming processes it; no request or dice need repeating.
        state.answer = answer;
        state.pending = null;
        state.callIndex = 0;
        state.failedUpdate = false;
        stats.outputChars += JSON.stringify(answer).length;
        stats.responses ??= [];
        stats.responses.push({ phase: state.phase, review_kind: state.phase === 'review' ? state.reviewKind : null, stage: state.phase === 'simulate' ? null : reviewStages[state.auditIndex].id, revision: draft.revision, model: answer.model ?? null, usage: answer.usage ?? null, finishReason: answer.finishReason ?? null });
        await save();
        guard();
    };
    try {
        if (checkpoint) recoverEmptyDiceCheckpoint(state);
        await save();
        if (state.inFlightTool) throw new Error('Tool outcome is uncertain after interruption. Automatic replay is blocked; export the saved turn for inspection.');
        while (state.phase !== 'done') {
            guard();
            if (state.haltReason) throw new Error(state.haltReason);
            if (state.phase !== 'review' && state.step >= 16) throw new Error('Too many staging steps; no state committed');
            if (!state.answer) await ask();
            const answer = state.answer;
            if (['length', 'max_tokens'].includes(answer.finishReason)) throw new Error('Model output limit reached; incomplete candidate cannot be committed');
            if (answer?.error) throw new Error(typeof answer.error === 'string' ? answer.error : JSON.stringify(answer.error));
            if (state.phase === 'review') {
                const checks = draft.checks();
                const stage = reviewStages[state.auditIndex].id;
                const audit = makeAudit(draft, stage, state.candidateId);
                const pending = structuredClone(pendingIssues(state.issueLedger, stage));
                let review, parsed, observed = [];
                try {
                    if (answer.calls?.length) throw new Error('Reviewer attempted a tool call');
                    parsed = parseJson(answer.text);
                    observed = captureIssues(state.issueLedger, parsed, audit, state.auditLog.length);
                    review = validateAudit(parsed, audit, draft, state.candidate, state.context, pending);
                    if (isLight && review.time_correction !== undefined) {
                        const correction = review.time_correction;
                        if (!correction || !String(correction.reason ?? '').trim()) throw new Error('Time correction needs a concrete reason');
                        absoluteTime(correction.through);
                        validateEvidence(correction.evidence, draft, state.candidate, state.context);
                        if (!review.issues.some(issue => issue.target === 'time')
                            && !pending.some(issue => issue.target === 'time' && review.issue_resolutions?.some(item => item.id === issue.id && item.status === 'open'))) {
                            throw new Error('Time correction requires a recorded time finding');
                        }
                    }
                } catch (e) {
                    state.auditLog.push({ stage, purpose: state.reviewKind, revision: draft.revision, candidate_id: state.candidateId, status: 'invalid_report', error: e.message, raw: answer, targets: audit.targets });
                    state.formatAttempts++;
                    state.formatFeedback = { error: e.message, previous_report: parsed ?? answer.text,
                        instruction: 'Repair the invalid parts of this report using the supplied sources. Retain each pending observation or explicitly refute it with evidence in issue_resolutions. Do not start a fresh assessment that silently drops findings. Do not edit the world or change its outcome.' };
                    if (state.formatAttempts >= 2) {
                        state.haltKind = 'format';
                        state.haltReason = 'The reviewer returned an invalid report twice. Turn saved; Resume will repeat only this review stage.';
                    }
                    state.answer = null;
                    await save();
                    continue;
                }
                acceptIssueReport(state.issueLedger, review, audit, state.auditLog.length, observed);
                state.auditLog.push({ stage, purpose: state.reviewKind, revision: draft.revision, candidate_id: state.candidateId, status: 'reviewed', report: review, mechanical_errors: checks, targets: audit.targets });
                state.formatAttempts = 0; state.formatFeedback = null;
                // Mechanical failures also get durable repair entries. Never
                // dispatch an empty repair task on the strength of a generic pass.
                for (const error of checks) {
                    const machineReport = { ...review, issues: [{ target: audit.targets[0].id,
                        problem: error, repair: 'Reconcile this mechanical invariant using established facts; do not reroll or advance time.' }] };
                    const ids = captureIssues(state.issueLedger, machineReport, audit, state.auditLog.length - 1);
                    for (const id of ids) {
                        const issue = state.issueLedger.find(i => i.id === id);
                        issue.status = 'open'; issue.origin = 'mechanical';
                    }
                }
                if (review.verdict === 'blocked') {
                    state.haltReason = `Review "${audit.label}" requires a missing decision or a new dice roll. Turn saved: ${pendingIssues(state.issueLedger, stage).map(i => i.problem).join('; ')}`;
                } else if (isLight) {
                    // One combined detection is followed by ONE correction stage,
                    // even for a clean report. Tools may continue that stage but
                    // never dispatch another semantic audit or verification.
                    state.feedback = { review, mechanical_errors: checks };
                    state.repairStart = { revision: draft.revision, candidate_id: state.candidateId, candidate: state.candidate };
                    state.lightResolvedTime = map(draft.head).get('misc #world_clock')?.match(/(?:Current In-Game Time|Time):\s*(Day \d+,? \d{2}:\d{2}:\d{2})/i)?.[1] ?? null;
                    if (!state.lightResolvedTime) {
                        try { state.lightResolvedTime = parseJson(map(draft.head).get(PROCESS_KEY)).through; } catch { /* The detector must supply the missing endpoint. */ }
                    }
                    if (review.time_correction) state.lightResolvedTime = review.time_correction.through;
                    stats.repairs++;
                    state.repairsByStage[stage] = 1;
                    state.phase = 'repair'; state.step = 0;
                } else if (review.verdict === 'pass' && !checks.length && !pendingIssues(state.issueLedger, stage).length) {
                    state.approvals = state.approvals.filter(r => r.stage !== stage);
                    state.approvals.push({ ...review, purpose: state.reviewKind });
                    // Verify the current repair BEFORE visiting invalidated prior
                    // aspects. Approvals retain their actual examined revision.
                    const next = REVIEW_STAGES.findIndex(s => !state.approvals.some(r => r.stage === s.id)
                        || pendingIssues(state.issueLedger, s.id).length);
                    if (next < 0) {
                        if (pendingIssues(state.issueLedger).length) throw new Error('Unresolved private review issues remain; publication blocked');
                        state.review = { revision: draft.revision, candidate_id: state.candidateId, verdict: 'pass',
                            stages: REVIEW_STAGES.map(s => state.approvals.find(r => r.stage === s.id)) };
                        state.phase = 'done';
                    } else state.auditIndex = next;
                    state.reviewKind = 'detect'; state.repairStart = null;
                } else if (stats.repairs >= state.maxRepairs || (state.repairsByStage[stage] ?? 0) >= 2) {
                    state.haltReason = `Repair limit for review "${audit.label}" reached. The unreviewed turn was saved without publication.`;
                } else {
                    state.feedback = { review, mechanical_errors: checks };
                    // The image request could describe a discarded candidate. Keep
                    // its history for diagnostics but do not execute stale artwork.
                    draft.background = null;
                    stats.repairs++;
                    state.repairsByStage[stage] = (state.repairsByStage[stage] ?? 0) + 1;
                    if (!pendingIssues(state.issueLedger, stage).some(i => i.status === 'open')) throw new Error('Repair requires confirmed stage findings');
                    state.repairStart = { revision: draft.revision, candidate_id: state.candidateId, candidate: state.candidate };
                    state.phase = 'repair'; state.step = 0;
                }
                state.answer = null;
                await save();
                continue;
            }
            if (answer.calls?.length) {
                const allowed = state.phase === 'repair' ? ['UpdateBlackboard'] : simulationTools;
                while (state.callIndex < answer.calls.length) {
                    guard();
                    const call = answer.calls[state.callIndex];
                    let result;
                    try {
                        if (state.failedUpdate) throw new Error('Earlier tool in this batch failed; dependent tools deferred until the next request.');
                        if (!allowed.includes(call.name)) throw new Error(`Tool forbidden in ${state.phase}: ${call.name}`);
                        const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
                        if (call.name === 'UpdateBlackboard') result = draft.update(args);
                        else if (call.name === 'SetSceneBackground') {
                            draft.background = args;
                            draft.backgroundRequests.push({ revision: draft.revision, arguments: args });
                            result = { status: 'queued_until_commit' };
                        } else {
                            const diceArgs = normalizeDiceArguments(args);
                            state.inFlightTool = { name: call.name, callIndex: state.callIndex, arguments: diceArgs };
                            // Outside the invocation catch: a failed save must
                            // stop execution before the non-repeatable tool runs.
                            await save();
                            result = await invoke(call.name, diceArgs);
                            if (result instanceof Error) throw result;
                            const outcome = diceResult(result);
                            if (outcome.status === 'unknown') {
                                // Some randomness might already have occurred. Persist
                                // its raw return and prohibit automatic replay on resume.
                                state.inFlightTool.result = result ?? null;
                                await save();
                                throw new Error('RollTheDice returned an unrecognized result. Turn paused; automatic reroll is blocked because the outcome is uncertain. Export the checkpoint for inspection.');
                            }
                            state.inFlightTool = null;
                            if (outcome.status === 'empty') {
                                result = emptyDiceError(result);
                                state.failedUpdate = true;
                            } else {
                                draft.rolls.push({ at_revision: draft.revision, arguments: diceArgs, result,
                                    ...(diceArgs.formula !== args.formula ? { requested_arguments: args } : {}) });
                            }
                        }
                    } catch (e) {
                        if (state.inFlightTool) throw e;
                        if (['UpdateBlackboard', 'RollTheDice'].includes(call.name)) state.failedUpdate = true;
                        result = { status: 'error', message: e.message };
                    }
                    draft.receipts.push({ tool: call.name, revision: draft.revision, result });
                    state.callIndex++;
                    await save();
                    guard();
                }
            } else {
                if (isLight && state.phase === 'repair') {
                    const stage = 'light';
                    const issues = pendingIssues(state.issueLedger, stage);
                    let correction, parsed;
                    try {
                        parsed = parseJson(answer.text);
                        correction = validateLightCorrection(parsed, draft, state.candidateId, state.context, issues, validateEvidence, state.repairStart.candidate);
                    } catch (e) {
                        state.auditLog.push({ stage, purpose: 'correct', revision: draft.revision, candidate_id: state.candidateId, status: 'invalid_report', error: e.message, raw: answer });
                        state.formatAttempts++;
                        state.formatFeedback = { error: e.message, previous_report: parsed ?? answer.text,
                            instruction: 'Repair only this correction envelope. Preserve the candidate, all already staged edits, binding dice and every recorded issue. Supply the current revision and the original candidate_id; do not resolve another gameplay interval.' };
                        if (state.formatAttempts >= 2) {
                            state.haltKind = 'format';
                            state.haltReason = 'The correction component returned an invalid report twice. Turn saved; Resume repeats only this correction stage.';
                        }
                        state.answer = null;
                        await save();
                        continue;
                    }
                    const previousCandidateId = state.candidateId;
                    state.candidate = correction.candidate;
                    state.candidateId++;
                    state.candidateVersions.push({ id: state.candidateId, revision: draft.revision, phase: 'repair', text: state.candidate });
                    const logIndex = state.auditLog.length;
                    for (const resolution of correction.issue_resolutions) {
                        const issue = state.issueLedger.find(item => item.id === resolution.id);
                        issue.status = resolution.status;
                        issue.resolution_by = 'repair';
                        issue.history.push({ event: resolution.status, component: 'repair', independently_verified: false,
                            log_index: logIndex, revision: draft.revision, candidate_id: state.candidateId,
                            reason: resolution.reason, evidence: structuredClone(resolution.evidence) });
                    }
                    const checks = draft.checks();
                    const currentTime = map(draft.head).get('misc #world_clock')?.match(/(?:Current In-Game Time|Time):\s*(Day \d+,? \d{2}:\d{2}:\d{2})/i)?.[1];
                    if (!state.lightResolvedTime || (currentTime && absoluteTime(currentTime) !== absoluteTime(state.lightResolvedTime))) {
                        checks.push('Light correction changed the resolved clock without the detection pass explicitly recording this corrected endpoint.');
                    }
                    const audit = makeAudit(draft, stage, state.candidateId);
                    for (const error of checks) {
                        const ids = captureIssues(state.issueLedger, { stage, revision: draft.revision, candidate_id: state.candidateId,
                            issues: [{ target: 'time', problem: error, repair: 'Reconcile the existing resolved interval and mechanical invariants without another turn or new dice.' }] }, audit, logIndex);
                        for (const id of ids) { const issue = state.issueLedger.find(item => item.id === id); issue.status = 'open'; issue.origin = 'mechanical'; }
                    }
                    if (correction.background_action === 'discard' || (correction.background_action === undefined
                        && (draft.revision !== state.repairStart.revision || state.candidate !== state.repairStart.candidate))) draft.background = null;
                    state.formatAttempts = 0; state.formatFeedback = null;
                    state.auditLog.push({ stage, purpose: 'correct', revision: draft.revision, candidate_id: state.candidateId,
                        status: 'corrected', report: correction, mechanical_errors: checks, independently_verified: false });
                    state.review = { revision: draft.revision, candidate_id: state.candidateId, verdict: pendingIssues(state.issueLedger).length ? 'blocked' : 'pass',
                        review_mode: 'light', independent_verification: false,
                        stages: state.auditLog.filter(entry => entry.status === 'reviewed').map(entry => entry.report),
                        correction: { ...correction, previous_candidate_id: previousCandidateId, candidate_id: state.candidateId } };
                    if (pendingIssues(state.issueLedger).length) {
                        state.haltKind = 'light_validation';
                        state.haltReason = `Light publication blocked by unresolved findings. Turn saved without publication: ${pendingIssues(state.issueLedger).map(issue => issue.problem).join('; ')}`;
                    } else state.phase = 'done';
                    state.answer = null;
                    await save();
                    continue;
                }
                state.candidate = String(answer.text ?? '').trim();
                if (!state.candidate) throw new Error('Empty candidate; no state committed');
                state.candidateId++;
                state.candidateVersions.push({ id: state.candidateId, revision: draft.revision, phase: state.phase, text: state.candidate });
                if (state.phase === 'repair') {
                    const stage = REVIEW_STAGES[state.auditIndex].id;
                    const changes = repairEvidence().repair_changes;
                    const affected = affectedReviewStages(state.approvals, changes, state.candidate, draft, state.context);
                    state.invalidationLog.push({ after_stage: stage, revision: draft.revision, candidate_id: state.candidateId,
                        changed_blocks: changes.map(c => c.id), stages: affected });
                    state.approvals = state.approvals.filter(r => !affected.includes(r.stage));
                    reopenIssueVerdicts(state.issueLedger, draft.revision, state.candidateId, [...affected, stage]);
                    state.reviewKind = 'verify';
                } else {
                    state.auditIndex = 0; state.approvals = []; state.reviewKind = 'detect';
                }
                state.formatAttempts = 0; state.formatFeedback = null;
                state.phase = 'review';
            }
            state.step++;
            state.answer = null;
            await save();
        }
        guard();
        stats.elapsedMs = Date.now() - stats.started;
        stats.revisions = draft.revision;
        await save();
        return { draft, candidate: state.candidate, stats, review: state.review, auditLog: state.auditLog, candidateVersions: state.candidateVersions, issueLedger: state.issueLedger, stageFindings: findings(), invalidationLog: state.invalidationLog };
    } catch (error) {
        error.privateTurn = { versions: draft.versions, rolls: draft.rolls, receipts: draft.receipts, campaignLayers: draft.campaignLayers, candidate: state.candidate, feedback: state.feedback, stats, background: draft.background, backgroundRequests: draft.backgroundRequests,
            auditLog: state.auditLog, candidateVersions: state.candidateVersions, issueLedger: state.issueLedger, stageFindings: findings(), invalidationLog: state.invalidationLog, review_kind: state.reviewKind, stage: reviewStages[state.auditIndex]?.id, legacyReview: state.legacyReview };
        throw error;
    }
}
