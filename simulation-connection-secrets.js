// Opaque secret IDs may belong to connection profiles. Secret values belong
// exclusively to SillyTavern's server-side vault, never Blackboard preferences.
export function getSimulationSecretKey(source, settings, secretKeys) {
    if (source === 'vertexai') return settings?.vertexai_auth_mode === 'full'
        ? secretKeys.VERTEXAI_SERVICE_ACCOUNT ?? null : secretKeys.VERTEXAI ?? null;
    return secretKeys[String(source).toUpperCase()] ?? null;
}

const profileFrom = (context, id) => context.extensionSettings?.connectionManager?.profiles?.find(profile => profile.id === id);
const chatId = context => context.chatId ?? context.getCurrentChatId?.();
let pendingKeySaves = 0;
export const isSimulationKeySavePending = () => pendingKeySaves > 0;

// Resumed private work marks the UI generating without setting ST's native
// is_send_press flag. Both signals must exclude temporary vault key rotation.
export function assertSimulationKeyWritable({ isGenerating = () => false, document = globalThis.document } = {}) {
    if (isGenerating() || document?.body?.dataset?.generating === 'true') {
        throw new Error('Wait for the current generation to finish before saving a connection key.');
    }
}

/** Save an additional vault entry and bind its ID without changing active keys. */
export async function saveSimulationProfileSecret({ getContext, getProfileId, getViewKey = () => '', value,
    secretKeys, readState, refreshState = async () => {}, resolveConnection, fetchRequest = fetch,
    persistProfile = async context => context.saveSettingsDebounced(), assertWritable = () => {} }) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Enter an API key before saving.');
    const context = getContext(), profileId = getProfileId(), viewKey = getViewKey();
    const profile = profileFrom(context, profileId);
    if (!profileId || !profile) throw new Error('Select an available simulation connection profile first.');
    if (typeof context.saveSettingsDebounced !== 'function') throw new Error('This SillyTavern version cannot save connection-profile changes.');
    const originalProfile = JSON.stringify(profile), originalChatId = chatId(context);
    const originalSettings = context.extensionSettings, originalChat = context.chat, originalMetadata = context.chatMetadata;
    const current = () => {
        const now = getContext();
        if (getProfileId() !== profileId || getViewKey() !== viewKey || now.extensionSettings !== originalSettings
            || now.chat !== originalChat || now.chatMetadata !== originalMetadata || chatId(now) !== originalChatId
            || profileFrom(now, profileId) !== profile || JSON.stringify(profile) !== originalProfile) {
            throw new Error('The chat, scope or connection profile changed. The key was not assigned; choose the intended profile and save again.');
        }
    };
    const connection = await resolveConnection(context, profileId);
    current();
    const key = getSimulationSecretKey(connection.descriptor.source, connection.settings, secretKeys);
    if (!key) throw new Error('This connection does not expose a supported SillyTavern API-key store. Manage its credentials in SillyTavern.');
    const post = async (path, body) => {
        try {
            const response = await fetchRequest(path, { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify(body) });
            if (!response.ok) throw new Error();
            return response;
        } catch { throw new Error('The SillyTavern key store could not complete the request. Try again.'); }
    };
    const metadata = async () => {
        const state = await readState();
        if (!state || !Object.hasOwn(state, key) || !(state[key] === null || Array.isArray(state[key]))) throw new Error();
        return state;
    };
    let state;
    try { state = await metadata(); }
    catch { throw new Error('Could not read SillyTavern key-store metadata. No key was saved.'); }
    const previousId = Array.isArray(state?.[key]) ? state[key].find(secret => secret.active)?.id : null;
    current();
    // Resolving the profile and reading metadata can yield to Resume/Generate.
    // Check again immediately before the only write that activates a new key.
    assertWritable();
    let id, writeError, restoreError;
    try {
        const response = await post('/api/secrets/write', { key, value: value.trim(), label: `Simulation Blackboard: ${connection.descriptor.name}` });
        try { id = (await response.json()).id; } catch { /* Never expose a response body containing credentials. */ }
        if (typeof id !== 'string' || !id) throw new Error('The key store did not confirm a saved key. The profile was not changed.');
    } catch (error) { writeError = error; }
    finally {
        // Writing activates the new entry in ST. Restore an existing default
        // before refreshing its UI or assigning the new ID to the profile.
        if (previousId) {
            try { await post('/api/secrets/rotate', { key, id: previousId }); }
            catch { restoreError = new Error('The key store could not restore the previous active key. The profile was not changed. Check this provider’s active key in SillyTavern before continuing.'); }
        }
        // The native rotate endpoint can acknowledge a missing ID as a no-op.
        // Verify metadata instead of treating its HTTP success as restoration.
        if (!restoreError && (previousId || id)) {
            try {
                const confirmed = await metadata();
                if (confirmed[key]?.find(secret => secret.active)?.id !== (previousId || id)) throw new Error();
            } catch { restoreError = new Error('The key store could not confirm the active key. The profile was not changed. Check this provider’s active key in SillyTavern before continuing.'); }
        }
        try { await refreshState(); } catch { /* A vault error below remains actionable without logging secrets. */ }
    }
    if (restoreError) throw restoreError;
    if (writeError) throw writeError;
    current();
    // A first vault entry intentionally changes the implicit active key. Compare
    // connection configuration while allowing that credential-only difference.
    const latestConnection = await resolveConnection(getContext(), profileId);
    current();
    if (JSON.stringify(latestConnection.settings) !== JSON.stringify(connection.settings)
        || JSON.stringify(latestConnection.descriptor) !== JSON.stringify(connection.descriptor)) {
        throw new Error('The simulation connection settings changed. The key was not assigned; choose the intended profile and save again.');
    }
    const previousSecret = profile['secret-id'], previousExclude = profile.exclude;
    profile['secret-id'] = id;
    if (Array.isArray(profile.exclude)) profile.exclude = profile.exclude.filter(field => field !== 'secret-id');
    const assignedExclude = JSON.stringify(profile.exclude);
    try { await persistProfile(context, profileId, id); }
    catch {
        if (profile['secret-id'] === id) {
            if (previousSecret === undefined) delete profile['secret-id']; else profile['secret-id'] = previousSecret;
            if (JSON.stringify(profile.exclude) === assignedExclude) {
                if (previousExclude === undefined) delete profile.exclude; else profile.exclude = previousExclude;
            }
        }
        throw new Error('The key is in SillyTavern’s key store, but its profile could not be saved. Select it through Connection Manager.');
    }
    return { id, firstKey: !previousId };
}

