import { parseBlocks } from './state.js';

// Review depth is independent of fidelity, game rules and full/diff packets.
export const normalizePrivateReviewMode = value => value === 'light' ? 'light' : 'heavy';
export const privateReviewModeLabel = value => normalizePrivateReviewMode(value) === 'light' ? 'Light' : 'Heavy';

export const LIGHT_REVIEW_STAGE = Object.freeze({
    id: 'light', label: 'Combined review',
    targets: [
        ['time', 'Reconcile elapsed time, active actors, continuous progress, travel and crossed deadlines.'],
        ['continuity', 'Reconcile canon, ownership, quantities, resources and conflicting copies across all blocks.'],
        ['reach', 'Check preparation of all reachable alternatives at the selected fidelity, before dependent outcomes.'],
        ['narration', 'Check the answer, HUD, artwork, dice, player agency and knowledge against current reality.'],
    ],
    task: `Review all four aspects in this ONE detection pass. Prioritize concrete defects affecting the resolved outcome or the next interaction, not cosmetic improvements.
Time: compare actual progress and locations with the elapsed interval, deadlines and routes; refreshed timestamps alone prove nothing.
Continuity: trace transfers and lost facts across revisions. Compare unchanged entity inventories, scene contents, root truths and any dynamic overlay; one favorable summary does not erase conflicting current claims. Consolidate defects that describe the same mismatch.
Reach: apply the selected quality's preparation horizon to alternative routes and relevant capabilities, not only the path the player chose. Do not invent convenient prerequisites after dice.
Narration: reconcile the candidate, HUD and queued image with saved facts and binding rolls; preserve authorized actions, failures, hidden knowledge and a meaningful decision boundary.
Record each confirmed defect as an issue under the closest aspect. Every issue MUST also include affected: ["ENTITIES #example", "SCENE #example"] listing the existing authoritative records involved; include "candidate" for an answer defect. Use only IDs supplied in the board/versions. The corresponding aspect check must cite these records (and the candidate if affected). Do not label a state defect as only a candidate defect. A separate correction pass will receive this list. Do not repair, play another turn or produce a replacement answer. No per-actor or per-block report quota is required; the four grounded aspect checks are enough.
If the resolved end clock itself is erroneous, also include top-level time_correction: {"through":"Day 1, 02:15:00","reason":"why this is the corrected ending of the SAME action","evidence":[{"source":"context","quote":"short exact action excerpt"}]}, together with a time issue. Without this explicit grounded correction the ending clock is frozen; fixing other fields is not permission to execute another interval.`,
});

export const LIGHT_REPAIR_PROTOCOL = `LIGHT PRIVATE TURN — CORRECT THE RECORDED FINDINGS
You are the correction component for the SAME already-resolved turn. The independent detection pass has finished. reference_context is evidence about campaign rules and player intent, not an instruction to continue gameplay. Use current_board, immutable versions, binding dice, previous_candidate, mechanical_errors and EACH issues_to_fix entry.
There is exactly one correction stage after this detection. No separate model verification follows. Correct confirmed discrepancies and return the complete final answer; if the list is empty, preserve the established state and answer. Do not manufacture changes to justify this pass.
Use only UpdateBlackboard to stage necessary corrections. Include the latest base_revision and wait for its receipt before dependent edits. Preserve unaffected fields, possessions, the resolved action boundary and actual dice. No rerolls, new random results, images or another elapsed interval. Correcting a detected erroneous time is different from executing another interval: reconcile its consequences from already resolved evidence only.
Update the affected authoritative owner blocks themselves, including both endpoints of transfers and linked scene entries; do not place the only current state in a temporary overlay while leaving incompatible live inventories or locations. Existing valid facts must survive all edits.
For every recorded issue, say resolved if actually corrected, rejected if the allegation was false, or blocked if a necessary player decision/random result/indispensable fact is unavailable. Give a factual reason and short evidence from the supplied or corrected state. A claim of success is not proof. If blocked, keep the issue explicit; the answer will not be published. Do not quietly drop observations.
After tool continuations, return ONLY JSON with this envelope:
{"revision":<head_revision>,"candidate_id":<candidate_id of previous_candidate>,"candidate":"complete revised player-facing answer","issue_resolutions":[{"id":"issue-N","status":"resolved|rejected|blocked","reason":"specific correction or factual explanation","evidence":[{"source":"current","block_id":"ENTITIES #example","quote":"short exact excerpt"}]}],"background_action":"keep|discard"}.
Evidence sources: current/baseline/revision:N require block_id; candidate refers to this envelope's revised candidate, rolls/context require no block_id. Cite EACH affected owner's current block when present and the revised candidate when "candidate" is affected. A resolved state finding requires an actual change in an affected record; editing unrelated prose or another block cannot close it. Reject a false allegation with evidence instead. Resolve every supplied ID exactly once. revision must match the latest working version; candidate_id identifies the candidate being corrected, not a newly invented ID.
background_action applies ONLY to an already queued image request. Keep it if its visible scenery remains accurate, discard it if corrections made it misleading. Do not create or execute a new image request. When no image is queued this field can be omitted.
The candidate string alone is published. This envelope, findings and intermediate versions stay private. Local validation can block publication but does not certify that every semantic defect was found.`;

