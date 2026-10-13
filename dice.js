// Compatibility boundary for the installed RollTheDice tool. Never roll here:
// the registered tool remains the sole source of randomness.
export function normalizeDiceArguments(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.formula !== 'string' || !args.formula.trim()) {
        throw new Error('RollTheDice requires a nonempty formula, e.g. 1d20+5. No dice were rolled.');
    }
    // Spaces around notation are cosmetic; spaces inside a number are ambiguous.
    if (/\d\s+\d/.test(args.formula)) throw new Error('Spaces inside a dice count/modifier are ambiguous. No dice were rolled.');
    return { ...args, formula: args.formula.replace(/\u2212/g, '-').replace(/\s+/g, '') };
}

const number = value => (typeof value === 'number' || (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim()))) && Number.isFinite(Number(value));

export function diceResult(raw) {
    let value = raw;
    if (typeof raw === 'string') {
        try { value = JSON.parse(raw); } catch { /* Native dice tool returns prose. */ }
        if (typeof value === 'string') {
            const match = value.match(/The result(?: or a [^\r\n]*? roll)? is:\s*(.*?)\.\s*Individual rolls:\s*(.*?)\s*$/);
            if (!match) return { status: 'unknown' };
            value = { total: match[1].trim(), rolls: match[2].trim() ? match[2].split(',').map(v => v.trim()) : [] };
        }
    }
    if (!value || typeof value !== 'object' || !Array.isArray(value.rolls)) return { status: 'unknown' };
    // This exact empty return is the installed tool's pre-roll validation failure.
    // A missing/malformed total with any dice is uncertain, never safe to repeat.
    if (value.total === '' && value.rolls.length === 0) return { status: 'empty' };
    if (!number(value.total) || !value.rolls.length || !value.rolls.every(number)) return { status: 'unknown' };
    return { status: 'success', total: String(value.total), rolls: value.rolls.map(String) };
}

export const emptyDiceError = raw => ({
    status: 'error', code: 'DICE_NO_RESULT',
    message: 'RollTheDice rejected the formula without producing dice. This is NOT a roll result. Correct the formula before resolving the check; use e.g. 1d20+5 or 2d20kh1+5. Do not invent a total.',
    raw_result: raw,
});

// Upgrade only the unambiguous legacy failure before any world transition.
// Preserve successful rolls and raw diagnostics; never edit world snapshots.
export function recoverEmptyDiceCheckpoint(state) {
    const draft = state.draft;
    const empty = draft.rolls.filter(r => diceResult(r.result).status === 'empty');
    if (!empty.length) return false;
    if (state.inFlightTool || state.phase !== 'simulate' || state.answer || state.candidate || draft.head !== draft.baseline || draft.versions.length !== 1) {
        throw new Error('Saved turn contains empty dice results and later work. Automatic recovery cannot safely revise those outcomes; export the checkpoint for inspection.');
    }
    draft.rolls = draft.rolls.filter(r => diceResult(r.result).status !== 'empty');
    draft.receipts = draft.receipts.map(r => r.tool === 'RollTheDice' && diceResult(r.result).status === 'empty'
        ? { ...r, result: emptyDiceError(r.result) } : r);
    state.stats.recoveredEmptyDice = (state.stats.recoveredEmptyDice || 0) + empty.length;
    // The old pending request embeds empty results as successful rolls. Rebuild
    // from the same frozen context and corrected receipts, without replaying dice.
    state.pending = null;
    return true;
}
