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

Supports **Universal** campaigns and profiles for **D&D 5e**, **Call of Cthulhu 7e**,
**Pathfinder 2e Remaster**, **GURPS 4e**, **Cyberpunk RED**, **Vampire: The Masquerade V5**
and **Savage Worlds Adventure Edition**, with four fidelity levels,
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
- **Chat-specific settings:** inherit global defaults or keep an independent
  configuration for each chat, including game rules, review mode and backgrounds.
- **Campaign direction:** optional social depth, campaign style, tone and narration
  settings, independent of game system, fidelity and review mode.
- **Optional private reviews:** Heavy mode uses focused detection, targeted repair
  and verification; Light mode combines detection into one pass, then corrects findings.
- **Recovery:** checkpointed private work, confirmed dice and pending requests can
  survive provider errors and page reloads.
- **History rollback:** saved board snapshots and block ages follow deletion,
  swipes and branches when rollback is enabled.
- **Custom UI:** colored navigation pills and cards, inline block editing, full
  source editing, statistics and a settings Control Panel.
- **D&D advancement:** calculated XP, level eligibility and proficiency from a
  validated ledger; other profiles keep their own model-maintained advancement records.
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

For updates, finish the current generation and export any paused private work before
replacing extension files, then reload. See the compatibility note below. Do not copy
SillyTavern core files or user settings from another installation.
Older experimental installations with Blackboard core hooks need those obsolete
hooks removed; a clean SillyTavern needs only this extension.

## Updating to 1.15.0

This release changes assembled simulation instructions. Finish any paused Private
Turn before updating, or export its draft and retain the previous extension and
settings for continuation. Checkpoints are not silently rewritten to new rules.
Published messages, their board snapshots and campaign facts are not converted.

Recognized historical built-ins migrate to separated prompts and visible direction
settings. Arbitrary edited custom prompts remain verbatim; review them for conflicting
system, tone or style instructions. After updating, reload SillyTavern and inspect
**Control Panel → Instructions → Composed instructions** to see the saved selection.

## Quick start

1. Configure function calling and provider system prompts as described above.
2. Open **Extensions → Simulation Blackboard → Open control panel**.
3. Select **Universal** for campaign-owned rules or the profile matching your actual
   game and edition. Supply the relevant character sheet, sources and exceptions.
4. Choose fidelity. **Mid** is the fresh-install default. Leave **Private Turns**
   off for ordinary generation or enable them and select **Heavy** or **Light** review.
5. Disable **Automatic scene backgrounds** if you do not want images, or configure
   Image Generation before leaving it on.
6. Supply your character/persona and scenario, then send an action. The model
   initializes an empty board; open **Objective Blackboard** in the wand menu to inspect it.

Fresh defaults: simulation, auto-injection, rollback and backgrounds enabled;
Mid fidelity; D&D profile; Private Turns disabled; Heavy review mode; diff history. Existing
installations retain compatible saved choices through migration.

## Campaign direction

**Simulation focus** selects General or **Relationships & Social**. The social
focus adds relevant values, current feelings, significant memories and directed
attitudes inside existing character records. It does not assume romance, reciprocal
feelings or a particular tone. The player authors voluntary feelings and decisions;
verified involuntary rules effects retain only their actual scope and duration.
Its depth follows Low/Mid/High/Ultra/Custom; token corridors remain unchanged.

Open **Campaign direction** to choose the other independent settings:

| Setting | Options | Responsibility |
| --- | --- | --- |
| World style | No additional style; Deductive; Adventure; Social intrigue; Exploration; Survival; Slice of life | Emphasis of preparation and new, undefined circumstances. |
| Tone | No additional tone; Balanced; Grimdark; Hopeful | Atmosphere and conditions of new material, within established facts. |
| Narrative style | No additional narration; Concise; Evocative | Presentation of the player-facing answer, without changing world state. |

**No additional ...** adds no instructions for that dimension: the model follows
your other campaign sources. Every current quality source is already independent
of genre and ornamental prose. Selecting a layer only appends its own block;
there is no generation-time search/replacement in quality text. Game profiles apply
their mechanics, including applicable social conventions, with Social either on or off.

An upgrade migrates former built-in direction once into visible preferences:
recognized pre-separation Ultra sources retain Grimdark/Evocative; pre-separation
Low/Mid/High retain Evocative. Already separated neutral sources receive no inferred
direction. Existing explicit choices take precedence. Fresh installs
have General focus and no additional style, tone or narration. Changing fidelity
after migration never changes these choices. Arbitrary custom prompts remain verbatim;
reconcile any conflicting directions manually. Exact known historical presets resolve
to current quality sources while their saved originals remain retained.

The **Instructions** tab shows editable quality and separate read-only game,
campaign and execution instructions. **Composed instructions** shows the full saved
simulation composition before board macro expansion and live diagnostics. Unsaved
editor drafts and separate background instructions are excluded. See
[prompt sources and responsibility boundaries](prompts/README.md).

