// Pure state operations. No DOM, globals, network, or mutations of caller data.
import { hasCalculatedProgression } from './game-system-registry.js';
export const PROGRESSION_KEY = 'misc #character_progression';
export const XP_THRESHOLDS = Object.freeze([0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000]);
const CATEGORIES = new Set(['SCENE', 'ENTITIES', 'NARRATIVE', 'LORE', 'MISC']);

export function parseBlocks(rawText) {
    if (typeof rawText !== 'string' || !rawText.trim()) return { preamble: '', blocks: [] };
    let text = rawText.replace(/\r\n?/g, '\n').trim();
    // Accept one enclosing Markdown fence, but not a sequence of internal fences.
    const outer = text.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*)\n```$/i);
    if (outer && !/^\s*```/m.test(outer[1])) text = outer[1].trim();
    const parsed = { preamble: '', blocks: [] };
    let block = null;
    let fence = null;
    const preamble = [];
    for (const line of text.split('\n')) {
        const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
        const header = !fence && line.match(/^\s*\[([A-Za-z0-9_-]+)\s+#\s*([^\]]+)\]\s*$/);
        if (header) {
            const category = header[1].toUpperCase();
            const tagId = header[2].trim();
            block = { category, tagId, blockKey: `${category} #${tagId}`.toLowerCase(), rawHeader: line.trim(), content: '' };
            parsed.blocks.push(block);
        } else if (block) {
            block.content += `${line}\n`;
        } else {
            preamble.push(line);
        }
        if (fenceMatch) {
            const marker = fenceMatch[1];
            if (!fence) fence = marker;
            else if (marker[0] === fence[0] && marker.length >= fence.length && /^\s*(`{3,}|~{3,})\s*$/.test(line)) fence = null;
        }
    }
    parsed.preamble = preamble.join('\n').trim();
    for (const entry of parsed.blocks) entry.content = entry.content.trim();
    return parsed;
}

export function serializeBlocks(parsed) {
    return [parsed.preamble, ...parsed.blocks.map(b => `[${b.category} #${b.tagId}]\n${b.content}`)].filter(x => x?.trim()).join('\n\n').trim();
}

export function parseBlockId(value) {
    const match = String(value || '').trim().match(/^\[?([A-Za-z0-9_-]+)\s+#\s*([a-zA-Z0-9_-]+)\]?$/);
    if (!match || !CATEGORIES.has(match[1].toUpperCase())) throw new Error('Use a complete block ID: CATEGORY #snake_case_id.');
    const category = match[1].toUpperCase();
    const tagId = match[2].toLowerCase();
    return { category, tagId, blockKey: `${category} #${tagId}`.toLowerCase() };
}

function uniqueBlocks(parsed) {
    const seen = new Set();
    for (const b of parsed.blocks) {
        const id = parseBlockId(`${b.category} #${b.tagId}`);
        if (seen.has(id.blockKey)) throw new Error(`Duplicate block ID: ${id.blockKey}. Batch was not saved.`);
        seen.add(id.blockKey);
        Object.assign(b, id);
    }
    return parsed;
}

function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in ${min}..${max}.`);
}
function nonempty(value, name) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
}
function stable(value) {
    if (Array.isArray(value)) return JSON.stringify(value.map(v => JSON.parse(stable(v))));
    if (value && typeof value === 'object') return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(stable(value[k]))])));
    return JSON.stringify(value);
}

export function normalizeProgression(input, previous = null) {
    const p = structuredClone(input);
    if (!p || typeof p !== 'object' || Array.isArray(p) || p.version !== 1) throw new Error('Progression must be a version: 1 JSON object.');
    if (!/^[a-z0-9_-]+$/.test(p.character_id || '')) throw new Error('character_id must reference an ENTITIES tag.');
    if (!['5e-2014', '5e-2024'].includes(p.ruleset)) throw new Error('ruleset must be 5e-2014 or 5e-2024.');
    if (!['xp', 'milestone'].includes(p.mode)) throw new Error('mode must be xp or milestone.');
    integer(p.base_xp, 'base_xp');
    nonempty(p.baseline_reason, 'baseline_reason');
    integer(p.level, 'level', 1, 20);
    if (!Array.isArray(p.classes) || !p.classes.length) throw new Error('classes must contain the applied class levels.');
    const classNames = new Set();
    let classLevels = 0;
    for (const c of p.classes) {
        nonempty(c.name, 'class name');
        integer(c.level, 'class level', 1, 20);
        const key = c.name.trim().toLowerCase();
        if (classNames.has(key)) throw new Error('Duplicate class; combine its levels in one entry.');
        classNames.add(key);
        classLevels += c.level;
    }
    if (classLevels !== p.level) throw new Error('Class levels must sum to applied character level.');
    if (!Array.isArray(p.pending_choices) || !p.pending_choices.every(v => typeof v === 'string' && v.trim())) throw new Error('pending_choices must be an array of nonempty strings.');
    if (!Array.isArray(p.awards)) throw new Error('awards must be an array (empty on initialization).');
    const entries = new Map();
    const remaining = new Map();
    let total = p.base_xp;
    for (const award of p.awards) {
        if (!award || typeof award !== 'object') throw new Error('Invalid XP award.');
        nonempty(award.id, 'award id');
        if (entries.has(award.id)) throw new Error('Duplicate XP award ID; do not append the same achievement twice.');
        nonempty(award.reason, 'award reason');
        nonempty(award.at, 'award time');
        integer(award.delta, 'award delta', -Number.MAX_SAFE_INTEGER);
        if (award.delta === 0) throw new Error('XP award delta cannot be zero.');
        if (award.delta < 0) {
            if (!entries.has(award.corrects) || (remaining.get(award.corrects) ?? 0) < -award.delta) throw new Error('Correction must reference an earlier positive award and cannot exceed its uncorrected XP.');
            remaining.set(award.corrects, remaining.get(award.corrects) + award.delta);
        } else {
            if (award.corrects !== undefined) throw new Error('A correction must have a negative delta.');
            remaining.set(award.id, award.delta);
        }
        entries.set(award.id, award);
        total += award.delta;
        integer(total, 'cumulative XP');
    }
    const xpLevel = XP_THRESHOLDS.reduce((level, threshold, i) => total >= threshold ? i + 1 : level, 1);
    if (previous) {
        for (const key of ['character_id', 'ruleset', 'mode', 'base_xp', 'baseline_reason']) {
            if (p[key] !== previous[key]) throw new Error(`${key} is immutable in model updates; use an explicit manual correction.`);
        }
        if (p.awards.length < previous.awards.length || previous.awards.some((a, i) => stable(a) !== stable(p.awards[i]))) throw new Error('Existing XP ledger entries cannot be deleted, reordered or changed; append a correction.');
        if (p.level < previous.level || p.level > previous.level + 1) throw new Error('Apply one earned level at a time; model updates cannot remove levels.');
        let gained = 0;
        for (const oldClass of previous.classes) {
            const next = p.classes.find(c => c.name.toLowerCase() === oldClass.name.toLowerCase());
            if (!next || next.level < oldClass.level) throw new Error('Applied class levels cannot be removed by a model update.');
            if (oldClass.subclass && next.subclass !== oldClass.subclass) throw new Error('Existing subclass cannot be rewritten by a model update.');
            gained += next.level - oldClass.level;
        }
        gained += p.classes.filter(c => !previous.classes.some(old => old.name.toLowerCase() === c.name.toLowerCase())).reduce((sum, c) => sum + c.level, 0);
        if (gained !== p.level - previous.level) throw new Error('Class advancement does not match the character level change.');
        if (p.level > previous.level && p.pending_choices.length) throw new Error('Resolve pending choices before applying the new level.');
    }
    if (p.mode === 'xp' && p.level > xpLevel && (!previous || p.level !== previous.level)) throw new Error('Applied level exceeds the earned XP threshold.');
    p.xp = total;
    p.eligible_level = p.mode === 'xp' ? xpLevel : null;
    // When choices are pending, show the next unearned XP threshold, not a negative remaining amount.
    p.next_level_xp = p.mode === 'xp' ? (XP_THRESHOLDS[Math.max(xpLevel, p.level)] ?? null) : null;
    p.proficiency_bonus = 2 + Math.floor((p.level - 1) / 4);
    return p;
}

export function readProgression(text, { gameSystem = 'dnd5e' } = {}) {
    if (!hasCalculatedProgression(gameSystem)) return null; // This profile owns its format; no D&D arithmetic.
    const block = parseBlocks(text).blocks.find(b => b.blockKey === PROGRESSION_KEY);
    if (!block) return null;
    const body = block.content.trim().replace(/^```json\s*\n([\s\S]*?)\n```$/i, '$1');
    let value;
    try { value = JSON.parse(body); } catch { throw new Error('MISC #character_progression must contain valid JSON, optionally in a json fence.'); }
    return normalizeProgression(value, value);
}

// Unlike readProgression, parsing previous state must allow a recorded negative correction
// below an already applied level. Normalization with itself preserves that earned level.
function rawProgression(parsed) {
    const block = parsed.blocks.find(b => b.blockKey === PROGRESSION_KEY);
    if (!block) return null;
    try { return JSON.parse(block.content.trim().replace(/^```json\s*\n([\s\S]*?)\n```$/i, '$1')); }
    catch { throw new Error('MISC #character_progression must contain valid JSON.'); }
}

export function validateBoard(text, previousText = null, { model = false, gameSystem = 'dnd5e' } = {}) {
    const parsed = uniqueBlocks(parseBlocks(text));
    const prevParsed = parseBlocks(previousText || '');
    if (!hasCalculatedProgression(gameSystem)) {
        if (model && prevParsed.blocks.some(b => b.blockKey === PROGRESSION_KEY) && !parsed.blocks.some(b => b.blockKey === PROGRESSION_KEY)) {
            throw new Error('The progression record cannot be deleted by the model. Use the inspector for an explicit reset.');
        }
        return { text: serializeBlocks(parsed), progression: null, parsed };
    }
    const oldRaw = rawProgression(prevParsed);
    const raw = rawProgression(parsed);
    if (model && oldRaw && !raw) throw new Error('The progression ledger cannot be deleted by the model. Use the inspector for an explicit reset.');
    if (raw) {
        const previous = oldRaw ? normalizeProgression(oldRaw, oldRaw) : null;
        const p = normalizeProgression(raw, model ? previous : (raw.level > (readEligibility(raw) ?? 20) ? raw : null));
        const entityKey = `entities #${p.character_id}`;
        const entity = parsed.blocks.find(b => b.blockKey === entityKey);
        if (!entity) throw new Error('Progression references a missing player ENTITIES block; include the sheet in this update.');
        if (model && previous && p.level !== previous.level) {
            const oldEntity = prevParsed.blocks.find(b => b.blockKey === entityKey);
            if (entity.content === oldEntity?.content) throw new Error('A level-up must update the player mechanical sheet in the same batch.');
        }
        parsed.blocks.find(b => b.blockKey === PROGRESSION_KEY).content = `\`\`\`json\n${JSON.stringify(p, null, 2)}\n\`\`\``;
    }
    return { text: serializeBlocks(parsed), progression: raw ? rawProgression(parsed) : null, parsed };
}

function readEligibility(p) {
    if (p.mode !== 'xp' || !Array.isArray(p.awards)) return null;
    const xp = p.base_xp + p.awards.reduce((sum, a) => sum + a.delta, 0);
    return XP_THRESHOLDS.reduce((level, value, i) => xp >= value ? i + 1 : level, 1);
}

export function applyUpdate(currentText, args, options = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected an object argument.');
    const action = String(args.action || (args.blackboard_content !== undefined ? 'replace_all' : 'upsert')).trim().toLowerCase();
    if (!['upsert', 'delete', 'replace_all'].includes(action)) throw new Error('Use upsert, delete or replace_all. Clear/reset is available only in the user inspector.');
    const raw = args.content ?? args.blackboard_content ?? '';
    if (typeof raw !== 'string') throw new Error('content must be a string.');
    const id = args.block_id || args.block_key;
    const current = uniqueBlocks(parseBlocks(currentText));
    let candidate;
    if (action === 'replace_all') {
        if (!raw.trim()) throw new Error('replace_all needs a nonempty board; use the inspector for an intentional reset.');
        candidate = uniqueBlocks(parseBlocks(raw));
        const newKeys = new Set(candidate.blocks.map(b => b.blockKey));
        if (current.blocks.some(b => !newKeys.has(b.blockKey))) throw new Error('replace_all would drop existing blocks. Use targeted upserts/deletes, or an explicit manual reset.');
    } else if (action === 'delete') {
        const target = parseBlockId(id);
        candidate = { ...current, blocks: current.blocks.filter(b => b.blockKey !== target.blockKey) };
    } else {
        if (!raw.trim()) throw new Error('upsert requires nonempty content.');
        const incoming = uniqueBlocks(parseBlocks(raw));
        if (!incoming.blocks.length) {
            const target = parseBlockId(id);
            incoming.blocks.push({ ...target, content: raw.trim(), rawHeader: `[${target.category} #${target.tagId}]` });
            incoming.preamble = '';
        } else if (id) {
            const target = parseBlockId(id);
            if (!incoming.blocks.some(b => b.blockKey === target.blockKey)) throw new Error('block_id conflicts with the content headers.');
        }
        candidate = current;
        if (!candidate.preamble) candidate.preamble = incoming.preamble;
        for (const block of incoming.blocks) {
            const i = candidate.blocks.findIndex(b => b.blockKey === block.blockKey);
            if (i < 0) candidate.blocks.push(block); else candidate.blocks[i] = block;
        }
    }
    const result = validateBoard(serializeBlocks(candidate), currentText, { ...options, model: true });
    return { ...result, action, changed: result.text !== currentText };
}

export function reconcileAges(text, ages = {}, turn = 0) {
    const next = {};
    for (const block of parseBlocks(text).blocks) {
        const old = ages[block.blockKey];
        next[block.blockKey] = { content: block.content, changedAt: old?.content === block.content && Number.isSafeInteger(old.changedAt) ? Math.min(turn, old.changedAt) : turn };
    }
    return next;
}

export function staleBlocks(text, ages, turn, threshold = 3) {
    return parseBlocks(text).blocks.flatMap(block => {
        const last = ages?.[block.blockKey];
        const age = last?.content === block.content ? Math.max(0, turn - last.changedAt) : 0;
        return age >= threshold ? [{ id: `${block.category} #${block.tagId}`, age }] : [];
    });
}

export function budget(settings, presets) {
    const preset = presets[settings.simulationFidelity] || presets.mid;
    const custom = settings.simulationFidelity === 'custom';
    const min = custom && Number.isFinite(Number(settings.targetMinTokens)) && Number(settings.targetMinTokens) > 0 ? Math.round(Number(settings.targetMinTokens)) : preset.minTokens;
    const requestedMax = custom && Number.isFinite(Number(settings.targetMaxTokens)) && Number(settings.targetMaxTokens) > 0 ? Math.round(Number(settings.targetMaxTokens)) : preset.maxTokens;
    return { min, max: Math.max(min, requestedMax), name: preset.name };
}

// Snapshot helpers preserve the selected alternative, including an empty snapshot.
export function snapshotExtra(message) {
    if (Number.isInteger(message?.swipe_id) && Array.isArray(message.swipes)) {
        if (message.swipe_id >= message.swipes.length) return null; // ungenerated alternative
        const extra = message.swipe_info?.[message.swipe_id]?.extra;
        if (typeof extra?.blackboard_snapshot === 'string') return extra;
        // An existing alternative without a checkpoint must not inherit another
        // alternative's live extra. Legacy single-swipe messages can be migrated.
        if (message.swipes.length > 1) return null;
    }
    return typeof message?.extra?.blackboard_snapshot === 'string' ? message.extra : null;
}

export function findSnapshot(chat, end = chat.length - 1) {
    for (let i = Math.min(end, chat.length - 1); i >= 0; i--) {
        const extra = snapshotExtra(chat[i]);
        if (extra) return { index: i, text: extra.blackboard_snapshot, engine: structuredClone(extra.blackboard_engine ?? null) };
    }
    return null;
}

export function writeSnapshot(message, text, engine) {
    message.extra ??= {};
    message.extra.blackboard_snapshot = text;
    message.extra.blackboard_engine = structuredClone(engine);
    const selected = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
    if (Array.isArray(message.swipes) && selected < message.swipes.length) {
        message.swipe_info ??= [];
        message.swipe_info[selected] ??= {};
        message.swipe_info[selected].extra = structuredClone(message.extra);
    }
}

export function redactToolLog(message) {
    const invocations = message?.extra?.tool_invocations;
    if (!invocations?.some(i => ['UpdateBlackboard', 'SetSceneBackground'].includes(i.name))) return false;
    const safe = invocations.map(i => ['UpdateBlackboard', 'SetSceneBackground'].includes(i.name)
        ? { name: i.name, result: 'Private world operation. Inspect state in the Blackboard Inspector.' }
        : { name: i.displayName || i.name, parameters: i.parameters, result: i.result });
    const escaped = JSON.stringify(safe, null, 2).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    message.mes = `<details><summary>Tool calls</summary><pre><code>${escaped}</code></pre></details>`;
    return true;
}
