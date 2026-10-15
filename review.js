import { parseBlocks } from './state.js';
import { LIGHT_REVIEW_STAGE, normalizeLightAffected } from './private-modes.js';

export const REVIEW_STAGES = Object.freeze([
    { id: 'time', label: 'Time and active actors', task: `Reconstruct the resolved interval and the sequence of actions before evaluating its ending.
For EACH listed actor, compare their prior location, task, knowledge and resources with the elapsed time, interruptions and final position. Look for actors present in scenes or schedules but missing from the process register. A refreshed accounted_through is not evidence of movement/work. Explain continuous progress before deadlines and legitimate unchanged/blocked/static states.
Resolve crossed deadlines, travel/barriers and communication delays from established causes. A completed event cannot remain a future plan; a postponed deadline needs a cause. Check round/turn ownership, actions already spent, skipped participants and effect-expiration boundaries against the actual character/rules profile. Do not conflate a chat reply, tool call and combat round. Do not require combat bookkeeping in a noncombat scene. Separate historical facts from current state.`,
      targets: [['interval', 'Reconcile interval start/end, interruptions and chronological event order.'], ['schedules', 'Find timed work/effects in scenes, factions and narrative, including owners absent from the register.']] },
    { id: 'continuity', label: 'Facts, ownership and resources', task: `Audit the transition as an accountant of established facts.
For EACH changed or removed block, compare its complete contents across ALL revisions, including facts created and then lost within this turn. Identify omitted facts; explain their in-world change or exact surviving location. An explicit correction of a draft mistake is legitimate, but cannot rewrite preparation after dependent dice. Compression, death and distance do not erase equipment, evidence, abilities, motives or connections. Deleted lines are search cues, not automatic errors: equivalent retained information is sufficient.
Reconcile transfers at BOTH endpoints, spending/consumption, HP/damage and resource arithmetic with the actual dice receipts. Compare duplicate claims across entities, scene occupants, root truths, process notes and the candidate. Distinguish current possession/location from dated history and NPC beliefs. Do not invent facts or new awards to balance records. Assess NPC decisions from their psyche and information; neither automatic mercy nor mandatory aggression is a requirement.`,
      targets: [['ownership_resources', 'Reconcile ownership, quantities, HP, effects and advancement against confirmed actions and dice.'], ['cross_records', 'Find conflicting current claims across blocks, including unchanged scene entries and summaries.']] },
    { id: 'reach', label: 'Reachable space and preparation', task: `Examine what the player could reach within the selected preparation horizon, along spatial, temporal, social, informational, capability and causal paths.
Start from the latest player position and available abilities/resources. Enumerate materially distinct reachable exits, containers, actors, evidence and incoming events, including unfavored alternatives. Apply the selected quality's explicit preparation horizon: if it requires full detail beyond the next action, do not accept those branches as mere skeletons. For each relevant scene check connections, barriers, travel, geometry, lighting and contents at that required resolution; outside that horizon, preserve the specified lower resolution without quotas/filler. If a configured minimum requires expansion, assess missing operational coverage rather than padding; board_size is the latest working estimate, while reference_context may contain an older baseline size.
Use revision history and at_revision dice receipts to distinguish facts established BEFORE a dependent outcome from convenient additions afterward. Closed inventory cannot acquire loot through a search; an enemy cannot acquire a defense after a hit. Recover omitted prior canon; define genuinely missing future surfaces consistently before the next player action. An already-resolved missing prerequisite must not be retroactively invented to justify its result.`,
      targets: [['contact_surface', 'Map all meaningful next-contact vectors using actual capabilities; identify insufficient preparation.'], ['prior_preparation', 'Trace material discoveries, equipment and mechanisms to facts established before dependent checks.']] },
    { id: 'narration', label: 'Response and final state', task: `Check the candidate answer as the final player-visible account of this exact state.
Compare its concrete claims, rolls, damage, times, resources, positions, ownership and HUD with the latest board and actual tool results. Resolve contradictions such as different HP totals in entity/scene/prose, outdated expired effects and plans narrated as completed travel. Do not recompute another world interval.
Compare voluntary actions with what the player authorized. Preserve genuine failures and involuntary consequences without substituting a successful plan. Check player knowledge: names, motives, item contents and occult properties need an actual discovery; collapsible spoilers, HUDs, public dice labels and queued artwork are visible too. Distinguish established world truth from testimony. Do not fabricate a rescue or a new property to soften an outcome. Check that the reply hands back control at a meaningful decision boundary.`,
      targets: [['outcome', 'Reconcile the candidate outcome and numerical statements with board and dice.'], ['agency_knowledge', 'Check authorized actions, decision boundaries and every disclosure of hidden information.'], ['hud_visuals', 'Reconcile HUD and any queued image request with current player-known reality.']] },
]);