async function runtimeSave(options) {
    const [secrets, connection, script] = await Promise.all([import('../../../secrets.js'), import('./simulation-connection.js'), import('../../../../script.js')]);
    const assertWritable = () => assertSimulationKeyWritable({ isGenerating: script.isGenerating });
    assertWritable();
    return saveSimulationProfileSecret({ ...options, secretKeys: secrets.SECRET_KEYS,
        assertWritable,
        resolveConnection: connection.resolveSimulationConnection,
        readState: async () => {
            const context = options.getContext();
            const response = await fetch('/api/secrets/read', { method: 'POST', headers: context.getRequestHeaders({ omitContentType: true }) });
            if (!response.ok) throw new Error('Unavailable');
            return response.json();
        }, refreshState: secrets.readSecretState,
        persistProfile: async (context, profileId, id) => {
            await script.saveSettings();
            const response = await fetch('/api/settings/get', { method: 'POST', headers: context.getRequestHeaders(), body: '{}', cache: 'no-cache' });
            if (!response.ok) throw new Error();
            const result = await response.json();
            const stored = typeof result.settings === 'string' ? JSON.parse(result.settings) : result.settings;
            const saved = stored?.extension_settings?.connectionManager?.profiles?.find(profile => profile.id === profileId);
            if (saved?.['secret-id'] !== id || saved.exclude?.includes('secret-id')) throw new Error();
        } });
}

/** This password input is deliberately outside the generic settings mirror. */
export function installSimulationSecretControl({ panel, getContext, getSettings, getViewKey = () => '', saveSecret = runtimeSave }) {
    const input = panel.querySelector('[data-bb-simulation-key]');
    const button = panel.querySelector('[data-bb-save-simulation-key]');
    const status = panel.querySelector('[data-bb-simulation-key-status]');
    if (!input || !button || !status) return { refresh() {} };
    let identity, busy = false, generation = 0, generating = false;
    const selection = () => {
        const context = getContext(), settings = getSettings(), id = settings.simulationConnectionProfile;
        const profile = profileFrom(context, id), api = context.CONNECT_API_MAP?.[profile?.api];
        return { id, profile, enabled: !generating && globalThis.document?.body?.dataset?.generating !== 'true'
            && !!settings.functionTool && !!settings.separateNarration && !!id && !!profile
            && !context.extensionSettings?.disabledExtensions?.includes('connection-manager') && profile.mode !== 'tc'
            && api?.selected === 'openai' };
    };
    const clear = () => { input.value = ''; status.textContent = ''; generation++; };
    function refresh() {
        const selected = selection();
        const next = JSON.stringify([selected.id, getViewKey(), selected.enabled, selected.profile]);
        if (next !== identity) { identity = next; clear(); }
        input.disabled = busy || !selected.enabled;
        button.disabled = busy || !selected.enabled || !input.value.trim();
    }
    input.addEventListener('input', refresh);
    panel.addEventListener('bb-panel-close', clear);
    const context = getContext();
    for (const name of ['GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED']) {
        const event = context.eventTypes?.[name];
        if (event) context.eventSource?.on(event, (_type, _options, dryRun) => {
            if (name === 'GENERATION_STARTED' && dryRun) return;
            generating = name === 'GENERATION_STARTED'; refresh();
        });
    }
    button.addEventListener('click', async () => {
        const selected = selection();
        if (busy || !selected.enabled || !input.value.trim()) return;
        const value = input.value;
        input.value = ''; busy = true; pendingKeySaves++; const token = generation;
        status.textContent = 'Saving to SillyTavern’s key store…'; refresh();
        try {
            const result = await saveSecret({ getContext, getProfileId: () => getSettings().simulationConnectionProfile, getViewKey, value });
            if (token === generation) {
                refresh();
                status.textContent = result.firstKey
                    ? 'Saved in SillyTavern’s key store and assigned to this profile. This provider’s first key is also its default.'
                    : 'Saved in SillyTavern’s key store and assigned to this profile. Its previous default key is unchanged.';
            }
        } catch (error) { if (token === generation) status.textContent = String(error.message); }
        finally { pendingKeySaves--; busy = false; input.value = ''; refresh(); }
    });
    refresh();
    return { refresh };
}
