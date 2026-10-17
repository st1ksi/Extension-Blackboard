import { backgroundResult, publicJournal, renderJournal } from './tool-journal.js';
import { registerBlackboardPrivateRunner } from './private-host.js';
import { runPrivateTurn } from './transaction.js';
import { stageLabel } from './review.js';
import { normalizePrivateReviewMode, privateReviewModeLabel } from './private-modes.js';
import { createPrivateReportArchive, legacyPrivateReport } from './private-report-store.js';

let lastRun = null;
let lastRunScope = null;
let reportArchive;
export function getPrivateReport() { return lastRun; }
export function clearPrivateReport() { lastRun = null; lastRunScope = null; }
export async function downloadPrivateReport() {
    try {
        const context = SillyTavern.getContext();
        const scope = await reportArchive.key(context);
        const report = lastRunScope === scope && lastRun ? lastRun : await reportArchive.load(scope) ?? legacyPrivateReport(context);
        if (scope !== await reportArchive.key()) throw new Error('Chat changed while loading the report. Export again from the intended chat.');
        if (!report) { toastr.info('No private turn report has been saved for this chat in this browser yet.'); return; }
        const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a'); a.href = url;
        a.download = report.details_available === false ? 'blackboard-private-turn-summary.json' : 'blackboard-private-turn.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        if (report.details_available === false) toastr.warning('Only a saved summary is available. The full audit and intermediate revisions were not retained for this turn.');
    } catch (error) { toastr.error(`Could not export the private turn report: ${error.message}`, 'Objective Blackboard'); }
}