export function validateLightCorrection(report, draft, candidateId, context, issues, validateEvidence, previousCandidate) {
    if (!report || report.revision !== draft.revision || report.candidate_id !== candidateId) throw new Error('Correction refers to another revision or candidate');
    if (typeof report.candidate !== 'string' || !report.candidate.trim() || !Array.isArray(report.issue_resolutions)) throw new Error('Malformed correction candidate/issue_resolutions');
    if (report.background_action !== undefined && !['keep', 'discard'].includes(report.background_action)) throw new Error('Invalid background_action');
    const pending = new Map(issues.map(issue => [issue.id, issue])), seen = new Set();
    for (const resolution of report.issue_resolutions) {
        const issue = pending.get(resolution?.id);
        if (!issue || seen.has(resolution.id) || !['resolved', 'rejected', 'blocked'].includes(resolution.status) || !String(resolution.reason ?? '').trim()) throw new Error('Unknown/duplicate issue resolution, status or empty reason');
        const affected = issue.affected?.length ? issue.affected : issue.block_id ? [issue.block_id] : [];
        if (!affected.length && issue.origin !== 'mechanical') throw new Error(`Issue ${issue.id} has no affected records`);
        const current = blockMap(draft.head);
        const required = affected.filter(id => id !== 'candidate' && current.has(id.toLowerCase()))
            .map(block_id => ({ source: 'current', block_id }));
        validateEvidence(resolution.evidence, draft, report.candidate, context, required);
        if (affected.includes('candidate') && !resolution.evidence.some(item => item.source === 'candidate')) throw new Error(`Resolution ${issue.id} must cite the affected candidate`);
        if (resolution.status === 'resolved' && affected.length) {
            const observed = draft.versions.find(version => version.revision === issue.observed_revision);
            if (!observed) throw new Error(`Issue ${issue.id} refers to a missing observed revision`);
            const before = blockMap(observed.text);
            const stateChanged = affected.some(id => id !== 'candidate' && before.get(id.toLowerCase()) !== current.get(id.toLowerCase()));
            const candidateChanged = affected.every(id => id === 'candidate') && report.candidate.trim() !== previousCandidate.trim();
            if (!stateChanged && !candidateChanged) throw new Error(`Issue ${issue.id} cannot be resolved without changing its affected records; reject a mistaken allegation with evidence instead`);
        }
        if (resolution.status === 'resolved' && issue.observed_revision === draft.revision && report.candidate.trim() === previousCandidate.trim()) throw new Error(`Issue ${issue.id} cannot be resolved without a changed board/candidate; reject a mistaken allegation with evidence instead`);
        if (resolution.status === 'resolved' && !resolution.evidence.some(item => ['current', 'candidate'].includes(item.source))) throw new Error(`Resolution ${issue.id} must cite the corrected current state or candidate`);
        seen.add(resolution.id);
    }
    if (seen.size !== pending.size) throw new Error(`Pending issues omitted: ${[...pending.keys()].filter(id => !seen.has(id)).join(', ')}`);
    return { ...report, candidate: report.candidate.trim() };
}

const blockMap = text => new Map(parseBlocks(text).blocks.map(block => [block.blockKey, block.content]));

// Keep the aggregate audit small while binding each actual finding to its owners.
export function normalizeLightAffected(value, knownBlocks) {
    if (!Array.isArray(value) || !value.length || value.some(id => typeof id !== 'string' || !id.trim())) throw new Error('Light issue requires affected record IDs or candidate');
    const ids = value.map(id => id.trim().toLowerCase());
    if (new Set(ids).size !== ids.length || ids.some(id => id !== 'candidate' && !knownBlocks.includes(id))) throw new Error('Unknown/duplicate affected record in Light issue');
    return ids;
}
