// Hold the native generation before the model request. Resume the same call;
// never re-send the user message or restart a swipe/regeneration.
export function setupRequirements(context, type = 'normal') {
    const settings = context.chatCompletionSettings ?? {};
    const missing = [];
    const blockers = [];
    if (context.mainApi !== 'openai') blockers.push('Select a Chat Completion connection that supports function calling.');
    else {
        if (!settings.function_calling) missing.push('Enable function calling');
        if (['claude', 'makersuite', 'vertexai'].includes(settings.chat_completion_source) && !settings.use_sysprompt) missing.push('Use system prompt');
        if (settings.function_calling && !context.isToolCallingSupported?.()) blockers.push('The selected model or request configuration does not support function calling. Choose a supported model/configuration.');
        if (type === 'continue') blockers.push('SillyTavern does not call tools for Continue. Use a new message or Regenerate, or disable Simulation Blackboard for this generation.');
    }
    return { missing, blockers, ready: !missing.length && !blockers.length };
}

export function setupPanel() {
    const panel = document.createElement('div');
    panel.id = 'blackboard-setup-required';
    panel.setAttribute('role', 'alert');
    const title = document.createElement('strong');
    title.textContent = 'Simulation Blackboard — setup required';
    const description = document.createElement('div');
    const list = document.createElement('ul');
    const buttons = document.createElement('div');
    buttons.className = 'blackboard-setup-actions';
    panel.append(title, description, list, buttons);
    document.body.append(panel);
    return {
        update(report, actions) {
            description.textContent = 'Generation is waiting. Enable the required settings, or disable Simulation Blackboard to continue. Automatic scene backgrounds remain separately controlled. Use Stop to cancel.';
            list.replaceChildren();
            for (const text of [...report.missing, ...report.blockers]) {
                const item = document.createElement('li'); item.textContent = text; list.append(item);
            }
            buttons.replaceChildren();
            for (const [action, label] of [['check', 'Check again & continue'], ['enable', 'Enable settings & continue'], ['disable', 'Disable Blackboard & continue']]) {
                const button = document.createElement('button');
                button.type = 'button'; button.className = 'menu_button'; button.textContent = label;
                button.dataset.action = action;
                button.disabled = action === 'enable' && !report.missing.length;
                button.onclick = actions[action]; buttons.append(button);
            }
        },
        close() { panel.remove(); },
    };
}

export function enableRequiredSettings(context) {
    // Dispatch the host's own handlers so its UI, feature flags and saved settings agree.
    const settings = context.chatCompletionSettings;
    if (context.mainApi !== 'openai' || !settings) return;
    if (!settings.function_calling) {
        settings.function_calling = true;
        $('#openai_function_calling').prop('checked', true).trigger('input');
    }
    if (['claude', 'makersuite', 'vertexai'].includes(settings.chat_completion_source) && !settings.use_sysprompt) {
        settings.use_sysprompt = true;
        $('#use_sysprompt').prop('checked', true).trigger('change');
    }
    context.saveSettingsDebounced?.();
}

export function createSetupGate({ getContext, enabled, disable, synchronize, showPanel = setupPanel, enableSettings = enableRequiredSettings }) {
    let cancelPending;
    return async function guard(type, abort) {
        if (!['normal', 'regenerate', 'swipe', 'continue'].includes(type)) return true;
        cancelPending?.();
        if (!enabled()) return true;
        const context = getContext();
        const initial = setupRequirements(context, type);
        if (initial.ready) return true;
        const chat = context.chat, metadata = context.chatMetadata;
        const fingerprint = () => JSON.stringify(context.chat.map(m => [m.mes, m.is_user, m.is_system, m.swipe_id, m.swipes]));
        const history = fingerprint();
        const chatId = context.chatId ?? context.getCurrentChatId?.();
        const current = () => {
            const now = getContext();
            return now.chat === chat && now.chatMetadata === metadata &&
                (now.chatId ?? now.getCurrentChatId?.()) === chatId && fingerprint() === history;
        };
        const panel = showPanel();
        return new Promise(resolve => {
            let settled = false;
            const subscriptions = [];
            const finish = proceed => {
                if (settled) return;
                settled = true;
                if (!proceed) abort(true);
                for (const [event, callback] of subscriptions) context.eventSource.removeListener(event, callback);
                if (cancelPending === cancel) cancelPending = null;
                panel.close(); resolve(proceed);
            };
            const cancel = () => finish(false);
            cancelPending = cancel;
            const on = (name, callback) => {
                const event = context.eventTypes[name];
                if (event) { context.eventSource.on(event, callback); subscriptions.push([event, callback]); }
            };
            for (const name of ['GENERATION_STOPPED', 'CHAT_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED']) on(name, cancel);
            on('GENERATION_STARTED', (_type, _options, dryRun) => { if (!dryRun) cancel(); });
            const act = action => {
                if (settled) return;
                if (!current()) return finish(false);
                try {
                    if (action === 'disable') disable();
                    if (action === 'enable') enableSettings(getContext());
                    synchronize();
                    const report = setupRequirements(getContext(), type);
                    if (!enabled() || report.ready) return finish(true);
                    panel.update(report, actions);
                } catch (error) {
                    panel.update({ missing: [], blockers: [String(error.message)] }, actions);
                }
            };
            const actions = { check: () => act('check'), enable: () => act('enable'), disable: () => act('disable') };
            panel.update(initial, actions);
        });
    };
}
