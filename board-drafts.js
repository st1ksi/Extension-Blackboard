/** In-memory editor drafts, isolated per chat. Never inject or persist drafts as world state. */
export function createBoardDrafts() {
    const records = new Map();
    let current;
    return {
        sync(scope, latest) {
            let record = records.get(scope);
            if (!record) {
                record = { base: latest, text: latest, conflict: false };
                records.set(scope, record);
            }
            if (record.text === record.base || record.text === latest) {
                record.base = record.text = latest;
            }
            record.conflict = latest !== record.base;
            current = record;
            return record;
        },
        edit(text) { current.text = text; },
        accept(latest) { current.base = current.text = latest; current.conflict = false; },
        get current() { return current; },
    };
}
