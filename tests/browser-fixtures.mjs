// Browser feature surface; actual locks/storage are injected by each test.
export function browserEnvironment(overrides = {}) {
    return {
        isSecureContext: true,
        navigator: { locks: { request: async (_name, _options, callback) => callback({}) } },
        indexedDB: { open() { throw new Error('Test must provide checkpoint storage'); } },
        crypto: globalThis.crypto,
        ...overrides,
    };
}