These controls supply no setting lore, mandatory plot, guaranteed success, heroic
role or compulsory encounters. Switching them does not retcon existing causes,
invent past player choices, reopen closed inventories, erase memories, reset the
board or advance time. A mystery may have an ordinary cause; an adventure may be
avoided. Relationships can improve or worsen for actual reasons.

All choices follow **Global defaults / This chat**. Use This chat when a particular
campaign needs its own direction. Simulation-off/background-only operation receives
no campaign supplements. No new model stages are added: Light and Heavy use their
existing checks with relevant criteria. More context and detail can still increase
cost or latency. Private work freezes exact supplements and criteria; restore its
original settings and prompt version before resuming after a change. The source
split introduces private instruction snapshots v2 containing exact quality and game
profile texts. Pre-separation paused turns are preserved and exportable, but cannot
resume under the new rules, even with General and no additional layers. Finish or
export them before updating; continuation requires their original extension version
and effective settings. Replacing the extension folder alone may not restore those
preferences after migration.

Automated tests check composition, persistence, UI and private-turn routing; they do
not establish a real model's semantic adherence. Game profiles are condensed instructions
for the selected rules, not complete rulebooks or programmatic rules engines.

## Game system profiles

Profiles are instructions for applying mechanics and recording their consequences.
They supply no setting lore, mandatory campaign tone or player biography. Every
profile works at all four fidelity levels with General or Relationships & Social,
and Standard, Light or Heavy execution. Selecting a new profile preserves the board,
history and preferences; it does not convert an existing character. Resolve an
incompatible sheet or recorded ruleset explicitly before applying the new mechanics.

| Profile | Main mechanics recorded |
| --- | --- |
| Universal | Campaign-owned rules and advancement, without an imposed system. |
| D&D 5e | Recorded 2014/2024 rules; validated D&D XP/level/proficiency ledger. |
| Call of Cthulhu 7e | Percentile skill degrees, bonus/penalty dice, Luck, Sanity, injuries and investigator development. |
| Pathfinder 2e Remaster | Four success degrees, three-action turns, traits, conditions, resources and level choices. |
| GURPS 4e | 3d6 roll-under, active defenses, one-second turns, injury/FP and character points. |
| Cyberpunk RED | d10 checks, range DVs, SP/ablation, Critical Injuries, Humanity and IP spending. |
| Vampire: The Masquerade V5 | Regular/Hunger dice, criticals, Rouse Checks, Health, Willpower, Humanity and experience purchases. |
| Savage Worlds Adventure Edition | Trait/Wild dice and Aces, Bennies, action cards, Shaken, Wounds, Fatigue and Advances. |

Only D&D progression has a built-in arithmetic validator. Other systems use
`MISC #character_progression` in their own format; the model maintains balances,
costs, prerequisites and sheet legality. Neither instructions nor local validation
constitute a complete rules engine. Supply source details for abilities, equipment,
tables and optional subsystems the model cannot reliably resolve. Profiles identify
indispensable missing parameters rather than authorize convenient invented rules.
See [profile source references](prompts/GAME_SYSTEM_SOURCES.md).

New CoC campaigns default to standard 7e core scope; new GURPS campaigns default
to Fourth Edition Basic Set. Existing Quick-Start, Starter Set, Lite and other
explicit source choices remain in force. The profiles do not bundle those books.
Rules tied to a game session or time of play use an agreed marker distinct from
fictional time; messages, API delays, reloads and reviews do not reset resources.

Required randomness uses real tool results with individually distinguishable dice
where needed. Legal pushes and resource-funded rerolls follow their system timing
and retain original results/costs; technical retries and repairs cannot reroll.
Private review never fabricates an omitted roll. SWADE initiative needs actual cards
or a declared random draw method with a tracked deck; no dedicated card tool is
included. Host-visible tool receipts may limit secrecy for hidden checks.

CoC uses a disclosed closed-world Luck house convention. Luck/Benny uses that
introduce external story facts need an explicit recorded
campaign agreement about their authority. Ordinary mechanical uses remain available.
The default Blackboard boundary preserves already established facts and closed
contents; a story-detail use is not permission to backfill a convenient object or
rewrite history silently. Wholly off-screen deterministic resolution is an explicit
simulation convention, distinct from the games' official random procedures.

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

**On:** simulation stages a working board and candidate answer. The independent
**Review mode** selector chooses how that draft is checked:

- **Heavy (default):** specialized detection for each aspect, targeted repair when
  necessary, then model verification. Repairs can trigger rechecks of earlier
  aspects. A clean turn requires at least four audit requests in addition to
  simulation; repairs and retries add time, tokens and API usage.
- **Light:** one combined detection pass records issues across all four aspects,
  followed by one correction pass addressing those records. It has no additional
  model verification pass or repeated semantic audits. Local board and workflow
  validation still apply; unresolved findings block publication. This reduces
  review stages, but can miss errors that separate verification would catch.