export const stageLabel = id => (id === 'light' ? LIGHT_REVIEW_STAGE : REVIEW_STAGES.find(s => s.id === id))?.label || id || '';
const blocks = text => new Map(parseBlocks(text).blocks.map(b => [b.blockKey, b.content]));
const normalized = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function processes(board) {
    try { return JSON.parse((board.get('misc #simulation_processes') || '').trim().replace(/^```(?:json)?\s*\n/, '').replace(/\n```\s*$/, '')).processes || []; }
    catch { return []; } // Malformed registers are handled by mechanical checks.
}

function ownSources(id, before, after, snapshots) {
    const required = [];
    if (before.get(id)?.trim()) required.push({ source: 'baseline', block_id: id });
    if (after.get(id)?.trim()) required.push({ source: 'current', block_id: id });
    if (!required.length) {
        const prior = snapshots.find(v => v.blocks.get(id)?.trim());
        if (prior) required.push({ source: `revision:${prior.revision}`, block_id: id });
    }
    return required;
}

function ownerBundle(id, before, after) {
    const owned = board => processes(board).filter(p => String(p.owner).toLowerCase() === id);
    // Literal ID/name hints only: no inference that an unlinked actor has no task.
    const nameHint = id.split('#')[1]?.split('_').at(-1);
    const related = [];
    for (const key of new Set([...before.keys(), ...after.keys()])) {
        if (key === id || key === 'misc #simulation_processes' || key.startsWith('entities #')) continue;
        const lines = board => (board.get(key) || '').split('\n').filter(line => {
            const text = line.toLowerCase();
            return text.includes(id) || (nameHint?.length >= 3 && text.split(/[^\p{L}\p{N}_-]+/u).includes(nameHint));
        });
        const baseline = lines(before), current = lines(after);
        if (baseline.length || current.length) related.push({ block_id: key, baseline, current });
    }
    return { block_id: id, baseline: before.get(id) ?? null, current: after.get(id) ?? null,
        processes: { baseline: owned(before), current: owned(after) }, related_records: related };
}

