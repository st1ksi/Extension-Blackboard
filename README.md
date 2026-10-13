# Simulation Blackboard

Persistent world state for roleplay in [SillyTavern](https://github.com/SillyTavern/SillyTavern).
The extension gives the model a separate **Objective Blackboard** for locations,
characters, possessions, world time and events, with optional private review
before an answer is published.

The aim is to prepare relevant reality before the player encounters it: searching
a room should reveal its established contents, NPC plans should progress with time,
and facts should survive scene changes and branches. Prompts guide this behavior;
the extension validates structured updates and manages persistence. It cannot
guarantee that a model follows every instruction or finds every semantic error.

Supports **Universal** campaigns and **D&D 5e**, with four fidelity levels,
optional Private Turns and separately controlled scene backgrounds. This is a
browser UI extension. No core patch, server plugin, Extras installation or runtime
dependency build is needed for the Blackboard itself.

## Features

- **Persistent state per chat:** `SCENE`, `ENTITIES`, `NARRATIVE`, `LORE` and `MISC`
  blocks supplied to the model separately from the player-facing narrative.
- **Preparation before contact:** instructions for fixed causes, closed inventories,
  impartial outcomes, player agency and boundaries between world facts and player knowledge.
- **Time and continuity:** a world clock, scheduled processes, resource tracking,
  and unchanged-block diagnostics.
- **Quality presets:** Low, Mid, High and Ultra, plus custom instructions and budgets.
- **Optional private reviews:** focused detection, targeted repair when necessary,
  and verification before publication.
- **Recovery:** checkpointed private work, confirmed dice and pending requests can
  survive provider errors and page reloads.
- **History rollback:** saved board snapshots and block ages follow deletion,
  swipes and branches when rollback is enabled.
- **Custom UI:** colored navigation pills and cards, inline block editing, full
  source editing, statistics and a settings Control Panel.
- **D&D advancement:** calculated XP, level eligibility and proficiency from a
  validated ledger; Universal campaigns use their own progression conventions.
- **Optional backgrounds:** model-requested images through the configured
  SillyTavern Image Generation extension.

## Requirements

- **SillyTavern 1.19.0 or newer.** Clean-host compatibility checks use 1.19.0,
  release commit `06bde939f`.
- A **Chat Completion** connection with function calling supported by the selected
  model/configuration. Enable **function calling** in AI Response Configuration.
- For **Claude, Google AI Studio and Google Vertex AI**, enable **Use system prompt**.
- Keep **Enable Simulation Blackboard** and **Auto-inject Instructions & Blackboard
  into System Prompt** enabled for normal setup. Private Turns require auto-injection.

Optional requirements:

| Feature | Requirement |
| --- | --- |
| Actual model-requested dice | Install [D&D Dice](https://github.com/SillyTavern/Extension-Dice) and enable its **Use function tool** setting. Blackboard does not provide its own RNG. |
| Automatic backgrounds | Configure SillyTavern's [Image Generation](https://docs.sillytavern.app/extensions/stable-diffusion/) extension and enable **Automatic scene backgrounds** here. |
| Private Turns | Single-character chat; secure browser context; Web Locks, IndexedDB, SHA-256 and `crypto.randomUUID`; storage available for checkpoints. |

On the server computer, `http://localhost` can provide the required secure context.
On a phone or another LAN device, use **HTTPS with a certificate trusted by that
device**. Plain HTTP on a LAN IP may work for ordinary mode while Private Turns
are unavailable. Settings explain missing browser capabilities. Installing the
extension does not configure HTTPS on the server.

## Installation

### Git installation

1. Copy the URL of the repository containing this README.
2. Open **Extensions → Install extension**, paste the URL and install for the
   current user. Git must be installed on the SillyTavern host.
3. Reload the page and open **Extensions → Simulation Blackboard**.

Keep the directory name **`Extension-Blackboard`**, which the extension uses to load
templates. See SillyTavern's [extension installation guide](https://docs.sillytavern.app/extensions/).

### ZIP installation

Extract the included `Extension-Blackboard` folder into your user's extension
directory. For the default profile:

```text
SillyTavern/data/default-user/extensions/Extension-Blackboard/
  manifest.json
  index.js
  README.md
  ...
```

For another profile, replace `default-user` with its user handle. `manifest.json`
must be directly inside `Extension-Blackboard`, without another nested copy of
that folder. No `npm install` or build is needed to run the extension.

For updates, finish or pause the current generation, replace extension files and
reload. Do not copy SillyTavern core files or user settings from another installation.
Older experimental installations with Blackboard core hooks need those obsolete
hooks removed; a clean SillyTavern needs only this extension.

## Quick start

1. Configure function calling and provider system prompts as described above.
2. Open **Extensions → Simulation Blackboard → Open control panel**.
3. Select **Universal** for campaign-owned rules or **D&D 5e** for the D&D supplement.
4. Choose fidelity. **Mid** is the fresh-install default. Leave **Private Turns**
   off for ordinary generation or enable them for additional review calls.
5. Disable **Automatic scene backgrounds** if you do not want images, or configure
   Image Generation before leaving it on.
6. Supply your character/persona and scenario, then send an action. The model
   initializes an empty board; open **Objective Blackboard** in the wand menu to inspect it.

Fresh defaults: simulation, auto-injection, rollback and backgrounds enabled;
Mid fidelity; D&D profile; Private Turns disabled; diff history. Existing
installations retain compatible saved choices through migration.

Example: establish a warehouse with two exits, a sealed crate and a guard due to
return at a known time. Then write:

> I inspect the crate without opening it, then wait two minutes and listen for
> footsteps at the loading door.

The model should prepare relevant facts before resolving the inspection, advance
time once, account for active processes, update the board, and narrate only what
the character can perceive. This describes intended behavior, not a guarantee.

If **setup required** appears, choose **Enable settings & continue**, change the
settings manually and choose **Check again & continue**, or use **Disable
Blackboard & continue**. SillyTavern's **Stop** cancels the waiting generation.

## Fidelity and budgets

Corridors describe the **live board**, not instruction length, response limits or
the whole API context. They guide preparation; they do not automatically truncate
state or enforce complete coverage.

| Level | Board tokens | Preparation scope |
| --- | ---: | --- |
| Low — Lean | 1,000–2,000 | Minimal complete next-action contacts; concrete links to further destinations. |
| Mid — Balanced | 2,000–4,000 | Full immediate contacts; skeletons of alternative branches a few meaningful actions away; connected episode processes. |
| High — Deep | 4,000–8,000 | Full immediate contacts; structured distance-2 approaches and relevant distance-3 agendas, barriers and schedules. |
| Ultra — Living World | 6,000–21,000 | Full actionable preparation through distance 2, including inventories and actor psychology; structured distance 3 and relevant broader activity. |
| Custom | User-defined | Your quality instructions and target corridor. |

Distance follows routes, time, information, abilities and causal relationships;
it is not merely a physical radius. Lower levels reduce new preparation without
erasing established possessions, progression or consequences.

The engine monitor estimates tokens as characters divided by four. The inspector
uses SillyTavern's tokenizer when available. **STALE** counts user messages since
block contents changed, not elapsed world time; static facts need no artificial update.

## Private Turns and recovery

**Off:** ordinary SillyTavern generation and tool calls, with instructions to
self-check within that generation. No separate review or private recovery checkpoint.

**On:** simulation stages a working board and candidate answer, followed by four
aspects, each with detection before any focused repair and verification:

1. **Time and actors:** elapsed interval, ongoing plans, deadlines and expiring effects.
2. **Facts and resources:** continuity, transfers, quantities, injuries and duplicated claims.
3. **Reachable space:** preparation for actual next contacts and alternative routes.
4. **Final answer:** board/dice agreement, player agency and information disclosure.

Repairs can trigger rechecks of earlier aspects. The **same configured model**
performs these roles. A clean private turn requires at least four audit requests
in addition to simulation; repairs and retries add time, tokens and API usage.
Private execution does not stream its answer.

**Diff** supplies baseline plus versioned before/after history; **Full** supplies
complete historical revisions. Audits receive the full current board in either
mode. Only the accepted final snapshot accompanies the published answer. A compact
tool journal reports confirmed dice and background status.

Temporary provider failures can retry the current request after 60/120/240 seconds,
with a longer provider `Retry-After` taking precedence. Exhaustion or cancellation
pauses the saved turn. Authentication, billing and other permanent configuration
errors do not receive the same automatic retries.

For a paused turn, export diagnostics if needed, wait for the provider and choose
**Resume**. Restore the original chat/branch and protected settings if they changed.
Do not resend the player action while keeping that draft; use **Discard draft**
to abandon it intentionally. Resume uses the frozen context and remaining work,
without deliberately repeating confirmed dice or completed tools. Uncertain tool
outcomes, invalid reviews, missing player decisions or exhausted budgets may need
inspection rather than repeated Resume.

Private checkpoints live in **this browser's IndexedDB for this site address**.
They survive reload while storage is retained but do not automatically transfer
between devices, browsers or HTTP/HTTPS addresses. The last private-report export
is tab-local: download it before starting another turn.

## Inspector and settings

The wand menu's **Objective Blackboard** entry or `/bb` opens the shared inspector.
Wide desktop windows show it beside Control Panel; narrow layouts show one panel
at a time. Explicitly identified phones open the board alone. Desktop-site mode
can hide mobile identity; available width still limits paired panels.

- **Blocks:** colored pills jump to matching cards. Search filters links without
  hiding card content.
- **Pencil:** edit one card's contents. **Done** finishes; **Cancel** or Escape
  undoes changes made since opening that editor.
- **Full text:** edit complete source, including headers and structure.
- **Save changes** or Ctrl/Cmd+S: validate and commit the draft.
- **Copy / Load latest:** copy the complete draft or discard it and reload saved state.
- **Editing tools:** insert blocks, tidy formatting or clear the draft before Save.

Typing does not change saved state. Manual drafts survive closing and chat switching
within a tab but are cleared by page reload, unlike private recovery checkpoints.
Concurrent saved updates retain the manual draft and block Save until Load latest;
copy your edits first if needed. The inspector can reveal hidden campaign facts.

Control Panel and standard settings share saved values. Switches/selections apply
immediately; quality/background prompt edits have separate Save buttons. Selecting
a different fidelity preset replaces its custom quality override. Arbitrary custom
text is otherwise preserved and may need adjustment for a new game profile.

**Enable Simulation Blackboard** controls simulation prompts, updates and Private
Turns. **Automatic scene backgrounds** is separate and can work with simulation
disabled, using function calling, configured Image Generation and background
instructions. Ordinary calls generate images directly; accepted private requests
run after publication. Disabling backgrounds leaves the existing image in place.

## Game profiles and progression

**Universal** uses your campaign's rules, sheets, item descriptions and advancement
format without assuming D&D classes or calculating D&D XP, levels or proficiency.

**D&D 5e** uses the recorded 2014/2024 edition and campaign exceptions, defaulting to
2014 when unspecified. `[MISC #character_progression]` records baseline XP, awards,
applied class levels and pending choices. Code calculates totals and checks ledger
integrity and level eligibility. Level application must update the sheet too;
every class feature and XP award justification is not automatically validated.
See the [D&D schema source](prompts/systems/dnd5e-core.md).

The game profile is **global**: select the appropriate one when changing campaigns.
Switching profiles does not convert or erase snapshots. Character cards, personas,
greetings and lorebooks remain important sources of identity and rules; contradictory
starting facts can produce a coherent board for the wrong character or scenario.

## Commands

| Command | Effect |
| --- | --- |
| `/bb` or `/blackboard` | Open inspector. |
| `/bb show` | Explicitly display the full board in a chat system message; may reveal hidden facts. |
| `/bb set <text>` | Immediately replace saved state after validation. |
| `/bb append <text>` | Immediately append text after validation. |
| `/bb clear` or `/bb-clear` | Immediately clear the saved board. |

State-changing commands apply immediately, unlike inspector drafts. The model's
`UpdateBlackboard` supports `upsert`, `delete` and `replace_all`, with no model
`clear` action. Invalid batches leave the previous board intact.

## Persistence and limitations

The board lives in `chatMetadata.variables.world_blackboard`; block ages live in
`chatMetadata.blackboard_engine`. Snapshots use `message.extra.blackboard_snapshot`
and `message.extra.blackboard_engine`, including swipe-specific data. Intermediate
private revisions and findings are not added as chat or vector-memory entries.

- **Model limits:** checks cannot prove semantic correctness or make every fictional
  process deterministic. Code validates structured data, references and workflow;
  simulation and preservation of arbitrary prose remain model tasks.
- **Cost/context:** board, instructions and chat must fit the model's context.
  Ultra and Private Turns can be expensive; provider rate limits still apply.
- **Generation modes:** Private Turns support normal replies, Regenerate and swipes
  in single-character chats; group chats are excluded from private execution.
  Enabled simulation blocks Continue because SillyTavern does not execute its
  required tools there. Use a new message or Regenerate instead.
- **Compatibility:** extensions depending on later prompt interceptors, streamed
  replies or Generate's returned answer need separate testing with Private Turns.
- **History:** rollback needs available snapshots and cannot reconstruct missing
  old facts. Ordinary prose regeneration can retain previously applied tool messages.
- **Visibility:** exports contain assembled context and hidden state. Native tool
  metadata and API requests remain inspectable by technical tools or other extensions;
  display filtering is not encryption. Requests use the configured SillyTavern
  backend; backgrounds use the selected image backend.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Setup required | Function calling, supported Chat Completion model and provider system-prompt setting. |
| No board updates | Enable simulation and auto-injection; inspect UpdateBlackboard receipts. A board written only in narration is not a saved tool update. |
| Private Turns unavailable on phone | Trusted HTTPS, site storage, browser capabilities and their message in settings. |
| 429 / temporary API failure | Keep the checkpoint, wait and Resume. Export before discarding. |
| Cannot resume | Original chat/branch/settings and the displayed reason; some review/tool failures need inspection. |
| Missing dice | D&D Dice installed, its function tool enabled and global function calling enabled. |
| No background | Background switch and Image Generation backend; queued does not mean generated. |
| Save blocked during manual editing | Copy your retained draft if needed, then Load latest. |
| Wrong character/scenario | Conflicting card, persona, greeting, lorebook or other instructions. |

For reports, include versions, connection/model, fidelity, game profile, Private
Turns state, reproduction steps and error text. Review private exports for hidden
campaign information before sharing. History is in [CHANGELOG.md](CHANGELOG.md).

## Development

Run `npm test` from this directory with Node.js. The current suite has 273 passing
tests and needs no third-party test packages. It checks software behavior with
mocked host/model services, not model simulation quality.

After editing `prompts/systems/`, run `npm run sync-prompt`, then the tests.
Current quality sources are `low-base.md`, `mid-base.md`, `high-base.md` and Ultra
v6's `compact-base.md`; `compact` is a historical name, not a lower tier. D&D sources
are `dnd5e-core.md` and `compact-dnd5e.md`; Universal uses `universal.md`. Older
prompt files and recognition archives support migration.

For isolated browser checks, provide Playwright, set `ST_TEST_ROOT` to a SillyTavern
installation and run `npm run test:browser`. `PLAYWRIGHT_MODULE_PATH` can point to
an existing package directory. Chrome is the default; `BB_BROWSER_CHANNEL` selects
another channel. `BB_SCREENSHOTS` optionally selects a screenshot directory.
The fixture reads host CSS/jQuery but does not edit real chats or call a model.
`node scripts/test-host.mjs <SillyTavern-root>` checks stock-host integration with
mocked API responses too.

## License

Author: **st1ksi**. Licensed under **AGPL-3.0**. See [LICENSE](LICENSE).
