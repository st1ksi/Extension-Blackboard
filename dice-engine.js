// Local dice only: never evaluate a formula as JavaScript or synthesize random faces.
export const DICE_TOOL_NAME = 'RollBlackboardDice';
export const DICE_LIMITS = Object.freeze({
    sides: 1_000_000_000, dice: 100, faces: 1000, faceLength: 160,
    magnitude: 1_000_000_000, formulaLength: 256, labelLength: 160,
    drawnFaces: 1000, chainLength: 100, rejectionAttempts: 128,
});
export const DICE_TOOL_DESCRIPTION = 'Roll real local random dice and return the actual faces, kept/dropped dice and total. Use formula for standard/custom-sided dice or faces for an explicitly defined custom die. Fix the purpose and parameters before rolling; use each receipt once, never reroll to improve an outcome. Labels must be player-safe.';
export const DICE_HELP = 'Formula: NdS with + or - dice/integer terms, e.g. 1d20+5, 2d6+1d4-2, 4d6kh3, 2d20kl1, 1d6!. S is any integer from 1 to 1,000,000,000; at most 100 base dice. kh/kl keep highest/lowest; dh/dl drop highest/lowest. ! explodes maximum faces, adds each chain, then applies selection; safety limits stop an unfinished roll rather than truncate it. mode advantage/disadvantage rolls two and keeps the highest/lowest for a simple 1dS plus integer modifier; do not combine it with a pool, selection or explosion. Alternatively specify faces, count and optional numeric modifier; each array entry is equally likely, so duplicates supply weights. In model tool calls encode faces as strings: use face_type number for numeric faces such as ["-1","0","1"] or face_type symbol for labels. Numeric strings use JSON-number syntax without spaces; direct local callers can also supply number arrays. Without face_type, numeric arrays are numeric dice and string arrays are symbolic dice. Numeric custom dice can use advantage/disadvantage with count 1. Symbolic dice have no numeric total or modifier; their rolls are explicitly labeled 1-based face indices and face_values contains the real symbols. No multiplication, parentheses, scripts, implicit rerolls or game-specific success calculation.';

export const DICE_PARAMETERS = {
    type: 'object',
    properties: {
        formula: { type: 'string', description: 'NdS arithmetic, e.g. 1d20+5, 2d6+1d4-2, 4d6kh3, 2d20kl1 or 1d6!. Use this OR faces.' },
        faces: { type: 'array', description: 'Custom die face strings. For numeric values set face_type number, e.g. ["-1","0","1"]; for symbols use face_type symbol. Every entry is equally likely; duplicates are weights. Use this OR formula.', items: { type: 'string' }, minItems: 1, maxItems: DICE_LIMITS.faces },
        face_type: { type: 'string', enum: ['number', 'symbol'], description: 'Custom faces only: number interprets face strings as strict JSON numbers before rolling; symbol preserves labels. Omitted string faces are symbolic.' },
        count: { type: 'integer', minimum: 1, maximum: DICE_LIMITS.dice, description: 'Custom faces only: how many dice. Default 1.' },
        modifier: { type: 'integer', minimum: -DICE_LIMITS.magnitude, maximum: DICE_LIMITS.magnitude, description: 'Custom numeric faces only: one final additive modifier. Default 0; include formula modifiers in formula instead.' },
        mode: { type: 'string', enum: ['normal', 'advantage', 'disadvantage'], description: 'Default normal. Advantage/disadvantage: two simple dice, keep one highest/lowest; only a single non-exploding die plus modifier.' },
        label: { type: 'string', maxLength: DICE_LIMITS.labelLength, description: 'Optional player-safe description of the check. Do not include undiscovered actors, secret DCs or motives.' },
    },
    additionalProperties: false,
};

export class DiceValidationError extends Error {
    constructor(message) {
        super(message + ' No dice were rolled.');
        this.name = 'DiceValidationError';
        this.code = 'DICE_INVALID_REQUEST';
        this.uncertain = false;
        this.rolled = false;
    }
}

export class DiceExecutionError extends Error {
    constructor(message, partialReceipt, uncertain = true) {
        super(message);
        this.name = 'DiceExecutionError';
        this.code = 'DICE_EXECUTION_ERROR';
        this.uncertain = uncertain;
        this.rolled = uncertain;
        this.partialReceipt = partialReceipt;
    }
}