Light findings identify their affected records. Corrections must cite those
records and change the affected state to resolve a defect; an unrelated edit
cannot close it. A mistaken allegation can instead be rejected with evidence.

Both modes cover:

1. **Time and actors:** elapsed interval, ongoing plans, deadlines and expiring effects.
2. **Facts and resources:** continuity, transfers, quantities, injuries and duplicated claims.
3. **Reachable space:** preparation for actual next contacts and alternative routes.
4. **Final answer:** board/dice agreement, player agency and information disclosure.

The **same configured model** performs these roles. A pass can need tool-call
continuations or request retries, so Light does not promise exactly two HTTP
requests. Private execution does not stream its answer. The review mode is
independent of fidelity and remains selected while Private Turns are disabled.
Existing installations and older saved checkpoints default to Heavy.

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
The checkpoint retains its review mode; changing the selector affects new turns
and does not convert work already saved under a different mode.
Do not resend the player action while keeping that draft; use **Discard draft**
to abandon it intentionally. Resume uses the frozen context and remaining work,
without deliberately repeating confirmed dice or completed tools. Uncertain tool
outcomes, invalid reviews, missing player decisions or exhausted budgets may need
inspection rather than repeated Resume.

Private checkpoints and diagnostic reports live in **this browser's IndexedDB for
this site address**, outside chat messages, prompts and vector memory. They survive
reload while storage is retained but do not automatically transfer between devices,
browsers or HTTP/HTTPS addresses. Clearing site storage deletes them.

**Export last private turn** loads the latest report for the current account,
character and saved chat after reload or chat switching. The archive also retains
the previous completion if a newer attempt fails; it does not store a full campaign
history. Export each turn separately to keep a test series. Reports include audits,
candidate revisions, issue history, dice and the final background result. A storage
failure keeps the recovery checkpoint instead of silently discarding diagnostics.
For older turns whose full report was never saved, export provides a clearly marked
summary using surviving message statistics and the final board, with no invented
audits or intermediate versions.

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

**Settings for** selects the scope of every preference below it:

- **Global defaults:** shared by chats without active local settings. Existing
  chats continue using these defaults until you opt in to chat-specific settings.
- **This chat:** initially copies the current global defaults, then keeps an
  independent configuration in the saved chat's metadata. Later default changes
  do not alter it. Open a saved chat before selecting this option.

Switching back to **Global defaults** retains the chat's local configuration;
select **This chat** again to restore it. **Copy global defaults to this chat**
explicitly replaces the active local configuration after confirmation. These
actions preserve the board, messages and existing snapshots.

The scope includes simulation, auto-injection, rollback, game profile, fidelity,
budgets, social focus, world style, tone, narration, Private Turns/review/history
mode, backgrounds and custom prompts.
Prompt drafts remain separate for each scope in the current browser tab and need
Save; page reload discards unsaved drafts. Branches inherit a copy of preferences
at branch creation, independently of the board snapshot's historical position.
Message deletion/swipes restore the board, not settings. A new chat normally
starts with global defaults unless its metadata was copied by the host.

Paused Private Turns still require their original effective configuration to
resume. A scope change with identical values is compatible; changing active
settings is not. Changes to unused global defaults do not affect a local turn.

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

The game profile follows **Settings for**: global defaults or the current chat.
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
Optional local preferences use `chatMetadata.blackboard_settings`, separately from
world state and snapshot history; they travel with the host's saved/exported chat.

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

For reports, include versions, connection/model, fidelity, game profile, focus,
world style, tone, narration, custom-quality usage, Private Turns state and review
mode, reproduction steps and error text. Review private exports for hidden
campaign information before sharing. History is in [CHANGELOG.md](CHANGELOG.md).

## Development

Run `npm test` from this directory with Node.js. The suite needs no third-party
test packages. It checks software behavior with
mocked host/model services, not model simulation quality.

After editing `prompts/systems/`, run `npm run sync-prompt`, then the tests.
Current quality sources are `low-base.md`, `mid-base.md`, `high-base.md` and Ultra
v6's `compact-base.md`; `compact` is a historical name, not a lower tier. D&D sources
are `dnd5e-core.md` and `compact-dnd5e.md`; Universal uses `universal.md`. Older
prompt files and recognition archives support migration.
After editing `prompts/campaign/`, run `npm run sync-campaign` to rebuild its
separate bundle. See [instruction source responsibilities](prompts/README.md).

For isolated browser checks, provide Playwright, set `ST_TEST_ROOT` to a SillyTavern
installation and run `npm run test:browser`. `PLAYWRIGHT_MODULE_PATH` can point to
an existing package directory. Chrome is the default; `BB_BROWSER_CHANNEL` selects
another channel. `BB_SCREENSHOTS` optionally selects a screenshot directory.
The fixture reads host CSS/jQuery but does not edit real chats or call a model.
`node scripts/test-host.mjs <SillyTavern-root>` checks stock-host integration with
mocked API responses too.

## License

Author: **st1ksi**. Licensed under **AGPL-3.0**. See [LICENSE](LICENSE).