export function installPrivateRunner({ settings, getBoard, setBoard, synchronize, disableSimulation }) {
    let busy = false;
    reportArchive = createPrivateReportArchive({ getContext: () => SillyTavern.getContext(),
        getAccount: async () => (await import('../../../user.js')).getCurrentUserHandle() });
    registerBlackboardPrivateRunner(async host => {
        const s = structuredClone(settings());
        if (!s.functionTool || !s.privateReview) return null;
        if (host.dryRun) return null;
        if (host.type === 'continue') throw new Error('Private review: use a new message or regenerate instead of Continue, to avoid replaying a resolved action.');
        if (!['normal', 'regenerate', 'swipe'].includes(host.type)) return null;
        if (host.api !== 'openai' || !host.canTools) throw new Error('Blackboard private review requires Chat Completion with function tools enabled. Disable private review to use another backend.');
        if (!s.functionTool || !s.autoInjectPrompt) throw new Error('Blackboard private review requires its tool and auto-injected instructions.');
        if (busy) throw new Error('A Blackboard private turn is already running');
        busy = true;
        clearPrivateReport();
        const context = SillyTavern.getContext();
        if (context.groupId) { busy = false; throw new Error('Private review currently supports single-character chats. Disable it for group chats.'); }
        const metadata = context.chatMetadata ?? context.chat_metadata;
        const chat = context.chat;
        const historyFingerprint = () => JSON.stringify(chat.map(m => [m.is_user, m.is_system, m.mes, m.swipe_id]));
        const fingerprint = historyFingerprint();
        const baseline = getBoard();
        const engine = structuredClone(metadata.blackboard_engine);
        let committed = false;
        const assertCurrent = () => {
            host.assertCurrent?.();
            const ctx = SillyTavern.getContext();
            if ((ctx.chatMetadata ?? ctx.chat_metadata) !== metadata || ctx.chat !== chat || historyFingerprint() !== fingerprint || getBoard() !== baseline) {
                throw new Error('Chat, branch or Blackboard changed during the private turn; draft paused.');
            }
        };
        const reviewMode = normalizePrivateReviewMode(s.privateReviewMode);
        const toast = toastr.info(`Simulation: preparing working state · ${privateReviewModeLabel(reviewMode)} Private Turns…`, 'Objective Blackboard', { timeOut: 0, extendedTimeOut: 0 });
        let scope;
        const attemptStarted = host.checkpoint?.stats?.started ?? Date.now();
        try {
            scope = await reportArchive.key(context);
            assertCurrent();
            const result = await runPrivateTurn({ baseline, mode: s.privateReviewFormat, reviewMode, gameSystem: s.gameSystem, backgroundsEnabled: !!s.autoSceneBackground,
                context: host.messages, request: host.request, invoke: host.invoke,
                signal: host.signal, assertCurrent, checkpoint: host.checkpoint, saveCheckpoint: host.saveCheckpoint,
                onProgress: (phase, revision, stats, stage) => {
                    host.onProgress?.(phase, revision, stage);
                    const labels = { simulate: 'Simulation', review: 'Transition review', detect: 'Detecting issues', verify: 'Verifying repairs', repair: 'Repairing issues' };
                    toast?.find?.('.toast-message').text(`${labels[phase]}${stage ? ': ' + stageLabel(stage) : ''} · revision ${revision}`);
                },
            });
            const background = { status: !s.autoSceneBackground ? 'disabled' : result.draft.background ? 'queued' : result.draft.backgroundRequests.length ? 'discarded' : 'not_requested', request: result.draft.background, result: null };
            const report = { status: 'reviewed', attempt_started: attemptStarted, gameSystem: result.draft.gameSystem, recovery: host.recoveryInfo, ...result.stats, review: result.review, versions: result.draft.versions,
                rolls: result.draft.rolls, receipts: result.draft.receipts, background, backgroundRequests: result.draft.backgroundRequests, candidate: result.candidate,
                auditLog: result.auditLog, candidateVersions: result.candidateVersions, issueLedger: result.issueLedger,
                stageFindings: result.stageFindings, invalidationLog: result.invalidationLog };
            lastRun = report;
            lastRunScope = scope;
            // Retain the complete audit before publication/checkpoint cleanup.
            await reportArchive.save(scope, report);
            let afterSaveStarted = false;
            return {
                data: { choices: [{ message: { role: 'assistant', content: result.candidate }, finish_reason: 'stop' }] },
                commit() {
                    host.signal?.throwIfAborted(); assertCurrent();
                    setBoard(result.draft.head, { skipSnapshot: true, reason: 'private review passed' });
                    committed = true;
                },
                rollback() {
                    const ctx = SillyTavern.getContext();
                    if (committed && (ctx.chatMetadata ?? ctx.chat_metadata) === metadata && getBoard() === result.draft.head) {
                        metadata.blackboard_engine = engine;
                        setBoard(baseline, { skipSnapshot: true, restore: true });
                    }
                    report.status = 'not_published';
                },
                async afterSave() {
                    if (afterSaveStarted) return;
                    afterSaveStarted = true;
                    report.status = 'committed';
                    const last = chat[chat.length - 1];
                    const index = chat.length - 1;
                    const swipeId = last?.swipe_id;
                    const originalText = last?.mes ?? '';
                    let renderedText = originalText;
                    const sameChat = () => {
                        const ctx = SillyTavern.getContext();
                        return (ctx.chatMetadata ?? ctx.chat_metadata) === metadata && ctx.chat === chat;
                    };
                    const publish = () => {
                        if (!last || last.is_user || !sameChat() || chat[index] !== last || last.swipe_id !== swipeId || last.mes !== renderedText) return;
                        const journal = publicJournal(result.draft.rolls, background, result.draft.receipts);
                        last.extra ??= {};
                        last.extra.blackboard_review = result.stats;
                        last.extra.blackboard_tools = journal;
                        renderedText = originalText + '\n\n' + renderJournal(journal);
                        last.mes = renderedText;
                        if (Array.isArray(last.swipes) && Number.isInteger(swipeId)) last.swipes[swipeId] = renderedText;
                        if (last.swipe_info?.[swipeId]) {
                            last.swipe_info[swipeId].extra ??= {};
                            last.swipe_info[swipeId].extra.blackboard_tools = journal;
                        }
                        SillyTavern.getContext().updateMessageBlock?.(index, last, { rerenderMessage: true });
                    };
                    try {
                        publish();
                        if (result.draft.background) {
                            if (!settings().autoSceneBackground) background.status = 'disabled';
                            else if (host.signal?.aborted || !sameChat()) background.status = 'skipped';
                            else {
                                background.status = 'running';
                                background.startedAt = new Date().toISOString();
                                publish();
                                try {
                                    const raw = await host.invoke('SetSceneBackground', result.draft.background);
                                    Object.assign(background, backgroundResult(raw));
                                } catch (e) {
                                    Object.assign(background, { status: 'error', error: String(e.message ?? e) });
                                }
                                background.finishedAt = new Date().toISOString();
                            }
                        }
                        publish();
                    } finally {
                        try { await reportArchive.save(scope, report); }
                        finally { busy = false; }
                    }
                },
                release() { busy = false; },
            };
        } catch (e) {
            const retained = lastRunScope === scope ? lastRun : null;
            lastRun = { ...retained, status: 'failed', attempt_started: attemptStarted, details: e.privateTurn ?? retained?.details, reason: String(e.message), mode: s.privateReviewFormat, reviewMode, at: new Date().toISOString() };
            lastRunScope = scope;
            if (scope) {
                try { await reportArchive.save(scope, lastRun); }
                catch (storageError) { console.error('Blackboard private report could not be archived; the recovery checkpoint is retained.', storageError); }
            }
            busy = false;
            // Detailed diagnostics remain available only through the explicit report export.
            throw e;
        } finally { toastr.clear(toast); }
    }, {
        recovery: { getBoard, setBoard, settings },
        enabled: () => !!settings().functionTool && !!settings().privateReview,
        setup: { enabled: () => !!settings().functionTool, disable: disableSimulation, synchronize },
        onStart: clearPrivateReport,
        onFailure: (error, { published = false, cancelled = false, saved = false, scope } = {}) => {
            if (error.code === 'BLACKBOARD_PRIVATE_UNAVAILABLE') {
                lastRun = { status: 'blocked', reason: String(error.message), at: new Date().toISOString() };
                lastRunScope = null; // A setup error must not hide the saved completion.
                toastr.warning(error.message, 'Objective Blackboard');
                return;
            }
            if (scope && scope === lastRunScope && lastRun?.status !== 'failed') {
                lastRun = { ...lastRun, status: published ? 'published_save_failed' : cancelled ? 'cancelled' : 'failed', reason: String(error.message), at: new Date().toISOString() };
            } else if (!lastRunScope) {
                lastRun = { status: cancelled ? 'cancelled' : 'failed', reason: String(error.message), at: new Date().toISOString() };
            }
            if (scope && scope === lastRunScope && lastRun) {
                reportArchive.save(scope, lastRun).catch(storageError => console.error('Blackboard private report archive failed; use the saved checkpoint.', storageError));
            }
            if (!cancelled) toastr.error(published
                ? 'Response published, but saving could not be completed. Details: Export last private turn.'
                : saved ? 'Turn saved and paused. Resume it using the Blackboard panel.' : 'Private turn stopped; the unreviewed response was not published. Details: Export last private turn.', 'Objective Blackboard');
        },
    });
}
