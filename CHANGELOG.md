# Changelog

This file records development history, not a claim that every version was published
as a GitHub Release. Entries summarize previous notes. Dates are omitted where no
release date was established. Current behavior is described in [README.md](README.md).

## 1.14.0 — 2026-10-17 — Chat-specific settings

- Choose Global defaults or This chat in both native settings and Control Panel.
  Existing chats inherit defaults until explicitly given an independent settings copy.
- Isolate game profile, fidelity/budgets, simulation, rollback, Private Turns,
  backgrounds and custom instructions per chat, stored in its metadata.
- Retain chat preferences when switching back to defaults; copy current defaults
  into an active local configuration only through the explicit reset action.
- Refresh controls, prompts and tools when switching chats. Reject stale settings
  actions while a different chat is still loading. Keep prompt drafts separate by scope.
- Branches inherit current chat settings; board rollback does not rewrite preferences.
- Keep scope bookkeeping outside private recovery fingerprints and freeze each
  private turn's effective settings. Identical settings preserve checkpoint compatibility.

## 1.13.1 — 2026-10-15 — Light reviews and durable private reports

- Public release of the Heavy/Light review selector and durable report export,
  including the changes developed in 1.13.0 below.
- Save the latest private report per account, character and chat in separate
  browser storage, including audit findings, revisions and final background status.
- Keep reports available after page reloads and chat switching; retain the last
  completion when a later attempt fails. Private details stay outside chat and prompts.
- Save the full report before publication and checkpoint cleanup. Storage failures
  preserve recovery data rather than silently losing the audit.
- Export explicitly marked summaries when only older public message statistics
  survive; missing audits and intermediate versions are never reconstructed.

## 1.13.0 — Heavy and Light Private Turns

- Added an independent review-mode selector in native settings and Control Panel.
  Heavy preserves the existing specialized audits, targeted repairs and verification.
- Light combines all audit aspects into one detection pass and one correction pass
  using recorded findings, without a subsequent model verification pass. Local
  validation and publication safeguards remain; tool continuations can add requests.
- Light findings retain affected record IDs and require corresponding evidence;
  unrelated board or prose edits cannot resolve an unchanged state defect.
- Private Turns enablement and diff/full revision history remain separate settings.
  Mode selection is retained when private execution is disabled.
- Recovery checkpoints and exports retain the selected review mode; old settings
  and checkpoints default to Heavy for compatibility.
- Developed and tested as a separate local copy; first published with 1.13.1.

## 1.12.1 — Minimal scrollbars

- First public release on 2026-10-13, including the full AGPL-3.0 license,
  `.gitignore`, installation and usage documentation, and this separate changelog.
- Thin muted thumbs and transparent tracks throughout custom panels.
- Hidden Chromium/WebKit arrow buttons; Firefox thin-scrollbar styling.

## 1.12.0 — Inline editing

- Pencil on every card, including unsectioned text; inline editor with Done, Cancel
  and Escape. Save changes or Ctrl/Cmd+S commits through normal validation.
- Exact source-range changes preserve neighboring formatting and fenced data.
- Shared drafts retain Copy, focus during statistics updates, chat isolation,
  closing/reopening retention and concurrent-update conflict protection.

## 1.11.0 — Cards and navigation

- Default Blocks view and complete Full text editor.
- Rounded category/tag pills and matching cards with colored outlines and inward glow.
- Searchable links, keyboard navigation and selected-card highlighting.
- Bounded link scrolling, wrapped long content, safe plain-text display and distinct
  targets for duplicate draft headers. View switching preserves the source.

## 1.10.0 — Shared workspace

- One inspector for wand, settings and `/blackboard`, paired with Control Panel on
  wide desktop screens; independent closing and narrow/mobile navigation.
- Control Panel wand entry, statistics, diagnostics and editing tools.
- Per-chat manual drafts with live updates for clean editors and conflict protection
  for unsaved edits. Drafts survive chat switching within the tab.

## 1.9.0 — Custom Control Panel

- Optional right-side settings panel with dark blue/cyan styling.
- Settings/Instructions tabs, fidelity cards, prompt editors and keyboard navigation.
- Standard/custom settings share handlers and saved values; prompt text remains
  a draft until Save. Narrow layouts and focus return supported.

## 1.8.3 — Warning background

- Warm dark `#262020` background for the red setup warning.

## 1.8.2 — Status panel appearance

- Dark setup and Private Turns panels, muted colored borders and inward glow.

## 1.8.1 — Setup checks

- Enable Simulation Blackboard master switch, preserving the `functionTool` key.
- Pre-generation setup panel with Check again, Enable settings and Disable Blackboard actions.
- Function-calling and system-prompt checks; cancellation and continuation without
  duplicating the user message. Native cached tool availability is refreshed.
