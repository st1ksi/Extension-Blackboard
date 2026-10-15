import { createSetupGate } from './setup-gate.js';
import { makePrivateRequest } from './private-api.js';
import { createRecovery, recoveryPanel } from './recovery.js';

// The native Generate call stays alive while this interceptor runs. It owns the
// user message, initial regeneration/swap handling and final UI cleanup.
export function createPrivateInterceptor({ getContext, run, enabled, makeRequest = makePrivateRequest, onStart = () => {}, onFailure = () => {}, recovery = null }) {
    let active = null;
    let options = {};
    const initial = getContext();
    initial.eventSource.on(initial.eventTypes.GENERATION_STARTED, (type, incoming, dryRun) => {
        if (dryRun || ['quiet', 'impersonate'].includes(type)) return;
        options = incoming || {};
        // A second native generation may change the branch before its interceptor.
        if (active) active.abort(new Error('Another generation started; private draft paused.'));
    });
    const interceptor = async function interceptor(_chat, _contextSize, abort, rawType) {
        if (!enabled()) return;
        const type = rawType || 'normal';
        if (!['normal', 'regenerate', 'swipe', 'continue'].includes(type)) return;
        if (!recovery) return await execute(abort, type);
        abort(true);
        try {
            await recovery.withLock(getContext(), async scope => {
                if (await recovery.load(scope)) {
                    await recovery.refresh();
                    throw new Error('A saved private turn exists. Use Resume or Discard draft in the Blackboard panel.');
                }
                await execute(abort, type, null, scope);
            });
        } catch (error) { onFailure(error); }

    };

    interceptor.pause = () => active?.abort(new Error('Private turn paused by user.'));
    interceptor.resume = async () => {
        if (!recovery || active) return;
        try {
            if (!enabled()) throw new Error('Enable Blackboard Private Turns to resume the saved turn.');
            await recovery.withLock(getContext(), async scope => {
                const record = await recovery.load(scope);
                if (!record) return;
                const ctx = getContext();
                await recovery.validate(record, ctx, true);
                ctx.deactivateSendButtons?.();
                try { await execute(() => {}, record.type, record, scope); }
                finally { ctx.activateSendButtons?.(); }
            });
        } catch (error) { onFailure(error); }
    };
    recovery?.bind({ resume: interceptor.resume, pause: interceptor.pause });
    return interceptor;

    async function execute(abort, type, saved = null, scope = null) {
        if (!['normal', 'regenerate', 'swipe', 'continue'].includes(type)) return;
        // Set before any await/error: failure must never fall through to an
        // unreviewed native model call (ST catches interceptor exceptions).
        abort(true);
        if (active) { onFailure(new Error('A private turn is still stopping; retry once it finishes.')); return; }
        const ctx = getContext();
        const controller = new AbortController();
        active = controller;
        const opts = { ...(saved ? {} : options), signal: controller.signal };
        const chat = ctx.chat, metadata = ctx.chatMetadata;
        const connection = JSON.stringify(ctx.chatCompletionSettings);
        const configuration = recovery?.configuration();
        const fingerprint = () => JSON.stringify(chat.map(m => [m.is_user, m.is_system, m.mes, m.swipe_id]));
        const before = fingerprint();
        const assertCurrent = () => {
            controller.signal.throwIfAborted();
            const now = getContext();
            if (now.chat !== chat || now.chatMetadata !== metadata || fingerprint() !== before || now.mainApi !== ctx.mainApi || JSON.stringify(now.chatCompletionSettings) !== connection || recovery?.configuration() !== configuration) {
                throw new Error('Chat or branch changed while preparing private context.');
            }
        };
        const cancel = () => controller.abort(new Error('Private turn cancelled.'));
        const sourceSignal = saved ? null : options.signal;
        sourceSignal?.addEventListener('abort', cancel, { once: true });
        if (sourceSignal?.aborted) cancel();
        const events = ctx.eventTypes;
        ctx.eventSource.on(events.GENERATION_STOPPED, cancel);
        ctx.eventSource.on(events.CHAT_CHANGED, cancel);
        let result, published = false, record = saved;
        try {
            onStart();
            if (type === 'continue') throw new Error('Private review: use a new message or regenerate instead of Continue.');
            if (ctx.groupId) throw new Error('Private review currently supports single-character chats.');
            if (ctx.mainApi !== 'openai' || !ctx.canPerformToolCalls(type)) throw new Error('Private review requires Chat Completion with function tools enabled.');
            if (typeof ctx.saveReply !== 'function' || typeof ctx.generate !== 'function') throw new Error('This SillyTavern version lacks the required extension API.');
            assertCurrent();
            const request = await makeRequest(ctx, {
                onWait: async wait => {
                    if (record) { record.wait = wait; (record.networkRetries ??= []).push({ ...wait, at: Date.now() }); await recovery.write(record); }
                },
            });
            // Stock dry-run builds card, lorebook, persona, prompt-manager and
            // extension injections, without requesting a model or saving a reply.
            let messages = record?.messages;
            const collect = (data, dryRun) => { if (dryRun && Array.isArray(data?.prompt)) messages = structuredClone(data.prompt); };
            if (!messages) {
                ctx.eventSource.on(events.GENERATE_AFTER_DATA, collect);
                try { await ctx.generate(type, opts, true); }
                finally { ctx.eventSource.removeListener(events.GENERATE_AFTER_DATA, collect); }
            }
            assertCurrent();
            if (!messages?.length) throw new Error('SillyTavern did not produce a Chat Completion prompt.');
            if (recovery) {
                if (!record) {
                    await ctx.saveChat(); // Persist the triggering message before any paid request.
                    assertCurrent();
                    record = await recovery.create(ctx, type, messages, scope);
                }
                record.status = 'running'; delete record.error; delete record.wait;
                if (saved) record.resumes = (record.resumes || 0) + 1;
                await recovery.write(record);
                await recovery.running(record, true);
            }
            result = await run({ type, dryRun: false, api: ctx.mainApi, canTools: true,
                messages, signal: controller.signal, assertCurrent,
                recoveryInfo: record ? { id: record.id, resumes: record.resumes || 0, networkRetries: record.networkRetries ??= [] } : null,
                checkpoint: record?.checkpoint,
                saveCheckpoint: async checkpoint => {
                    if (record) { record.checkpoint = checkpoint; await recovery.write(record); }
                },
                onProgress: (phase, revision, stage) => { if (record) { record.phase = phase; record.auditStage = stage; } },
                request: async (prompt, allowed) => {
                    assertCurrent();
                    const response = await request(prompt, allowed, controller.signal);
                    if (record) delete record.wait;
                    // The transaction persists the received response before its
                    // guard runs, so later local cancellation cannot reroll tools.
                    return response;
                },
                invoke: (name, args) => ctx.ToolManager.invokeFunctionTool(name, JSON.stringify(args)),
            });
            if (!result) throw new Error('Private review was disabled during generation; retry the turn.');
            assertCurrent();
            if (record) { record.status = 'publishing'; await recovery.write(record); }
            await result.commit();
            const candidate = result.data.choices[0].message.content;
            const length = chat.length, last = chat.at(-1), oldText = last?.mes;
            try {
                await ctx.saveReply({ type, getMessage: candidate });
                published = true;
            } finally {
                // Native message listeners can throw after publication. Never
                // roll the canonical board back under an already visible reply.
                if (chat.length !== length || (last && last.mes !== oldText)) published = true;
            }
            if (record && chat.at(-1)) {
                const last = chat.at(-1);
                last.extra ??= {}; last.extra.blackboard_turn_id = record.id;
                if (last.swipe_info?.[last.swipe_id]) {
                    last.swipe_info[last.swipe_id].extra ??= {};
                    last.swipe_info[last.swipe_id].extra.blackboard_turn_id = record.id;
                }
            }
            await ctx.saveChat();
            if (record) { record.status = 'published'; await recovery.write(record); }
            await result.afterSave();
            if (getContext().chat === chat && getContext().chatMetadata === metadata) await ctx.saveChat();
            if (record) await recovery.remove(record);
        } catch (error) {
            if (!published) result?.rollback();
            if (record) {
                record.status = published ? 'published' : 'paused';
                record.error = String(error.message);
                delete record.wait;
                try { await recovery.write(record); }
                catch (storageError) { console.error('Blackboard checkpoint write failed', storageError); }
            }
            onFailure(error, { published, cancelled: controller.signal.aborted, saved: !!record?.checkpoint, scope: record?.key ?? scope });
        } finally {
            result?.release();
            ctx.eventSource.removeListener(events.GENERATION_STOPPED, cancel);
            ctx.eventSource.removeListener(events.CHAT_CHANGED, cancel);
            sourceSignal?.removeEventListener('abort', cancel);
            if (active === controller) active = null;
            if (record) await recovery.running(record, false).catch(console.error);
        }
    }
}

