const scopeKey = value => JSON.stringify(value ?? null);
const isNumeric = text => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) && Number.isFinite(Number(text));

/** A line is one equiprobable face; repeated entries deliberately preserve weight. */
export function parseCustomFaces(text) {
    const faces = String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!faces.length) throw new Error('Enter at least one custom face, one per line.');
    return faces.every(isNumeric) ? faces.map(Number) : faces;
}

// Labels can contain markup characters. Escaping them in the shareable text keeps
// copied results from becoming HTML or accidentally opening a Markdown code span.
const faceText = value => typeof value === 'number' ? String(value) : JSON.stringify(String(value))
    .replace(/[<>&`]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
const signed = value => value >= 0 ? `+${value}` : String(value);

/** A player-readable receipt; actual faces are kept distinct from face indices. */
export function formatDiceReceipt(receipt) {
    const lines = [receipt.status === 'success' ? '🎲 Simulation Blackboard dice' : '🎲 Partial dice result — outcome uncertain'];
    if (receipt.label) lines.push(`Purpose: ${faceText(receipt.label)}`);
    if (receipt.formula) lines.push(`Formula: ${String(receipt.formula).replace(/[\r\n]/g, ' ')}`);
    if (receipt.mode && receipt.mode !== 'normal') lines.push(`Mode: ${receipt.mode}`);
    const groups = Array.isArray(receipt.groups) ? receipt.groups : [];
    groups.forEach((group, index) => {
        if (group.kind === 'custom' && Array.isArray(group.faces)) {
            lines.push(`Custom faces (each entry equally likely): ${group.faces.map(faceText).join(', ')}`);
        }
        const dice = (group.dice ?? []).map(die => {
            const values = (die.values ?? []).map(faceText).join(' + ');
            const sum = (die.values?.length ?? 0) > 1 && typeof die.total === 'number' ? ` = ${die.total}` : '';
            const kept = die.kept === false ? ' (dropped)' : group.selection ? ' (kept)' : '';
            return `[${values}${sum}]${kept}`;
        }).join(', ');
        const prefix = groups.length > 1 ? `Group ${index + 1}${group.sign === -1 ? ' (subtract)' : ''}` : 'Dice';
        lines.push(`${prefix}: ${dice}`);
    });
    if (!groups.length) {
        const values = receipt.face_values ?? (receipt.rolls_kind === 'face_indices' ? [] : receipt.rolls) ?? [];
        lines.push(`Dice: ${values.map(faceText).join(', ')}`);
    }
    if (receipt.modifier) lines.push(`Modifier: ${signed(receipt.modifier)}`);
    if (receipt.status === 'success') lines.push(typeof receipt.total === 'number' ? `Total: ${receipt.total}` : 'Result: symbolic faces; no numeric total.');
    else lines.push('This is not a confirmed completed roll. Do not invent the remaining faces.');
    return lines.join('\n');
}

/**
 * Optional manual UI. roll() performs exactly one explicit request. publish()
 * only appends the receipt to the user's input; it must never generate a reply.
 * getScope() identifies the current account/character/chat; checked again at use.
 */
export function installDicePanel({ html, roll, publish, getScope = () => null,
    document = globalThis.document, clipboard = globalThis.navigator?.clipboard }) {
    // Headless entry-point fixtures and unsupported host surfaces may have only
    // a minimal document. Keep the engine usable without requiring a manual UI.
    if (!document?.body?.append || typeof document.createElement !== 'function'
        || typeof document.getElementById !== 'function') return null;
    const existing = document.getElementById('blackboard-dice-panel');
    if (existing?.blackboardDicePanel) return existing.blackboardDicePanel;
    if (existing) throw new Error('A dice panel already exists without its controller.');
    if (typeof roll !== 'function') throw new Error('Dice panel requires a real dice engine.');
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    const panel = template.content.firstElementChild;
    if (panel?.id !== 'blackboard-dice-panel') throw new Error('Invalid dice panel template.');
    document.body.append(panel);
    const source = name => panel.querySelector(`[data-dice-${name}]`);
    let receipt = null;
    let receiptScope = null;
    let publication = 'ready';
    let busy = false;
    let returnFocus = null;
    let destroyed = false;
    const removers = [];
    const listen = (element, event, handler) => {
        element.addEventListener(event, handler);
        removers.push(() => element.removeEventListener(event, handler));
    };
    const status = (text, error = false) => {
        source('status').textContent = text;
        source('status').dataset.error = String(error);
    };
    const sameScope = () => receiptScope === scopeKey(getScope());

    function refresh() {
        const custom = source('use-custom').checked;
        source('formula').disabled = custom || busy;
        for (const key of ['faces', 'count', 'modifier']) source(key).disabled = !custom || busy;
        source('mode').disabled = busy;
        source('use-custom').disabled = busy;
        source('roll').disabled = busy;
        source('publish').hidden = typeof publish !== 'function';
        source('publish').disabled = !receipt || receipt.status !== 'success' || !sameScope() || busy || publication !== 'ready';
        source('copy').disabled = !receipt || busy;
        source('publish').textContent = publication === 'published' ? 'Added to message'
            : publication === 'publishing' ? 'Adding…' : 'Add result to message';
        if (receipt && !sameScope() && publication === 'ready') status('This result belongs to another chat. Copy it if needed, or make a new roll for this chat.');
    }

    function close({ restoreFocus = true } = {}) {
        panel.hidden = true;
        if (restoreFocus && returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus({ preventScroll: true });
    }

    function open({ opener = document.activeElement } = {}) {
        returnFocus = opener;
        panel.hidden = false;
        refresh();
        (source('use-custom').checked ? source('faces') : source('formula')).focus({ preventScroll: true });
    }

    listen(source('close'), 'click', () => close());
    listen(document, 'keydown', event => {
        if (event.key !== 'Escape' || panel.hidden || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        close();
    });
    listen(source('use-custom'), 'change', refresh);
    for (const button of panel.querySelectorAll('[data-dice-quick]')) {
        listen(button, 'click', () => {
            if (busy) return;
            source('use-custom').checked = false;
            source('formula').value = button.dataset.diceQuick;
            refresh();
            source('formula').focus({ preventScroll: true });
        });
    }
    listen(source('form'), 'submit', async event => {
        event.preventDefault();
        if (busy || destroyed) return;
        busy = true;
        receipt = null;
        publication = 'ready';
        receiptScope = scopeKey(getScope());
        source('result').hidden = true;
        status('');
        refresh();
        try {
            const args = source('use-custom').checked
                ? { faces: parseCustomFaces(source('faces').value), count: Number(source('count').value), modifier: Number(source('modifier').value), mode: source('mode').value }
                : { formula: source('formula').value, mode: source('mode').value };
            const result = await roll(args);
            if (destroyed) return;
            receipt = structuredClone(result);
            if (receipt.status !== 'success') throw new Error('The dice engine did not confirm a completed roll.');
            source('receipt').textContent = formatDiceReceipt(receipt);
            source('total').textContent = typeof receipt.total === 'number' ? `Total ${receipt.total}` : 'Symbolic result';
            source('result').hidden = false;
            status('Rolled. No message was sent and no world state was changed.');
        } catch (error) {
            if (destroyed) return;
            if (error.partialReceipt) {
                receipt = { ...structuredClone(error.partialReceipt), status: 'uncertain' };
                publication = 'uncertain';
                source('receipt').textContent = formatDiceReceipt(receipt);
                source('total').textContent = 'Incomplete roll';
                source('result').hidden = false;
            }
            status(String(error.message ?? error), true);
        } finally {
            busy = false;
            if (!destroyed) refresh();
        }
    });
    listen(source('publish'), 'click', async () => {
        if (!receipt || receipt.status !== 'success' || !sameScope() || busy || publication !== 'ready' || typeof publish !== 'function') return;
        busy = true;
        publication = 'publishing';
        refresh();
        try {
            await publish({ receipt: structuredClone(receipt), text: formatDiceReceipt(receipt), scope: JSON.parse(receiptScope) });
            if (destroyed) return;
            publication = 'published';
            status('Added to your message. Review it and send when ready.');
        } catch (error) {
            // An external callback might have appended text before throwing. Do
            // not offer a duplicate retry; the visible receipt remains copyable.
            publication = 'uncertain';
            if (!destroyed) status(`Could not confirm adding the result. Check your message before copying it again. ${String(error.message ?? error)}`, true);
        } finally {
            busy = false;
            if (!destroyed) refresh();
        }
    });
    listen(source('copy'), 'click', async () => {
        if (!receipt || busy) return;
        try {
            if (typeof clipboard?.writeText !== 'function') throw new Error('Clipboard is unavailable; select and copy the result text.');
            await clipboard.writeText(formatDiceReceipt(receipt));
            if (!destroyed) status('Copied.');
        } catch (error) {
            if (!destroyed) status(String(error.message ?? error), true);
        }
    });
    const api = { open, close, refresh, element: panel, destroy() {
        destroyed = true;
        removers.forEach(remove => remove());
        panel.remove();
    } };
    panel.blackboardDicePanel = api;
    refresh();
    return api;
}
