// Preferences belong either to the user's defaults or to this chat's metadata.
// Scope bookkeeping never enters the effective settings / private-turn digest.
export const CHAT_SETTINGS_KEY = 'blackboard_settings';

export function createCampaignSettings({ getContext, defaults, migrate = () => {}, normalize = () => {}, onSaveError = console.error }) {
    const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
    const metadata = context => context.chatMetadata ?? context.chat_metadata;
    const chatId = context => context.chatId ?? context.getCurrentChatId?.();
    const available = context => isObject(metadata(context)) && chatId(context) != null && chatId(context) !== '';

    function initialize(value) {
        migrate(value);
        for (const key of Object.keys(defaults)) {
            if (!Object.hasOwn(value, key)) value[key] = structuredClone(defaults[key]);
        }
        normalize(value);
        return value;
    }
    function global(context = getContext()) {
        context.extensionSettings ??= {};
        if (!isObject(context.extensionSettings.blackboard)) context.extensionSettings.blackboard = structuredClone(defaults);
        return initialize(context.extensionSettings.blackboard);
    }
    function record(context) {
        const saved = metadata(context)?.[CHAT_SETTINGS_KEY];
        if (!saved) return null;
        if (saved.version !== 1 || !isObject(saved.values)) {
            if (saved.enabled) throw new Error('This chat has unsupported Blackboard settings. Restore a compatible extension version before continuing.');
            return null;
        }
        return saved;
    }
    function get() {
        const context = getContext();
        const saved = available(context) && record(context);
        return saved?.enabled ? initialize(saved.values) : global(context);
    }
    function status() {
        const context = getContext();
        const canUseChat = available(context);
        const saved = canUseChat && record(context);
        return { scope: saved?.enabled ? 'chat' : 'global', available: canUseChat,
            retained: !!saved, chatId: chatId(context) ?? null };
    }
    function saveMetadata(context) {
        if (typeof context.saveMetadata === 'function') return context.saveMetadata();
        if (typeof context.saveMetadataDebounced === 'function') return context.saveMetadataDebounced();
        if (typeof context.saveChatDebounced === 'function') return context.saveChatDebounced();
        throw new Error('This SillyTavern version cannot save chat-specific Blackboard settings.');
    }
    function save() {
        const context = getContext();
        const saved = available(context) && record(context);
        if (saved?.enabled) return saveMetadata(context);
        return context.saveSettingsDebounced?.();
    }
    function setScope(scope) {
        if (!['global', 'chat'].includes(scope)) throw new Error('Unknown Blackboard settings scope.');
        const context = getContext();
        if (!available(context)) {
            if (scope === 'global') return global(context);
            throw new Error('Open a saved chat before enabling chat-specific Blackboard settings.');
        }
        let saved = record(context);
        if (scope === 'chat' && !saved) {
            saved = { version: 1, enabled: true, values: structuredClone(global(context)) };
            metadata(context)[CHAT_SETTINGS_KEY] = saved;
        } else if (saved) {
            saved.enabled = scope === 'chat';
        } else return global(context);
        Promise.resolve(saveMetadata(context)).catch(onSaveError);
        return get();
    }
    function resetChat() {
        const context = getContext();
        if (!available(context)) throw new Error('Open a saved chat before copying global defaults.');
        metadata(context)[CHAT_SETTINGS_KEY] = { version: 1, enabled: true, values: structuredClone(global(context)) };
        Promise.resolve(saveMetadata(context)).catch(onSaveError);
        return get();
    }
    function viewKey() {
        const context = getContext();
        if (status().scope === 'global') return 'global';
        const actor = context.groupId ?? context.characters?.[context.characterId]?.avatar ?? context.characterId;
        return JSON.stringify(['chat', actor, chatId(context)]);
    }
    return { get, global, status, save, setScope, resetChat, viewKey };
}
