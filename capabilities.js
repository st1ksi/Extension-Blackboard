// Feature detection only. Opening/writing checkpoint storage can still fail;
// recovery persists the checkpoint before the first model request.
export function privateTurnCapabilities(environment = globalThis) {
    const missing = [];
    const available = read => { try { return !!read(); } catch { return false; } };
    const secure = available(() => environment.isSecureContext === true);
    const storageAvailable = available(() => typeof environment.indexedDB?.open === 'function');
    const locksAvailable = available(() => typeof environment.navigator?.locks?.request === 'function');
    if (!secure) missing.push('secure context');
    if (!locksAvailable) missing.push('Web Locks');
    if (!storageAvailable) missing.push('IndexedDB');
    if (!available(() => typeof environment.crypto?.subtle?.digest === 'function')) missing.push('Web Crypto (SHA-256)');
    if (!available(() => typeof environment.crypto?.randomUUID === 'function')) missing.push('crypto.randomUUID');
    const supported = missing.length === 0;
    const message = supported
        ? 'Browser APIs available for Private Turns. Recovery drafts are stored in this browser and site address; they do not transfer between devices or HTTP/HTTPS addresses.'
        : `Private Turns unavailable: missing ${missing.join(', ')}. ${!secure
            ? 'On a phone or another LAN device, open SillyTavern over HTTPS with a certificate trusted by that device. Plain HTTP on a LAN IP does not provide the required secure context. On the server computer, localhost is also supported.'
            : 'Use an up-to-date browser with site storage enabled.'} Existing drafts are retained. Standard mode remains available if you turn Private Turns off explicitly.`;
    return { supported, missing, storageAvailable, locksAvailable, message };
}