- Background-only operation while simulation is disabled.
- English runtime UI/errors, preset-driven budget labels and browser capability
  checks for durable Private Turns, including LAN HTTP explanations.

## 1.8.0 — Rebuilt quality tiers

- Low, Mid and High rebuilt from Ultra v6's causal/time principles with smaller horizons.
- Board corridors: Low 1,000–2,000; Mid 2,000–4,000; High 4,000–8,000;
  Ultra 6,000–21,000 tokens.
- Lowering fidelity preserves existing possessions, progression and consequences.
- Generated sources, selection, reset and known-prompt migration use current presets.

## 1.7.3 — Wider Ultra horizon

- Ultra corridor expanded to 6,000–21,000 tokens with meaningful minimum coverage.
- Full actionable preparation through distance 2, structured distance 3 and relevant
  farther context. Expansion preserves closed contents and existing causes.
- Current board-size feedback in update receipts and private version packets.

## 1.7.2 — Ultra v6 default

- Ultra selection, initialization and reset use the separated v6 living-world base.
- Prompt synchronization rebuilds bundles and the Ultra export.
- Known v6 overrides resolve to current instructions; explicit legacy/custom sources retained.

## 1.7.1 — Independent backgrounds

- Background instructions/tool gating separated from known quality bases, across all tiers.
- Ordinary calls generate directly; private requests queue for after publication.
- Review/repair cannot generate images; arbitrary custom text is preserved.

## 1.7.0 — Detect, repair, verify

- Each aspect detects findings before a separate targeted repair and verification.
- Changed board/candidate facts invalidate affected approvals and route relevant rechecks.
- Grouped stage findings and invalidation logs in private checkpoints/exports.
- Checkpoint schema v4 migration preserves work, dice and issue history.
- Limits remain four repairs overall, two per aspect and 48 logical requests;
  resume does not reset budgets. Unresolved findings block publication.

## 1.6.2 — Independent Private Turns

- Checkbox controls private execution at every fidelity, including Low/Mid.
- Standard/private instructions separated from quality and game profiles.
- New installations start in ordinary mode; migration preserves prior effective mode.
- Fidelity changes no longer silently toggle Private Turns.

## 1.6.1 — Game profiles

- Universal and D&D 5e selector, separating quality rules from game-specific instructions.
- Campaign-owned Universal progression without automatic D&D calculations.
- Profile preview and exact-known-prompt migration, preserving arbitrary custom text.
- Global profile changes retain snapshots; paused turns require matching settings to resume.

## 1.6.0 — Persistent findings

- Stable issue IDs/history, retained parseable findings and explicit resolution evidence.
- Reviewer task separated from campaign reference context, using the configured model.
- Actor/process-owner bundles, before/after evidence and JSON-aware excerpt matching.
- Checkpoint migration and diagnostic exports without findings in chat/vector memory.

## 1.5.0 — Focused audits

- Separate requests for time/actors, facts/resources, reachable space and final answer.
- Current board, selected revision history, dice and focus-specific targets supplied to audits.
- Evidence/coverage validation, bounded repairs, format retries and saved pauses.
- Audit history, candidate versions and stage reports in private exports.

## 1.4.1 — Dice compatibility

- Cosmetic formula whitespace normalized before invoking installed RollTheDice.
- Empty results treated as errors; confirmed rolls binding; unknown outcomes pause
  rather than trigger an automatic reroll.
- Safe recovery of unambiguous legacy empty-dice checkpoints before later work.

## 1.4.0 — Recovery

- Durable IndexedDB checkpoints for context, revisions, dice, pending work and review counters.
- Bounded temporary-provider retries with countdown, Pause and Resume.
- Reload/resume without a duplicate action or deliberate replay of confirmed tools.
- Original chat/branch/settings checks and conservative uncertain-tool handling.

## Earlier standalone private-cycle work

Historical standalone notes documented staged review/publication through stock
SillyTavern prompt-building and reply-saving APIs, without a core patch or server
plugin. Tool journals exposed confirmed dice and background status. Those notes
also documented interceptor/streaming compatibility limits and removal of
experimental 1.2.x core hooks. No additional version number is assigned here
because those notes did not identify one for every change.

## 1.1.0 — Progression and state integrity

- Ultra v5 prompt with explicit progression and a validated XP ledger.
- Calculated totals, level eligibility, proficiency, corrections and sheet advancement.
- Actual-content STALE ages, cold-start/expansion distinction and token monitoring.
- Atomic multi-block validation and safeguards against silent loss of existing block IDs.
- Board/age snapshots for deletion, swipes and branches; redacted tool-message display.
- Inspector and explicit user commands for deliberate manual correction/clearing.

Later versions supersede earlier review sequencing, defaults and prompts. Automated
workflow checks do not prove the model's simulation quality.
