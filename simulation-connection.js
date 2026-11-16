import { getSimulationSecretKey } from './simulation-connection-secrets.js';

// Connection profiles select transport and sampling settings only. The active
// chat still owns its assembled card, lorebook, preset instructions and history.
// Snapshot settings stay in memory; only descriptor + fingerprint may be saved.
const own = (value, key) => Object.hasOwn(value ?? {}, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
// ST 1.19.0's Chat Completion tool-capable backends. The provider's actual model
// must still support function tools; absence from the narrator's unrelated model
// catalog is not evidence that a sidecar model lacks them.
const toolSources = new Set(['openai', 'custom', 'mistralai', 'claude', 'openrouter', 'aimlapi', 'groq',
    'cohere', 'deepseek', 'makersuite', 'vertexai', 'ai21', 'xai', 'pollinations', 'moonshot',
    'fireworks', 'cometapi', 'chutes', 'electronhub', 'azure_openai', 'zai', 'siliconflow',
    'nanogpt', 'workers_ai', 'minimax']);

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!object(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function serialized(value) { return JSON.stringify(canonical(value)); }

async function fingerprint(value, crypto = globalThis.crypto) {
    if (!crypto?.subtle) throw new Error('Simulation connections require a secure browser with Web Crypto.');
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized(value)));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function effectiveProfile(profile) {
    const result = structuredClone(profile);
    for (const key of result.exclude ?? []) delete result[key];
    return result;
}

function profileInputs(context, profileId, getPreset, proxies) {
    if (context.extensionSettings?.disabledExtensions?.includes('connection-manager')) {
        throw new Error('Enable Connection Manager to use a separate simulation connection.');
    }
    const profiles = context.extensionSettings?.connectionManager?.profiles;
    const saved = Array.isArray(profiles) && profiles.find(profile => profile.id === profileId);
    if (!saved) throw new Error('The selected simulation connection profile no longer exists. Select another profile or use the current connection.');
    const profile = effectiveProfile(saved);
    const api = context.CONNECT_API_MAP?.[profile.api];
    if (profile.mode === 'tc' || api?.selected !== 'openai' || !api.source) {
        throw new Error('Simulation requires a Chat Completion connection profile with function tools. Text Completion profiles are not supported.');
    }
    if (typeof profile.model !== 'string' || !profile.model.trim()) throw new Error('Save a model in the selected simulation connection profile.');
    if (typeof profile.preset !== 'string' || !profile.preset.trim()) throw new Error('Save a Chat Completion settings preset in the selected simulation connection profile.');
    const preset = getPreset(profile.preset);
    if (!object(preset)) throw new Error('The selected simulation connection settings preset no longer exists. Save the profile with an available preset.');
    let proxy;
    if (own(profile, 'proxy')) {
        proxy = (typeof proxies === 'function' ? proxies() : proxies).find(item => item.name === profile.proxy);
        if (!proxy) throw new Error('The selected simulation connection proxy preset no longer exists.');
    }
    // Endpoint decorators (including subscription adapters) are global extension
    // preferences. Detect changes while a turn is in flight or before Resume.
    const subscriptions = api.source === 'custom' ? context.extensionSettings?.subscriptions : undefined;
    return structuredClone({ profile, api, preset, proxy, subscriptions });
}

/** Pure snapshot builder with injectable ST dependencies for verification. */
export async function buildSimulationConnection({ context, profileId, settings, settingsToUpdate, getPreset, proxies = [], getActiveSecretId = () => null, crypto }) {
    const inputs = profileInputs(context, profileId, getPreset, proxies);
    const { profile, api, preset, proxy } = inputs;
    const resolved = structuredClone(settings);
    // Imported presets may intentionally omit connection details. They must not
    // inherit the narrator's proxy password, custom Authorization or body rules.
    for (const field of ['reverse_proxy', 'proxy_password', 'custom_url', 'custom_include_headers',
        'custom_include_body', 'custom_exclude_body', 'custom_prompt_post_processing', 'azure_base_url', 'azure_deployment_name', 'azure_api_version',
        'vertexai_express_project_id', 'workers_ai_account_id']) {
        resolved[field] = '';
    }
    // Mirror SillyTavern's preset conversion before createGenerationParameters:
    // provider-specific parameters must be calculated for the selected provider.
    for (const [key, value] of Object.entries(preset)) {
        const mapping = settingsToUpdate[key];
        if (mapping) resolved[mapping[1]] = structuredClone(value);
    }
    // ST's logit-bias calculator reads the globally active model/cache. Using it
    // for a sidecar can apply the narrator's token IDs to a different tokenizer.
    resolved.bias_preset_selected = '';
    resolved.chat_completion_source = api.source;
    resolved[api.source === 'makersuite' ? 'google_model' : `${api.source}_model`] = profile.model;
    resolved.stream_openai = false;
    resolved.n = 1;
    resolved.function_calling = true;
    if (['claude', 'makersuite', 'vertexai'].includes(api.source)) resolved.use_sysprompt = true;
    if (!toolSources.has(api.source)
        || (['openai', 'azure_openai'].includes(api.source) && /^gpt-6-astra/.test(profile.model))) {
        throw new Error('The selected simulation connection does not support function tools through this Chat Completion route. Choose a tool-capable connection.');
    }
    if (own(profile, 'api-url')) {
        const fields = { custom: 'custom_url', vertexai: 'vertexai_region', zai: 'zai_endpoint',
            siliconflow: 'siliconflow_endpoint', minimax: 'minimax_endpoint', pollinations: 'pollinations_endpoint' };
        const field = fields[api.source];
        if (field) resolved[field] = profile['api-url'];
    }
    if (own(profile, 'prompt-post-processing')) resolved.custom_prompt_post_processing = profile['prompt-post-processing'];
    // This field exists on every ST request. Non-Custom providers must not
    // inherit a Custom narrator's tool-stripping post-processing mode.
    if (api.source !== 'custom') resolved.custom_prompt_post_processing = '';
    if (!['', 'merge_tools', 'semi_tools', 'strict_tools'].includes(resolved.custom_prompt_post_processing ?? '')) {
        throw new Error('The simulation connection must use prompt post-processing that preserves tools: None, Merge tools, Semi-strict tools, or Strict tools.');
    }
    // Native metadata for the currently active provider can identify a known
    // unsupported model. A different provider has a different model catalog.
    if (settings.chat_completion_source === api.source && context.ToolManager?.isToolCallingSupported
        && !context.ToolManager.isToolCallingSupported(resolved, profile.model)) {
        throw new Error('The selected simulation model does not support function tools in SillyTavern. Choose a tool-capable model.');
    }
    if (api.source === 'custom' && !resolved.custom_url) throw new Error('Save the custom API URL in the selected simulation connection profile or its settings preset.');
    if (proxy) { resolved.reverse_proxy = proxy.url || ''; resolved.proxy_password = proxy.password || ''; }
    // A secret selector is an opaque server-side ID, never an API key. Keep it
    // out of the descriptor and fingerprint changes without exporting its value.
    const explicitSecret = typeof profile['secret-id'] === 'string' && !!profile['secret-id'];
    const activeSecret = () => resolved.reverse_proxy ? null : getActiveSecretId(api.source, resolved) ?? null;
    const secretId = explicitSecret ? profile['secret-id'] : activeSecret();
    const payloadOverrides = secretId ? { secret_id: secretId } : {};
    if (resolved.reverse_proxy && ['claude', 'openai', 'mistralai', 'makersuite', 'vertexai', 'deepseek', 'xai', 'zai', 'moonshot'].includes(api.source)) {
        payloadOverrides.reverse_proxy = resolved.reverse_proxy;
        payloadOverrides.proxy_password = resolved.proxy_password;
    }
    const descriptor = { kind: 'profile', profileId, name: String(profile.name || profileId),
        source: api.source, model: profile.model, preset: profile.preset };
    const serializedInputs = serialized(inputs);
    const connection = { settings: resolved, model: profile.model, payloadOverrides, descriptor,
        fingerprint: await fingerprint({ inputs, settings: resolved, secretId }, crypto),
        assertCurrent() {
            let current;
            try { current = profileInputs(context, profileId, getPreset, proxies); }
            catch { throw new Error('The simulation connection profile or its settings changed. Restore them to resume the saved turn.'); }
            if (serialized(current) !== serializedInputs) throw new Error('The simulation connection profile or its settings changed. Restore them to resume the saved turn.');
            if (!explicitSecret && activeSecret() !== secretId) {
                throw new Error('The simulation connection active API key changed. Restore the saved key selection to resume this turn.');
            }
        },
    };
    return connection;
}

/** Resolve a profile without applying it to global ST settings or its UI. */
export async function resolveSimulationConnection(context, profileId, dependencies) {
    if (!profileId) return null;
    if (dependencies) return buildSimulationConnection({ context, profileId, ...dependencies });
    const [api, presets, secrets] = await Promise.all([import('../../../openai.js'), import('../../../preset-manager.js'), import('../../../secrets.js')]);
    return buildSimulationConnection({ context, profileId, settings: api.oai_settings,
        settingsToUpdate: api.settingsToUpdate, proxies: () => api.proxies,
        getActiveSecretId: (source, settings) => {
            const key = getSimulationSecretKey(source, settings, secrets.SECRET_KEYS);
            const choices = key && secrets.secret_state?.[key];
            return Array.isArray(choices) ? choices.find(choice => choice.active)?.id ?? null : null;
        },
        getPreset: name => presets.getPresetManager('openai').getCompletionPresetByName(name) });
}
