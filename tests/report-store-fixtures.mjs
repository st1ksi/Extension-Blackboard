// Small asynchronous IndexedDB double for private report persistence tests.
// Each provider survives extension reinitialization, like browser site storage.
export function reportDatabase() {
    const databases = new Map();
    const transactionTails = new Map();
    const provider = {
        error: null,
        databases,
        open(name) {
            const request = {};
            queueMicrotask(() => {
                if (provider.error) {
                    request.error = provider.error;
                    request.onerror?.();
                    return;
                }
                const fresh = !databases.has(name);
                if (fresh) databases.set(name, new Map());
                const stores = databases.get(name);
                request.result = {
                    createObjectStore(store) { stores.set(store, new Map()); },
                    close() {},
                    transaction(store) {
                        const scope=JSON.stringify([name,store]);
                        const ready=transactionTails.get(scope) ?? Promise.resolve();
                        let pending=0, finished=false, finish;
                        const done=new Promise(resolve=>{finish=resolve;});
                        transactionTails.set(scope,done);
                        const complete=()=>queueMicrotask(()=>{
                            if(finished || pending)return;
                            finished=true;transaction.oncomplete?.();finish();
                        });
                        const fail=(error,request)=>{
                            if(finished)return;
                            finished=true;transaction.error=error;if(request)request.error=error;
                            request?.onerror?.();transaction.onerror?.();transaction.onabort?.();finish();
                        };
                        const transaction = {
                            abort() { fail(transaction.error ?? new Error('Test transaction aborted')); },
                            objectStore() {
                                const table = stores.get(store);
                                const action = (operation) => {
                                    const result = {};
                                    pending++;
                                    ready.then(async () => {
                                        if(finished)return;
                                        if (provider.error) {
                                            fail(provider.error,result);
                                            return;
                                        }
                                        try { result.result = structuredClone(await operation(table)); }
                                        catch (error) { fail(error,result); return; }
                                        try { result.onsuccess?.(); }
                                        catch(error) { fail(error,result);return; }
                                        pending--;
                                        complete();
                                    });
                                    return result;
                                };
                                return {
                                    get: key => action(async table => { await provider.beforeGet?.(key); return table.get(key); }),
                                    put: record => action(table => { table.set(record.key, structuredClone(record)); return record.key; }),
                                    delete: key => action(table => table.delete(key)),
                                };
                            },
                        };
                        ready.then(complete);
                        return transaction;
                    },
                };
                if (fresh) request.onupgradeneeded?.();
                request.onsuccess?.();
            });
            return request;
        },
    };
    return provider;
}

export function memoryReportStore() {
    const records = new Map();
    const store = {
        error: null,
        records,
        async get(key) { if (store.error) throw store.error; return structuredClone(records.get(key)); },
        async put(record) { if (store.error) throw store.error; records.set(record.key, structuredClone(record)); },
        async delete(key) { if (store.error) throw store.error; records.delete(key); },
    };
    return store;
}
