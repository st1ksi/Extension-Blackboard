// Private checkpoints never enter chat messages, metadata or vector storage.
// IndexedDB is scoped to this browser origin; Web Locks exclude concurrent tabs.
import { stageLabel } from './review.js';
import { privateTurnCapabilities } from './capabilities.js';
import { normalizePrivateReviewMode, privateReviewModeLabel } from './private-modes.js';
export function openCheckpointStore(indexedDB = () => globalThis.indexedDB) {
    let database;
    async function db() {
        if (!database) database = new Promise((resolve, reject) => {
            const provider = typeof indexedDB === 'function' ? indexedDB() : indexedDB;
            const request = provider.open('objective-blackboard-private', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('turns', { keyPath: 'key' });
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        }).catch(error => {
            database = null;
            throw new Error(`Could not open private checkpoint storage. Check browser site-storage permissions: ${error.message}`, { cause: error });
        });
        return database;
    }
    async function access(mode, action) {
        const connection = await db();
        return new Promise((resolve, reject) => {
            const transaction = connection.transaction('turns', mode);
            const request = action(transaction.objectStore('turns'));
            transaction.oncomplete = () => resolve(request.result);
            transaction.onabort = transaction.onerror = () => reject(transaction.error || request.error || new Error('Checkpoint storage failed.'));
        });
    }
    return { get: key => access('readonly', s => s.get(key)), put: record => access('readwrite', s => s.put(record)), delete: key => access('readwrite', s => s.delete(key)) };
}

export const historyKey = chat => JSON.stringify(chat.map(m => [m.is_user, m.is_system, m.mes, m.swipe_id, m.swipes]));
async function digest(value) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export function downloadCheckpoint(record) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'blackboard-private-checkpoint.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createRecovery({ getContext, getBoard, setBoard, settings, getAccount, environment = globalThis, store = openCheckpointStore(() => environment.indexedDB), locks, render = () => {} }) {
    let actions = {}, visibleKey, activeKey = null;
    async function key(ctx = getContext()) {
        const chatId = ctx.chatId ?? ctx.getCurrentChatId?.();
        const avatar = ctx.characters?.[ctx.characterId]?.avatar;
        if (!chatId || (!avatar && !ctx.groupId)) throw new Error('Select a saved character chat before starting a private turn.');
        return JSON.stringify([await getAccount(), ctx.groupId || avatar, chatId]);
    }
    async function withLock(ctx, callback, requireExecution = true) {
        const capabilities = privateTurnCapabilities(environment);
        if ((requireExecution && !capabilities.supported) || !capabilities.locksAvailable) {
            throw Object.assign(new Error(capabilities.message), { code: 'BLACKBOARD_PRIVATE_UNAVAILABLE' });
        }
        const lockManager = locks ?? environment.navigator.locks;
        const scope = await key(ctx);
        return lockManager.request(`blackboard:${scope}`, { ifAvailable: true }, lock => {
            if (!lock) throw new Error('This turn is already running in another tab.');
            return callback(scope);
        });
    }
    async function write(record) {
        record.updatedAt = new Date().toISOString();
        await store.put(structuredClone(record));
        if (record.key === await key().catch(() => null)) render(record, activeKey === record.key, actions);
    }
    async function create(ctx, type, messages, scope) {
        const record = { version: 1, id: crypto.randomUUID(), key: scope, type, messages,
            reviewMode: normalizePrivateReviewMode(settings().privateReviewMode),
            status: 'running', createdAt: new Date().toISOString(), baseline: getBoard(),
            engine: structuredClone(ctx.chatMetadata.blackboard_engine), history: historyKey(ctx.chat),
            connection: await digest(ctx.chatCompletionSettings), settings: await digest(settings()), checkpoint: null };
        // ST returns a failed pending swipe to the previous answer. Permit only
        // that exact fallback, not arbitrary branch edits or selected swipes.
        const last = ctx.chat.at(-1);
        if (type === 'swipe' && last?.swipe_id === last?.swipes?.length && last.swipes.length) {
            const chat = structuredClone(ctx.chat), fallback = chat.at(-1);
            fallback.swipe_id--;
            fallback.mes = fallback.swipes[fallback.swipe_id];
            record.swipe = { pendingId: last.swipe_id, pendingText: last.mes, history: historyKey(chat),
                board: last.swipe_info?.[fallback.swipe_id]?.extra?.blackboard_snapshot };
        }
        await write(record);
        return record;
    }
    async function validate(record, ctx, restore = false) {
        if (record.version !== 1 || record.key !== await key(ctx)) throw new Error('Checkpoint belongs to another chat or unsupported version.');
        if (['publishing', 'published'].includes(record.status)) throw new Error('Publication has already started. Check the latest message and save the chat; regeneration is blocked to prevent duplicates.');
        const currentSettings = settings();
        let sameSettings = record.settings === await digest(currentSettings);
        // New default/profile and migration-marker fields must not strand old
        // checkpoints. Actual checkbox, fidelity or profile changes still reject.
        const compatibleSettings = [{ ...currentSettings }];
        // Adding the default heavy selector must not invalidate pre-mode saved
        // turns. A real heavy/light change still needs the checkpoint setting.
        if (normalizePrivateReviewMode(currentSettings.privateReviewMode) === 'heavy'
            && normalizePrivateReviewMode(record.checkpoint?.reviewMode) === 'heavy') {
            const previous = { ...currentSettings }; delete previous.privateReviewMode;
            compatibleSettings.push(previous);
        }
        if (currentSettings.executionModeVersion === 1) {
            for (const settings of [...compatibleSettings]) {
                const previous = { ...settings }; delete previous.executionModeVersion;
                compatibleSettings.push(previous);
            }
        }
        if (!record.checkpoint?.draft?.gameSystem && currentSettings.gameSystem === 'dnd5e') {
            for (const settings of [...compatibleSettings]) {
                const previous = { ...settings }; delete previous.gameSystem;
                compatibleSettings.push(previous);
            }
        }
        for (const settings of compatibleSettings) {
            if (sameSettings) break;
            sameSettings = record.settings === await digest(settings);
        }
        if (record.connection !== await digest(ctx.chatCompletionSettings) || !sameSettings) throw new Error('Connection or Blackboard settings have changed. Restore the previous settings to resume the saved turn.');
        const history = historyKey(ctx.chat);
        const fallback = record.swipe && history === record.swipe.history;
        if (history !== record.history && !fallback) throw new Error('History or branch has changed. Return to the original turn or discard its saved draft.');
        if (getBoard() !== record.baseline && !(fallback && getBoard() === record.swipe.board)) throw new Error('Blackboard changed after the turn started. The saved draft has not been applied.');
        if (restore && fallback) {
            ctx.chat.at(-1).swipe_id = record.swipe.pendingId;
            ctx.chat.at(-1).mes = record.swipe.pendingText;
            ctx.chatMetadata.blackboard_engine = structuredClone(record.engine);
            setBoard(record.baseline, { skipSnapshot: true, restore: true });
        }
    }
    async function refresh() {
        const scope = await key().catch(() => null);
        visibleKey = scope;
        const record = scope && privateTurnCapabilities(environment).storageAvailable ? await store.get(scope) : null;
        if (visibleKey === scope) render(record, activeKey === scope, actions);
    }
    const api = { key, withLock, create, validate, write, configuration: () => JSON.stringify(settings()), load: scope => store.get(scope),
        async remove(record) { await store.delete(record.key); await refresh(); },
        async running(record, running) { activeKey = running ? record.key : null; await refresh(); },
        refresh,
        bind(callbacks) {
            actions = { ...callbacks, capabilities: () => privateTurnCapabilities(environment),
                discard: async () => {
                    try {
                        await withLock(getContext(), async scope => {
                            const record = await store.get(scope);
                            if (record && confirm('Discard the saved private turn? Intermediate changes and dice rolls will be lost.')) await api.remove(record);
                        }, false);
                    } catch (e) { toastr.error(e.message, 'Objective Blackboard'); }
                },
                export: async () => { const record = await store.get(await key()); if (record) downloadCheckpoint(record); },
            };
            const ctx = getContext();
            ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => refresh().catch(report));
            refresh().catch(report);
        },
    };
    function report(error) { toastr.error(`Could not read the saved turn: ${error.message}`, 'Objective Blackboard'); }
    return api;
}

