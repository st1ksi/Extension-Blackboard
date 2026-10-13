# Changelog

This file records development history, not a claim that every version was published
as a GitHub Release. Entries summarize previous notes. Dates are omitted where no
release date was established. Current behavior is described in [README.md](README.md).

## Unreleased

- Added the full AGPL-3.0 license and `.gitignore` for local development artifacts.
- Replaced accumulated README notes with public installation, usage, feature and
  requirements documentation, and this separate changelog.

## 1.12.1 — Minimal scrollbars

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
