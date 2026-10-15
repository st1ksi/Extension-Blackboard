// Diagnostic reports stay outside chat messages, metadata, prompts and vectors.
// Store only the latest attempt and last completion per account/character/chat.
export function openPrivateReportStore(indexedDB = () => globalThis.indexedDB) {
    let database;
    async function db() {
        if (!database) database = new Promise((resolve, reject) => {
            const provider = typeof indexedDB === 'function' ? indexedDB() : indexedDB;
            if (!provider?.open) throw new Error('Browser site storage is unavailable');
            const request = provider.open('objective-blackboard-reports', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('reports', { keyPath: 'key' });
            request.onsuccess = () => {
                const connection = request.result;
                connection.onversionchange = () => { connection.close(); database = null; };
                resolve(connection);
            };
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('Report storage is blocked by another browser tab'));
        }).catch(error => {
            database = null;
            throw new Error(`Could not open private report storage: ${error.message}`, { cause: error });
        });
        return database;
    }
    async function access(mode, action) {
        const connection = await db();
        return new Promise((resolve, reject) => {
            const transaction = connection.transaction('reports', mode);
            const request = action(transaction.objectStore('reports'));
            transaction.oncomplete = () => resolve(request.result);
            transaction.onabort = transaction.onerror = () => reject(transaction.error || request.error || new Error('Private report storage failed'));
        });
    }
    async function update(key, derive) {
        const connection = await db();
        return new Promise((resolve, reject) => {
            // IndexedDB serializes readwrite transactions across connections/tabs.
            // Comparing and putting in separate transactions would race.
            const transaction = connection.transaction('reports', 'readwrite');
            const table = transaction.objectStore('reports');
            const request = table.get(key);
            let changed = false;
            request.onsuccess = () => {
                try {
                    const next = derive(request.result);
                    if (next) { table.put(next); changed = true; }
                } catch (error) { transaction.abort(); reject(error); }
            };
            transaction.oncomplete = () => resolve(changed);
            transaction.onabort = transaction.onerror = () => reject(transaction.error || request.error || new Error('Private report update failed'));
        });
    }
    return { get: key => access('readonly', store => store.get(key)), put: record => access('readwrite', store => store.put(record)), update };
}

export function createPrivateReportArchive({ getContext, getAccount, store = openPrivateReportStore() }) {
    const writes = new Map();
    async function key(ctx = getContext()) {
        // Capture the chat identity before awaiting account lookup.
        const chatId = ctx.chatId ?? ctx.getCurrentChatId?.();
        const owner = ctx.groupId || ctx.characters?.[ctx.characterId]?.avatar;
        if (!chatId || !owner) throw new Error('Select a saved character chat to export its private turn report.');
        const account = await getAccount();
        if (!account) throw new Error('The current SillyTavern user is not available yet.');
        return JSON.stringify([account, owner, chatId]);
    }
    async function save(scope, report) {
        // Snapshot now: a later background callback must not mutate this write.
        const copy = structuredClone(report);
        const started = Number(copy.attempt_started ?? copy.started ?? Date.parse(copy.at ?? '')) || 0;
        const operation = (writes.get(scope) ?? Promise.resolve()).catch(() => {}).then(async () => {
            const derive = previous => previous && previous.attemptStarted > started ? null
                : { version: 1, key: scope, attemptStarted: started, updatedAt: new Date().toISOString(),
                    report: copy, completedReport: copy.status === 'committed' ? copy : previous?.completedReport ?? null };
            if (store.update) return store.update(scope, derive);
            // Injectable non-IDB stores may provide their own atomic update.
            const next = derive(await store.get(scope));
            if (!next) return false;
            await store.put(next);
            return true;
        });
        writes.set(scope, operation);
        try { return await operation; }
        finally { if (writes.get(scope) === operation) writes.delete(scope); }
    }
    async function load(scope) {
        await writes.get(scope);
        const record = await store.get(scope);
        return record?.report ?? record?.completedReport ?? null;
    }
    async function loadCompleted(scope) {
        await writes.get(scope);
        return (await store.get(scope))?.completedReport ?? null;
    }
    return { key, save, load, loadCompleted };
}

// Older releases saved statistics and one final board, not the audit transcript.
// Export that surviving evidence honestly instead of inventing missing versions.
export function legacyPrivateReport(ctx) {
    const message = [...(ctx.chat ?? [])].reverse().find(item => !item.is_user && !item.is_system && item.extra?.blackboard_review);
    if (!message) return null;
    return { status: 'summary_only', report_kind: 'saved_summary', details_available: false,
        explanation: 'The full private report is unavailable in this browser for this chat. Only saved message data is included; missing audits and intermediate revisions cannot be reconstructed.',
        turn_id: message.extra.blackboard_turn_id ?? null, at: message.gen_finished ?? message.send_date ?? null,
        candidate: message.mes, final_board: message.extra.blackboard_snapshot ?? null,
        review_summary: structuredClone(message.extra.blackboard_review), tool_journal: structuredClone(message.extra.blackboard_tools ?? null) };
}
