// Execution instructions are independent of fidelity and game-system profiles.
export const STANDARD_TURN_INSTRUCTIONS = `BLACKBOARD EXECUTION MODE — STANDARD
Resolve the player's request using the chosen quality and game-system instructions. Before the final reply, check time and actors, continuity of facts/resources, preparation of the next contact, and agreement between narration and saved state, at the selected fidelity. Correct discrepancies within this ordinary generation and confirm successful tool updates. Do not request a separate reviewer, return an audit report, or wait for a private publication stage. Keep the self-check private; return the player-facing answer. Checks and corrections do not advance time again.`;

export const PRIVATE_TURN_INSTRUCTIONS = `BLACKBOARD EXECUTION MODE — PRIVATE TURNS
The extension runs simulation, then handles each review aspect in sequence: detect and record findings, repair confirmed findings if any, independently verify those repairs before proceeding. A correct aspect needs no repair request. Edits may trigger rechecking of affected earlier aspects. Follow the specific task and allowed tools of the current request. Quality and game-system instructions remain the criteria, not permission to perform another stage. The injected world_blackboard is the frozen baseline; the supplied VERSION PACKET/current_board is the working state. Intermediate revisions and issue reports stay private; only the accepted final state is attached to the published answer. Technical retries, review and repair do not advance world time. Respect the selected fidelity's scope and budget; this execution mode does not turn Low or Mid into Ultra.`;

export function executionInstructions(settings) {
    return settings.privateReview ? PRIVATE_TURN_INSTRUCTIONS : STANDARD_TURN_INSTRUCTIONS;
}

// Preserve the effective pre-1.6.2 mode once, then the checkbox alone controls it.
export function migrateExecutionSettings(settings) {
    if (settings.executionModeVersion === 1) return false;
    settings.privateReview = (settings.privateReview ?? true) && ['high', 'ultra', 'custom'].includes(settings.simulationFidelity || 'mid');
    settings.executionModeVersion = 1;
    return true;
}

export const PRIVATE_PROTOCOL = `OBJECTIVE BLACKBOARD PRIVATE TURN PROTOCOL (overrides ordinary save/reveal workflow for this request).
The injected world_blackboard is revision 0, frozen canonical state. The VERSION PACKET is the authoritative working state for this turn. Revisions are ordered, immutable snapshots; diff changes include before and after, null means absence. Reconstruct the latest revision; never treat an earlier snapshot as current or narrate edits as already published.
UpdateBlackboard stages a new revision only. Include base_revision from the packet and wait for its receipt before a dependent update; do not issue several changes against an obsolete revision. Commit causal preparation before dependent dice. Preserve existing facts/fields; update both source and destination of transfers. Successful RollTheDice results are binding; never reroll to repair narration. Error receipts contain no roll: correct rejected arguments before resolving that check. Use compact formulas such as 1d20+5 or 2d20kh1+5. Player declarations are attempts, not outcomes or permission to substitute new voluntary actions.
Advance only the actual resolved interval ONCE, including interrupted tasks. Do not advance time again during review/repair. Reconcile active offscreen processes even in recently edited blocks; static blocks need no artificial changes.
Apply the selected quality tier's scope and detail budget. Execution mode does not upgrade that tier; the compact process index below accounts only for relevant actual processes, not an obligation to invent wider-world detail.
Keep a compact [MISC #simulation_processes] JSON block: {"version":1,"through":"Day 1, 02:15:00","processes":[{"id":"stable_id","owner":"ENTITIES #npc","status":"active","accounted_through":"Day 1, 02:15:00","next_at":"Day 1, 02:16:00","note":"Task, progress/blocker and next event"}]}. Status: active/blocked/completed/cancelled; next_at is null if no scheduled next event. Use the SAME through time as world_clock (including seconds); active/blocked processes are accounted through that time, closed processes may retain their final earlier timestamp. Record completed/cancelled disposition before later pruning. Track actual movers, scheduled events and expiring effects; do not manufacture background processes for static facts. Initialize from existing timed facts without resetting their elapsed progress. An empty list explicitly means no active processes. OOC uses unchanged time.
Advancement, when used by the campaign, is assessed after actual achievements; do not pre-list speculative awards. Preserve the established progression record without duplicate awards; use only the selected game profile’s calculations.
After staging all changes, return only a candidate player-facing answer. It will be privately audited before publication.
During repair use only UpdateBlackboard; no new dice, image request or additional elapsed time. Correct the transition and candidate answer against already resolved facts. Do not turn failed attempts into different successful actions.`;
