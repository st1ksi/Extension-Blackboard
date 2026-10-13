import { diceResult } from './dice.js';

const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function backgroundResult(raw) {
    if (raw instanceof Error) return { status: 'error', error: raw.message };
    let value = raw;
    if (typeof raw === 'string') {
        try { value = JSON.parse(raw); } catch { return { status: 'unknown', result: raw }; }
    }
    if (value?.status === 'success') return { status: 'success', result: value };
    if (value?.status === 'error') return { status: 'error', result: value };
    if (value?.status === 'notice') return { status: 'notice', result: value };
    return { status: 'unknown', result: value ?? null };
}

export function publicJournal(rolls, background, receipts = []) {
    return {
        rolls: rolls.map(r => {
            // Do not publish NPC names, hidden DCs or free-form tool arguments.
            // Preserve the numeric result produced by the installed dice tool.
            const outcome = diceResult(r.result);
            const formula = String(r.arguments?.formula ?? '');
            return { formula: /^[\ddDkhlr!+*/().\s-]{1,100}$/.test(formula) ? formula : '(formula hidden)',
                total: outcome.status === 'success' ? outcome.total : null, individual: outcome.status === 'success' ? outcome.rolls.join(', ') : null };
        }),
        diceErrors: receipts.filter(r => r.tool === 'RollTheDice' && r.result?.status === 'error').length,
        updates: { calls: receipts.filter(r => r.tool === 'UpdateBlackboard').length, errors: receipts.filter(r => r.tool === 'UpdateBlackboard' && r.result?.status === 'error').length },
        background: { status: background.status },
    };
}

export function renderJournal(journal) {
    const rows = journal.rolls.length ? journal.rolls.map((r, i) => `<div>🎲 ${i + 1}. RollTheDice: ${escape(r.formula)} — ${r.total === null ? 'tool called; result format not recognized (see export)' : `${escape(r.total)}; dice: ${escape(r.individual)}`}</div>`).join('')
        : '<div>🎲 RollTheDice: no rolls this turn.</div>';
    const labels = { disabled: 'disabled in settings', not_requested: 'not requested', queued: 'queued', running: 'generating', success: 'generated and applied — tool confirmed success', error: 'generation or application failed', notice: 'not completed: tool notice', unknown: 'result unconfirmed', skipped: 'skipped: cancelled or chat changed', discarded: 'request discarded after review' };
    const diceErrors = journal.diceErrors ? `<div>⚠️ RollTheDice: failed/deferred calls: ${journal.diceErrors}; these do not count as rolls.</div>` : '';
    return `<details><summary>⚙️ Tool journal · Blackboard</summary>${rows}${diceErrors}<div>📋 UpdateBlackboard: calls: ${journal.updates.calls}, errors: ${journal.updates.errors}; intermediate data hidden.</div><div>🖼️ SetSceneBackground: ${escape(labels[journal.background.status] ?? labels.unknown)}.</div></details>`;
}