export function registerBlackboardPrivateRunner(run, options) {
    const getContext = () => SillyTavern.getContext();
    const recovery = createRecovery({ getContext, ...options.recovery,
        getAccount: async () => (await import('../../../user.js')).getCurrentUserHandle(), render: recoveryPanel() });
    const privateInterceptor = createPrivateInterceptor({
        getContext, run, ...options, recovery,
    });
    globalThis.objectiveBlackboardPrivateGeneration = withSetupGate(privateInterceptor, { getContext, ...options.setup }, options.onFailure);
}

export function withSetupGate(privateInterceptor, setup, onFailure = () => {}) {
    const guard = createSetupGate(setup);
    let generationOptions = {};
    const context = setup.getContext();
    context.eventSource.on(context.eventTypes.GENERATION_STARTED, (_type, options, dryRun) => {
        if (!dryRun) generationOptions = { ...options };
    });
    return async (chat, size, abort, rawType) => {
        const before = setup.getContext();
        const api = before.mainApi;
        const toolsAvailable = !!before.isToolCallingSupported?.();
        const options = generationOptions;
        try {
            if (!await guard(rawType || 'normal', abort)) return;
            const after = setup.getContext();
            // Generate captures canPerformToolCalls before extension interceptors.
            // Rebuild that native frame if setup changed its tool availability.
            // depth=1 skips user insertion and destructive regeneration setup,
            // exactly as ST's own tool-followup generation does.
            if (api !== after.mainApi || toolsAvailable !== !!after.isToolCallingSupported?.()) {
                abort(true);
                await after.generate(rawType, { ...options, depth: 1 });
                return;
            }
            await privateInterceptor(chat, size, abort, rawType);
        } catch (error) {
            abort(true); onFailure(error);
        }
    };
}
