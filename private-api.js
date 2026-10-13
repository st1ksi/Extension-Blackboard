import { retryInfo, retryRequest } from './retry.js';
// Request transport using stock SillyTavern exports. No global fetch patches,
// setting changes, chat tool logs, or core modifications.
export function normalizeBlackboardResponse(data, text, fallbackModel) {
    const choice = data?.choices?.find(c => c.index === 0) ?? data?.choices?.[0];
    let calls = choice?.message?.tool_calls;
    if (!calls && Array.isArray(data?.content)) calls = data.content.filter(c => c.type === 'tool_use').map(c => ({ function: { name: c.name, arguments: c.input } }));
    const parts = data?.responseContent?.parts ?? data?.candidates?.[0]?.content?.parts;
    if (!calls && Array.isArray(parts)) calls = parts.filter(p => p.functionCall).map(p => ({ function: { name: p.functionCall.name, arguments: p.functionCall.args } }));
    calls ??= data?.message?.tool_calls ?? [];
    if (!Array.isArray(calls)) calls = [calls];
    return { text, error: data?.error, model: data?.model ?? fallbackModel,
        usage: data?.usage ?? data?.usageMetadata ?? null,
        finishReason: String(choice?.finish_reason ?? data?.stop_reason ?? data?.candidates?.[0]?.finishReason ?? '').toLowerCase(),
        calls: calls.map(c => ({ name: c.function?.name, arguments: c.function?.arguments })),
    };
}

export function createPrivateRequest({ settings, getModel, createParameters, context, fetchRequest = fetch, onWait, retryOptions = {} }) {
    // Freeze a per-turn copy, never toggle the user's streaming / multi-swipe settings.
    const requestSettings = { ...structuredClone(settings), stream_openai: false, n: 1 };
    const model = getModel(requestSettings);
    return async (messages, allowedTools, signal) => {
        signal?.throwIfAborted();
        const { generate_data: data } = await createParameters(requestSettings, model, 'normal', messages);
        await context.eventSource.emit(context.eventTypes.CHAT_COMPLETION_SETTINGS_READY, data);
        // Apply the private constraints after other request decorators.
        data.stream = false;
        data.n = 1;
        data.tools = JSON.parse(JSON.stringify((data.tools || []).filter(t => allowedTools.includes(t.function?.name))));
        for (const tool of data.tools) {
            if (tool.function.name === 'RollTheDice') {
                const formula = tool.function.parameters?.properties?.formula;
                if (formula) formula.description = `${formula.description || ''} Use compact notation, e.g. 1d20+5. A rejected call is not a successful roll.`.trim();
            }
            if (tool.function.name !== 'UpdateBlackboard') continue;
            const schema = tool.function.parameters;
            schema.properties.base_revision = { type: 'integer', description: 'Current private working revision from VERSION PACKET.' };
            schema.required = [...new Set([...(schema.required || []), 'base_revision'])];
        }
        delete data.tool_choice;
        if (!data.tools.length) delete data.tools;
        signal?.throwIfAborted();
        const wire = JSON.stringify(data);
        return retryRequest(async () => {
        let response;
        try { response = await fetchRequest('/api/backends/chat-completions/generate', {
            method: 'POST', headers: context.getRequestHeaders(), body: wire, signal,
        }); } catch (error) {
            signal?.throwIfAborted();
            error.retryable = true; // transport failure: no local tools executed
            throw error;
        }
        let result;
        try { result = await response.json(); } catch { result = { error: `HTTP ${response.status}: invalid response body` }; }
        if (!response.ok || result?.error) {
            const error = new Error(`Private request failed (${response.status || 'API'}): ${typeof result?.error === 'string' ? result.error : result?.error?.message || result?.message || 'provider rejected request'}`);
            Object.assign(error, retryInfo(response.status, result, response.headers?.get?.('Retry-After')));
            throw error;
        }
        return normalizeBlackboardResponse(result, context.extractMessageFromData(result, 'openai'), model);
        }, { ...retryOptions, signal, onWait });
    };
}

export async function makePrivateRequest(context, options = {}) {
    const api = await import('../../../openai.js');
    if (typeof api.createGenerationParameters !== 'function') throw new Error('This SillyTavern version lacks createGenerationParameters; update SillyTavern.');
    return createPrivateRequest({ settings: api.oai_settings, getModel: api.getChatCompletionModel,
        createParameters: api.createGenerationParameters, context, ...options });
}
