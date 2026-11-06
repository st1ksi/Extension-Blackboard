import { diceResult } from './dice.js';
import { DICE_TOOL_NAME } from './dice-engine.js';

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

export function publicDiceReceipt(record) {
    // Do not publish model-supplied labels or the complete custom face list:
    // these may encode hidden world facts. Private reports retain the source.
    const outcome = diceResult(record.result);
    const builtin = record.tool === DICE_TOOL_NAME || record.result?.source === 'simulation-blackboard';
    const formula = String(builtin ? outcome.formula ?? record.arguments?.formula ?? '' : record.arguments?.formula ?? '');
    const custom = builtin && Array.isArray(record.arguments?.faces);
    const selected = outcome.groups?.flatMap(group => group.dice?.map(die =>
        `${((outcome.symbolic ? die.indices : die.values) ?? []).join('+')}${group.selection ? die.kept ? ' (kept)' : ' (dropped)' : ''}`) ?? []).join(', ');
    return {
        ...(builtin ? { tool: DICE_TOOL_NAME, recognized: outcome.status === 'success', symbolic: !!outcome.symbolic } : {}),
        formula: custom ? 'custom die' : /^[\ddDkhlr!+*/().\s-]{1,256}$/.test(formula) ? formula : '(formula hidden)',
        total: outcome.status === 'success' ? outcome.total : null,
        individual: outcome.status === 'success' ? (outcome.symbolic ? 'face indices: ' : '') + (selected || outcome.rolls.join(', ')) : null,
    };
}

export function publicJournal(rolls, background, receipts = []) {
    return {
        rolls: rolls.map(publicDiceReceipt),
        diceErrors: receipts.filter(r => [DICE_TOOL_NAME, 'RollTheDice'].includes(r.tool) && r.result?.status === 'error').length,
        updates: { calls: receipts.filter(r => r.tool === 'UpdateBlackboard').length, errors: receipts.filter(r => r.tool === 'UpdateBlackboard' && r.result?.status === 'error').length },
        background: { status: background.status },
    };
}

export function renderJournal(journal) {
    const rows = journal.rolls.length ? journal.rolls.map((r, i) => `<div>🎲 ${i + 1}. ${escape(r.tool ?? 'RollTheDice')}: ${escape(r.formula)} — ${r.symbolic && r.recognized ? `symbolic result; ${escape(r.individual)}` : r.total === null ? 'tool called; result format not recognized (see export)' : `${escape(r.total)}; dice: ${escape(r.individual)}`}</div>`).join('')
        : '<div>🎲 Dice: no rolls this turn.</div>';
    const labels = { disabled: 'disabled in settings', not_requested: 'not requested', queued: 'queued', running: 'generating', success: 'generated and applied — tool confirmed success', error: 'generation or application failed', notice: 'not completed: tool notice', unknown: 'result unconfirmed', skipped: 'skipped: cancelled or chat changed', discarded: 'request discarded after review' };
    const diceErrors = journal.diceErrors ? `<div>⚠️ Dice: failed/deferred calls: ${journal.diceErrors}; these do not count as rolls.</div>` : '';
    return `<details><summary>⚙️ Tool journal · Blackboard</summary>${rows}${diceErrors}<div>📋 UpdateBlackboard: calls: ${journal.updates.calls}, errors: ${journal.updates.errors}; intermediate data hidden.</div><div>🖼️ SetSceneBackground: ${escape(labels[journal.background.status] ?? labels.unknown)}.</div></details>`;
}