export function recoveryPanel() {
    let panel, timer;
    return (record, running, actions) => {
        clearInterval(timer);
        panel?.remove(); panel = null;
        if (!record) return;
        panel = document.createElement('div'); panel.id = 'blackboard-recovery';
        const title = document.createElement('strong'); title.textContent = `Objective Blackboard · ${privateReviewModeLabel(record.checkpoint?.reviewMode ?? record.reviewMode)} Private Turns`; panel.append(title);
        const status = document.createElement('div'); status.style.margin = '8px 0'; panel.append(status);
        const describe = () => {
            const revision = record.checkpoint?.draft?.revision ?? Math.max(0, (record.checkpoint?.draft?.versions?.length ?? 1) - 1);
            const rolls = record.checkpoint?.draft?.rolls?.length ?? 0;
            const issues = record.checkpoint?.issueLedger?.filter(i => !['resolved', 'rejected'].includes(i.status)).length ?? 0;
            const wait = record.wait;
            status.textContent = running
                ? wait && Date.now() < wait.until ? `API temporarily unavailable. Retry ${wait.attempt}/${wait.maxRetries} in ${Math.ceil((wait.until - Date.now()) / 1000)} s.` : `Private turn running · ${record.auditStage ? stageLabel(record.auditStage) + ' · ' + ({ repair: 'repairing issues', verify: 'verifying repairs', detect: 'detecting issues' }[record.phase] || 'review') : record.phase || 'preparing'}.`
                : ['publishing', 'published'].includes(record.status) ? 'Publication started; automatic retry is blocked. Check and save the latest message.'
                    : `Turn saved and paused. Revisions: ${revision}; rolls: ${rolls}; open issues: ${issues}. Resume uses the saved context.`;
        };
        describe(); if (running) timer = setInterval(describe, 1000);
        if (record.error && !running) { const error = document.createElement('div'); error.textContent = record.error; error.style.cssText = 'max-height:90px;overflow:auto;margin-bottom:8px'; panel.append(error); }
        const buttons = running ? [['pause', 'Pause']] : [['resume', 'Resume'], ['discard', 'Discard draft']];
        buttons.push(['export', 'Export']);
        const capabilities = actions.capabilities?.();
        if (!running && capabilities && !capabilities.supported) {
            const notice = document.createElement('div');
            notice.textContent = capabilities.message;
            notice.style.marginBottom = '8px';
            panel.append(notice);
        }
        for (const [action, label] of buttons) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'menu_button'; button.dataset.action = action; button.textContent = label;
            if (action === 'resume' && (['publishing', 'published'].includes(record.status) || (record.checkpoint?.haltReason && record.checkpoint.haltKind !== 'format'))) {
                button.disabled = true;
                button.title = record.checkpoint?.haltReason || 'Publication cannot be retried';
            }
            if (action === 'resume' && capabilities && !capabilities.supported) {
                button.disabled = true;
                button.title = capabilities.message;
            }
            button.onclick = () => Promise.resolve(actions[action]?.()).catch(e => toastr.error(e.message, 'Objective Blackboard'));
            panel.append(button);
        }
        document.body.append(panel);
    };
}
