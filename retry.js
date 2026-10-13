export function retryInfo(status, body, header, now = Date.now()) {
    const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
    const code = Number(body?.error?.code ?? body?.code) || status;
    const permanent = /insufficient_quota|billing|payment required|invalid.api.key|unauthenticated|permission.denied|context.length|context.window|token.limit.exceeded/i.test(text);
    const retryable = !permanent && ([429, 500, 502, 503, 504].includes(code) || /RESOURCE_EXHAUSTED|Too Many Requests|temporarily unavailable|overloaded/i.test(text));
    let retryAfterMs = 0;
    if (header) retryAfterMs = /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Math.max(0, Date.parse(header) - now) || 0;
    return { retryable, status: code || status, retryAfterMs };
}

export async function retryRequest(action, { signal, onWait = () => {}, maxRetries = 3, wait = interruptibleWait } = {}) {
    for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        try { return await action(); }
        catch (error) {
            signal?.throwIfAborted();
            if (!error.retryable || attempt >= maxRetries) throw error;
            const delay = Math.max(error.retryAfterMs || 0, Math.min(60000 * 2 ** attempt, 240000));
            // Very long provider cooldowns require manual resumption, not hours
            // of invisible automatic retries.
            if (delay > 600000) throw error;
            await onWait({ attempt: attempt + 1, maxRetries, delay, until: Date.now() + delay, status: error.status });
            await wait(delay, signal);
        }
    }
}

export function interruptibleWait(ms, signal) {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const cancel = () => { clearTimeout(timer); reject(signal.reason || new Error('Paused')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
        signal?.addEventListener('abort', cancel, { once: true });
    });
}