export function makeAudit(draft, stageId, candidateId) {
    const stage = stageId === 'light' ? LIGHT_REVIEW_STAGE : REVIEW_STAGES.find(s => s.id === stageId);
    if (!stage) throw new Error('Unknown review stage');
    const before = blocks(draft.baseline), after = blocks(draft.head);
    const snapshots = draft.versions.map(v => ({ revision: v.revision, blocks: blocks(v.text) }));
    const ids = [...new Set([...before.keys(), ...after.keys(), ...snapshots.flatMap(v => [...v.blocks.keys()])])];
    const changed = ids.filter(id => before.get(id) !== after.get(id)
        || snapshots.some((v, i) => i > 0 && v.blocks.get(id) !== snapshots[i - 1].blocks.get(id)));
    const owners = [...new Set([...processes(before), ...processes(after)].map(p => String(p.owner).toLowerCase()))].filter(id => before.has(id) || after.has(id));
    const actors = ids.filter(id => id.startsWith('entities #'));
    const bundles = ['time', 'continuity'].includes(stageId) ? [...new Set([...actors, ...owners])].map(id => ownerBundle(id, before, after)) : [];
    const ownerTarget = (id, prefix) => {
        const bundle = bundles.find(b => b.block_id === id);
        const required = ownSources(id, before, after, snapshots);
        for (const source of ['baseline', 'current']) if (bundle?.processes[source].length) required.push({ source, block_id: 'misc #simulation_processes' });
        return { id: `${prefix}:${id}`, block_id: id, required_evidence: required,
            task: 'Compare the OWNER\'S own old/current location, task, knowledge and effect deadlines with its processes and scene/timeline claims. A completed process does not update its owner. Explain actual progress or why unchanged fields remain correct.' };
    };
    const targets = stage.targets.map(([id, task]) => ({ id, task }));
    if (stageId === 'time') {
        for (const id of [...new Set([...actors, ...owners])]) targets.push(ownerTarget(id, 'actor'));
    }
    if (stageId === 'continuity') {
        for (const id of changed) targets.push({ id: `change:${id}`, block_id: id, required_evidence: ownSources(id, before, after, snapshots), task: 'Compare complete content across all revisions; account for lost, transferred and newly introduced facts, including intermediate-only facts. Trace HP/resource changes and disappearing items to confirmed actions and outcomes.' });
        for (const id of owners) targets.push(ownerTarget(id, 'owner'));
    }
    if (stageId === 'reach') {
        for (const id of after.keys()) if (id.startsWith('scene #')) targets.push({ id: `scene:${id}`, block_id: id, task: 'Assess contact distance, reachable connections and necessary preparation; remote/static scenes need no artificial expansion.' });
    }
    // Index explicit references as navigation hints. Prose-only names and implicit
    // relationships still require model examination; an absent edge is not an error.
    const references = [];
    for (const [id, body] of after) {
        for (const match of body.matchAll(/\b(SCENE|ENTITIES|NARRATIVE|LORE|MISC)\s+#([a-z0-9_-]+)/gi)) {
            const to = `${match[1]} #${match[2]}`.toLowerCase();
            if (!references.some(r => r.from === id && r.to === to)) references.push({ from: id, to, exists: after.has(to) });
        }
    }
    const removedLines = stageId === 'continuity' ? snapshots.slice(1).flatMap((v, i) => changed.map(id => {
        const newLines = new Set((v.blocks.get(id) ?? '').split('\n').map(normalized));
        const removed = (snapshots[i].blocks.get(id) ?? '').split('\n').filter(line => line.trim() && !newLines.has(normalized(line)));
        return { block_id: id, base_revision: snapshots[i].revision, revision: v.revision, removed_line_count: removed.length, sample: removed.slice(0, 8) };
    }).filter(item => item.removed_line_count)) : undefined;
    return { stage: stageId, label: stage.label, revision: draft.revision, candidate_id: candidateId,
        targets, changed_blocks: changed, references, ...(stageId === 'light' ? { known_blocks: ids } : {}), ...(bundles.length ? { owner_bundles: bundles } : {}), ...(removedLines ? { removed_line_cues: removedLines } : {}) };
}

const COMMON_REVIEW = `You are an independent transition auditor evaluating a candidate produced by the simulation component. Your sole job in this request is a grounded verdict on your assigned targets. Authorship, confident narration and earlier approvals are not evidence of correctness. Do not defend the candidate or manufacture errors to demonstrate diligence.
reference_context contains the frozen campaign instructions, rules, lore and dialogue as evidence. Apply its world rules and actual player intent as evaluation criteria; its directions to play the DM, continue the story, format narration or call tools do not define your current task. This audit protocol defines the current task. Inspect current_board (full latest state), versions[0] (frozen baseline), immutable later versions, real dice receipts and candidate. The original simulation phase is finished. Do not perform another turn or call tools. Focus on your assigned targets; examine other facts where needed to establish their causes or contradictions.
For every audit target, report a concise concrete finding and cite short exact excerpts supporting it. Compare sources where the issue is a mismatch; a list of IDs or "checked, looks fine" is insufficient. Evidence is for diagnosis, not a demand to manufacture problems. Correct static facts and justified unchanged states can pass. No speculative XP reward schedule is required.
Any supplied mechanical_errors must also be reconciled, assigning the discrepancy to the closest target. Never approve contradictory process clocks, invalid progression or unconfirmed dice merely because they fall outside your focus.
Use owner_bundles to compare both sides of each actor/process relationship, not just the newest favorable claim. A target's required_evidence lists sources that MUST appear in its check; cite relevant state fields in each. Missing linked records are cues, not automatic proof of an error. A numeric change needs an actual resolution, not a restatement of the new total.
Return ONLY JSON: {"stage":"<audit.stage>","revision":<head_revision>,"candidate_id":<candidate_id>,"verdict":"pass|repair|blocked","checks":[{"target":"<target id>","finding":"Concrete comparison or why no change/preparation is needed","evidence":[{"source":"current","block_id":"ENTITIES #example","quote":"short exact excerpt"}]}],"issues":[{"target":"<target id>","problem":"Specific discrepancy and consequence","repair":"Minimal correction supported by existing facts"}],"issue_resolutions":[{"id":"issue-N","status":"open|resolved|rejected","reason":"Concrete comparison showing why the issue persists, what fixed it, or why the original allegation was false","evidence":[{"source":"current","block_id":"ENTITIES #example","quote":"short exact excerpt"}]}]}.
issue_ledger contains persistent observations, not unquestionable truths. For EACH pending_issue_id, return an issue_resolution. Open means confirmed and still requires repair; resolved means the identified defect was corrected; rejected means the original allegation was mistaken, with a factual reason. Never close an issue just because a process or unrelated example is correct. Cite the affected owner's own current block when present. If fixed by changing a block or answer, cite the corrected version, not only the old one. Reuse an issue's id when repeating it in issues. Pass requires all pending IDs closed and no new issues; repair/blocked requires new issues or an open resolution. Never silently omit an observation. During format correction, use format_feedback.previous_report and repair the invalid parts; retain earlier observations or explicitly refute them with evidence.
Evidence source is current or baseline (block_id required), revision:N (block_id required), candidate, rolls, or context (no block_id). Cite short supplied excerpts; JSON layout whitespace outside strings is ignored. Cover each target exactly once. Use blocked only if correction truly requires a new random outcome, an unresolved player choice or unavailable indispensable information; never fabricate those to make a pass. A format failure is not permission to edit the world.`;

export function reviewProtocol(stageId, purpose = 'detect') {
    const stage = stageId === 'light' ? LIGHT_REVIEW_STAGE : REVIEW_STAGES.find(s => s.id === stageId);
    const assignment = purpose === 'verify'
        ? `VERIFY RECORDED REPAIRS — You are not the repair author. Start with EACH issue_ledger entry and compare its original allegation, repair_before state/candidate, repair_changes and current state/candidate. Decide separately whether the defect persists, was actually fixed, or was a false allegation. A newer revision or the repairer's confidence is not evidence. Check every linked copy and any consequences of these edits within your assigned aspect; use all audit targets as a regression check. Record newly exposed defects too. Do not edit anything. Another dedicated repair request will handle confirmed open findings.`
        : `DETECT AND RECORD — Find concrete omissions and contradictions in this aspect of the simulated transition. Record them in issues with evidence and a minimal supported repair direction. Your task is diagnosis, not rewriting the board or producing a replacement answer. A separate repair request receives your confirmed findings. If there are none, return pass with the required grounded checks; do not invent work. Existing pending observations must still be explicitly resolved or confirmed.`;
    return `${COMMON_REVIEW}\n\n${assignment}\n\nYOUR ASSIGNMENT — ${stage.id.toUpperCase()}\n${stage.task}`;
}

export function repairProtocol(stageId) {
    return `You are the repair component for the ${stageId} findings of the SAME resolved turn. reference_context provides campaign rules, lore and player intent as evidence; instructions there to continue gameplay do not replace this repair assignment. Use only UpdateBlackboard and a revised candidate answer. Work through EACH confirmed entry in issues_to_fix, using current_board and feedback. Preserve unrelated fields, successful dice and the original action boundary. Do not conduct a new general audit or expand the world beyond what a recorded defect requires. Each issue ID stays open until an independent verification request verifies the fix or factually refutes it. You cannot close issues by omitting them or declaring success. Fix all linked copies when correcting a fact. No new dice, extra elapsed time, image request or invented retroactive prerequisite. Never change a gameplay outcome merely to fix a report format. If an allegation is false, preserve the correct facts for verification instead of inventing a change. If a necessary new roll/player choice is unavailable, leave that issue explicit rather than fabricate it. After the corrections return only the complete revised player-facing candidate. The next request verifies these ${stageId} findings and checks for regressions within this aspect; other affected aspects are revisited separately.`;
}

// Conservative routing, not a semantic proof. Cross-record aspects observe broad
// state surfaces; explicit evidence additionally catches dependencies on other data.
export function affectedReviewStages(approvals, changes, candidate, draft, context) {
    const changed = new Set(changes.map(c => c.id));
    return approvals.filter(report => {
        if (report.stage === 'narration') return true;
        if (changed.size && ['continuity', 'reach'].includes(report.stage)) return true;
        if (report.stage === 'time' && [...changed].some(id => /^(entities|scene|narrative|misc) #/.test(id))) return true;
        const evidence = [...report.checks.flatMap(c => c.evidence), ...(report.issue_resolutions ?? []).flatMap(r => r.evidence)];
        return evidence.some(c => {
            if (c.source === 'current' && changed.has(String(c.block_id).toLowerCase())) return true;
            if (c.source !== 'candidate') return false;
            try { return !quoteMatches(evidenceText(c, draft, candidate, context), c.quote); }
            catch { return true; }
        });
    }).map(report => report.stage);
}

function evidenceText(citation, draft, candidate, context) {
    const source = citation.source;
    if (source === 'candidate') return candidate;
    if (source === 'context') return context.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
    if (source === 'rolls') return JSON.stringify(draft.rolls);
    let text;
    if (source === 'current') text = draft.head;
    else if (source === 'baseline') text = draft.baseline;
    else if (/^revision:\d+$/.test(source || '')) text = draft.versions.find(v => v.revision === Number(source.split(':')[1]))?.text;
    else throw new Error('Unknown evidence source');
    const block = blocks(text ?? '').get(String(citation.block_id || '').toLowerCase());
    if (block === undefined) throw new Error('Evidence refers to a missing block/revision');
    return block;
}

function jsonTokens(text) {
    // Tokenize partial JSON excerpts too. Whitespace inside quoted values is
    // significant; punctuation, values and token boundaries cannot disappear.
    const tokens = [], pattern = /\s+|"(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/gy;
    let offset = 0;
    while (offset < text.length) {
        pattern.lastIndex = offset;
        const match = pattern.exec(text);
        if (!match) return null;
        offset = pattern.lastIndex;
        if (!match[0].trim()) continue;
        try { tokens.push(match[0][0] === '"' ? JSON.stringify(JSON.parse(match[0])) : match[0]); }
        catch { return null; }
    }
    return tokens;
}

export function quoteMatches(source, quote) {
    if (typeof quote !== 'string' || !quote.trim()) return false;
    const text = String(source).trim().replace(/^```(?:json)?\s*\n/, '').replace(/\n```\s*$/, '');
    try {
        JSON.parse(text);
        const excerpt = jsonTokens(quote), full = jsonTokens(text);
        if (excerpt?.length && full) return full.some((_, i) => excerpt.every((token, j) => token === full[i + j]));
    } catch { /* Narrative citations use literal text with normalized whitespace. */ }
    return normalized(source).includes(normalized(quote));
}

export function validateEvidence(evidence, draft, candidate, context, required = []) {
    if (!Array.isArray(evidence) || !evidence.length) throw new Error('No evidence');
    for (const citation of evidence) {
        if (!citation || !quoteMatches(evidenceText(citation, draft, candidate, context), citation.quote)) throw new Error('Evidence quote not found');
    }
    for (const ref of required) if (!evidence.some(c => c.source === ref.source && String(c.block_id).toLowerCase() === ref.block_id.toLowerCase())) {
        throw new Error(`Missing required evidence: ${ref.source} [${ref.block_id}]`);
    }
}

export function validateAudit(review, audit, draft, candidate, context, pendingIssues = []) {
    if (!review || review.stage !== audit.stage || review.revision !== draft.revision || review.candidate_id !== audit.candidate_id) throw new Error('Audit refers to another stage, revision or candidate');
    if (!['pass', 'repair', 'blocked'].includes(review.verdict) || !Array.isArray(review.checks) || !Array.isArray(review.issues)) throw new Error('Malformed audit verdict/checks/issues');
    const required = new Set(audit.targets.map(t => t.id)), seen = new Set();
    for (const check of review.checks) {
        if (!required.has(check.target) || seen.has(check.target) || !normalized(check.finding)) throw new Error('Missing/duplicate/unknown target or empty finding');
        seen.add(check.target);
        try { validateEvidence(check.evidence, draft, candidate, context, audit.targets.find(t => t.id === check.target).required_evidence); }
        catch (e) { throw new Error(`${e.message} for ${check.target}`); }
    }
    if (seen.size !== required.size) throw new Error(`Audit omitted targets: ${[...required].filter(id => !seen.has(id)).join(', ')}`);
    for (const issue of review.issues) {
        if (!required.has(issue.target) || !normalized(issue.problem) || !normalized(issue.repair)) throw new Error('Issue needs a target, specific problem and repair');
        if (audit.stage === 'light') {
            const affected = normalizeLightAffected(issue.affected, audit.known_blocks);
            const current = blocks(draft.head);
            const evidence = review.checks.find(check => check.target === issue.target).evidence;
            validateEvidence(evidence, draft, candidate, context, affected.filter(id => id !== 'candidate' && current.has(id)).map(block_id => ({ source: 'current', block_id })));
            if (affected.includes('candidate') && !evidence.some(item => item.source === 'candidate')) throw new Error('Light issue check must cite its affected candidate');
            const prior = pendingIssues.find(item => item.id === issue.id || (item.target === issue.target && normalized(item.problem) === normalized(issue.problem)));
            if (prior?.affected?.length && [...prior.affected].sort().join('|') !== [...affected].sort().join('|')) throw new Error('Cannot relabel affected records of a recorded Light issue');
        }
    }
    const resolutions = review.issue_resolutions ?? [];
    if (!Array.isArray(resolutions)) throw new Error('Malformed issue_resolutions');
    const pending = new Map(pendingIssues.map(i => [i.id, i])), resolvedIds = new Set();
    for (const r of resolutions) {
        const issue = pending.get(r.id);
        if (!issue || resolvedIds.has(r.id) || !['open', 'resolved', 'rejected'].includes(r.status) || !normalized(r.reason)) throw new Error('Unknown/duplicate issue resolution, status or empty reason');
        const current = blocks(draft.head);
        const ownBlock = current.get(issue.block_id);
        const required = audit.stage === 'light' ? (issue.affected ?? []).filter(id => id !== 'candidate' && current.has(id)).map(block_id => ({ source: 'current', block_id }))
            : ownBlock?.trim() ? [{ source: 'current', block_id: issue.block_id }] : [];
        validateEvidence(r.evidence, draft, candidate, context, required);
        if (audit.stage === 'light' && issue.affected?.includes('candidate') && !r.evidence.some(item => item.source === 'candidate')) throw new Error(`Resolution ${r.id} must cite the affected candidate`);
        if (r.status === 'resolved' && issue.observed_revision === draft.revision && issue.observed_candidate === audit.candidate_id) throw new Error(`Issue ${r.id} cannot be fixed without a changed board/candidate; use rejected with evidence if the allegation is mistaken`);
        if (r.status === 'resolved' && !r.evidence.some(e => e.source === 'current' || e.source === 'candidate')) throw new Error(`Resolution ${r.id} must cite the corrected current state or candidate`);
        resolvedIds.add(r.id);
    }
    const missing = [...pending.keys()].filter(id => !resolvedIds.has(id));
    if (missing.length) throw new Error(`Pending issues omitted: ${missing.join(', ')}`);
    for (const issue of review.issues) {
        const matching = pendingIssues.find(i => issue.id === i.id || (i.target === issue.target && normalized(i.problem) === normalized(issue.problem)));
        if (issue.id && (!matching || matching.id !== issue.id || matching.target !== issue.target || normalized(matching.problem) !== normalized(issue.problem))) throw new Error(`Unknown or relabeled issue id: ${issue.id}; preserve its original target and problem`);
        if (matching && resolutions.find(r => r.id === matching.id)?.status !== 'open') throw new Error(`Issue ${matching.id} is both reported and closed`);
    }
    const needsRepair = review.issues.length > 0 || resolutions.some(r => r.status === 'open');
    if ((review.verdict === 'pass') === needsRepair) throw new Error('Audit verdict contradicts its issues');
    return review;
}