const invalid = message => { throw new DiceValidationError(message); };
const boundedInteger = (value, min, max, label) => {
    if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label} must be an integer from ${min} to ${max}.`);
    return value;
};
const suffix = value => value === 0 ? '' : value > 0 ? '+' + value : String(value);

function parseFormula(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > DICE_LIMITS.formulaLength) invalid('Supply a nonempty dice formula of at most 256 characters.');
    if (/\d\s+\d/.test(value)) invalid('Spaces inside a number are ambiguous.');
    const formula = value.toLowerCase().replace(/\u2212/g, '-').replace(/\s+/g, '');
    const terms = [];
    let offset = 0, modifier = 0, count = 0;
    const token = /([+-]?)(?:(\d*)d(\d+)(!)?(?:(kh|kl|dh|dl)(\d+))?|(\d+))/y;
    while (offset < formula.length) {
        token.lastIndex = offset;
        const match = token.exec(formula);
        if (!match || (offset > 0 && !match[1])) invalid('Unsupported dice formula. Use signed NdS/integer terms, optionally ! and kh/kl/dh/dl.');
        const sign = match[1] === '-' ? -1 : 1;
        if (match[7] !== undefined) {
            const number = boundedInteger(Number(match[7]), 0, DICE_LIMITS.magnitude, 'Modifier');
            modifier += sign * number;
            if (Math.abs(modifier) > DICE_LIMITS.magnitude) invalid('Combined modifier exceeds the supported bound.');
        } else {
            const amount = boundedInteger(Number(match[2] || 1), 1, DICE_LIMITS.dice, 'Dice count');
            const sides = boundedInteger(Number(match[3]), 1, DICE_LIMITS.sides, 'Sides');
            count += amount;
            if (count > DICE_LIMITS.dice) invalid('A request may contain at most 100 base dice.');
            const exploding = !!match[4];
            if (exploding && sides === 1) invalid('A one-sided die cannot finish exploding.');
            const selection = match[5] ? { operation: match[5], count: boundedInteger(Number(match[6]), 1, amount, 'Selection count') } : null;
            if (selection?.operation.startsWith('d') && selection.count === amount) invalid('Dropping every die leaves no result.');
            terms.push({ kind: 'standard', sign, count: amount, sides, selection, exploding });
        }
        offset = token.lastIndex;
    }
    if (!terms.length) invalid('A dice formula must contain at least one die.');
    return { terms, modifier };
}

function formulaOf(terms, modifier) {
    return terms.map((term, index) => `${term.sign < 0 ? '-' : index ? '+' : ''}${term.count}d${term.kind === 'custom' ? 'Custom' : term.sides}${term.exploding ? '!' : ''}${term.selection ? term.selection.operation + term.selection.count : ''}`).join('') + suffix(modifier);
}

function prepare(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) invalid('Dice arguments must be an object.');
    for (const key of Object.keys(args)) if (!['formula', 'faces', 'face_type', 'count', 'modifier', 'mode', 'label'].includes(key)) invalid('An unsupported dice parameter was supplied.');
    const mode = args.mode ?? 'normal';
    if (!['normal', 'advantage', 'disadvantage'].includes(mode)) invalid('Mode must be normal, advantage or disadvantage.');
    if (args.mode === null) invalid('Mode cannot be null.');
    let label;
    if (args.label !== undefined) {
        if (typeof args.label !== 'string' || args.label.length > DICE_LIMITS.labelLength || /[\x00-\x1f\x7f]/.test(args.label)) invalid('Label must be a short, single-line string.');
        label = args.label.trim();
    }
    const custom = Object.hasOwn(args, 'faces');
    let terms, modifier, normalized;
    if (custom) {
        if (Object.hasOwn(args, 'formula')) invalid('Use formula OR custom faces, not both.');
        if (args.count === null || args.modifier === null) invalid('Custom count and modifier must be numbers when supplied.');
        if (!Array.isArray(args.faces) || !args.faces.length || args.faces.length > DICE_LIMITS.faces) invalid('Custom faces must be a nonempty list of at most 1000 entries.');
        if (Object.hasOwn(args, 'face_type') && !['number', 'symbol'].includes(args.face_type)) invalid('Custom face_type must be number or symbol.');
        const faces = args.faces.map(value => {
            if (args.face_type !== 'number' || typeof value !== 'string') return value;
            if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) invalid('Numeric face strings must use JSON-number syntax without spaces.');
            return Number(value);
        });
        const numeric = args.face_type !== 'symbol' && faces.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= DICE_LIMITS.magnitude);
        const symbolic = args.face_type !== 'number' && faces.every(v => typeof v === 'string' && v.trim() && v.length <= DICE_LIMITS.faceLength && !/[\x00-\x1f\x7f]/.test(v));
        if (!numeric && !symbolic) invalid('Custom faces must be all bounded finite numbers or all nonempty short string labels.');
        const count = boundedInteger(args.count ?? 1, 1, DICE_LIMITS.dice, 'Custom dice count');
        modifier = boundedInteger(args.modifier ?? 0, -DICE_LIMITS.magnitude, DICE_LIMITS.magnitude, 'Modifier');
        if (symbolic && modifier !== 0) invalid('Symbolic dice cannot have a numeric modifier.');
        terms = [{ kind: 'custom', sign: 1, count, sides: null, faces, numeric, selection: null, exploding: false }];
        normalized = { faces: [...faces], ...(args.face_type ? { face_type: args.face_type } : {}), count, modifier, mode, ...(label ? { label } : {}) };
    } else {
        if (Object.hasOwn(args, 'count') || Object.hasOwn(args, 'modifier') || Object.hasOwn(args, 'face_type')) invalid('Count, modifier and face_type parameters are for custom faces only; use count and modifier inside a formula.');
        ({ terms, modifier } = parseFormula(args.formula));
        normalized = { formula: formulaOf(terms, modifier), mode, ...(label ? { label } : {}) };
    }
    const requestedFormula = formulaOf(terms, modifier);
    if (mode !== 'normal') {
        if (terms.length !== 1 || terms[0].count !== 1 || terms[0].sign !== 1 || terms[0].exploding || terms[0].selection || (custom && !terms[0].numeric)) invalid('Advantage/disadvantage requires one simple numeric die plus a modifier.');
        terms[0].count = 2;
        terms[0].selection = { operation: mode === 'advantage' ? 'kh' : 'kl', count: 1 };
    }
    return { normalized, terms, modifier, mode, label, formula: formulaOf(terms, modifier), requestedFormula };
}

/** Validate every term and parameter without accessing randomness. */
export function validateBlackboardDiceArguments(args) {
    return prepare(args).normalized;
}

function applySelection(group) {
    if (!group.selection) return;
    const descending = group.selection.operation.endsWith('h');
    const ordered = group.dice.map((die, index) => ({ die, index })).sort((a, b) => (descending ? b.die.total - a.die.total : a.die.total - b.die.total) || a.index - b.index);
    const selected = new Set(ordered.slice(0, group.selection.count).map(value => value.index));
    const keep = group.selection.operation.startsWith('k');
    group.dice.forEach((die, index) => { die.kept = keep ? selected.has(index) : !selected.has(index); });
}

/** Execute a prevalidated bounded request, with unbiased crypto randomness. */
export function rollBlackboardDice(args, { randomUint32 } = {}) {
    const plan = prepare(args); // Complete validation precedes even RNG availability checks.
    if (randomUint32 !== undefined && typeof randomUint32 !== 'function') invalid('The random source must be a function.');
    const symbolic = plan.terms.some(term => term.kind === 'custom' && !term.numeric);
    const receipt = { version: 1, status: 'pending', source: 'simulation-blackboard', formula: plan.formula, mode: plan.mode,
        total: null, rolls: [], face_values: [], rolls_kind: symbolic ? 'face_indices' : 'faces', modifier: plan.modifier,
        groups: [], ...(plan.label ? { label: plan.label } : {}),
        ...(plan.requestedFormula !== plan.formula ? { requested_formula: plan.requestedFormula } : {}) };
    let attempts = 0;
    const fail = message => {
        receipt.status = 'incomplete';
        throw new DiceExecutionError(message + ' The partial receipt is preserved; do not automatically reroll.', structuredClone(receipt), attempts > 0);
    };
    if (randomUint32 === undefined) {
        const crypto = globalThis.crypto;
        if (typeof crypto?.getRandomValues !== 'function') fail('A cryptographic random source is unavailable.');
        const buffer = new Uint32Array(1);
        randomUint32 = () => crypto.getRandomValues(buffer)[0];
    }
    function randomIndex(size) {
        const limit = Math.floor(0x1_0000_0000 / size) * size;
        for (let rejected = 0; rejected < DICE_LIMITS.rejectionAttempts; rejected++) {
            let word;
            attempts++;
            try { word = randomUint32(); } catch { fail('The cryptographic random source failed.'); }
            if (!Number.isInteger(word) || word < 0 || word > 0xffff_ffff) fail('The random source returned an invalid unsigned 32-bit value.');
            if (word < limit) return word % size;
        }
        fail('The random-source rejection limit was reached.');
    }
    for (const term of plan.terms) {
        const { numeric, ...details } = term;
        const group = { ...details, dice: [], subtotal: null };
        receipt.groups.push(group);
        for (let i = 0; i < term.count; i++) {
            const die = { values: [], ...(term.kind === 'custom' ? { indices: [] } : {}), total: symbolic ? null : 0, kept: true };
            group.dice.push(die);
            while (true) {
                if (receipt.rolls.length >= DICE_LIMITS.drawnFaces || die.values.length >= DICE_LIMITS.chainLength) fail('The exploding-dice safety limit was reached before the roll finished.');
                const index = randomIndex(term.kind === 'custom' ? term.faces.length : term.sides);
                const value = term.kind === 'custom' ? term.faces[index] : index + 1;
                die.values.push(value);
                if (die.indices) die.indices.push(index + 1);
                receipt.rolls.push(symbolic ? index + 1 : value);
                receipt.face_values.push(value);
                if (!symbolic) die.total += value;
                if (!term.exploding || value !== term.sides) break;
            }
        }
        applySelection(group);
        group.subtotal = symbolic ? null : term.sign * group.dice.reduce((sum, die) => sum + (die.kept ? die.total : 0), 0);
    }
    receipt.total = symbolic ? null : receipt.groups.reduce((sum, group) => sum + group.subtotal, plan.modifier);
    if (receipt.total !== null && !Number.isFinite(receipt.total)) fail('The numeric result exceeded the supported range.');
    receipt.status = 'success';
    return receipt;
}
