# Instruction sources and responsibilities

The composition is **quality → game profile → optional campaign layers → execution**.
Automatic scene backgrounds have a separate prompt and enabled gate. Campaign
selection never replaces a substring of the quality source during generation.

## Quality

Editable current sources are in `systems/`: `low-base.md`, `mid-base.md`,
`high-base.md`, and `compact-base.md` for current Ultra. `ultra-base.md` supports
the earlier large Ultra. Quality defines what the Blackboard is, preparation
distance, N−1, fixed causal facts, closed contents, chronology, knowledge boundaries,
player agency, continuity, required useful output and the board-size corridor.
Both supported Ultra sources follow the configured current corridor, while their
documented full/skeleton preparation resolutions remain distinct. Social follows
that actual resolution rather than promoting the previous source's distance 2.

Generic NPC motives, values, knowledge, beliefs, obligations and meaningful social
records remain part of quality under General as well as Relationships & Social.
The camera metaphor and perceivable details explain faithful disclosure of reality;
they are not optional prose decoration. Examples of crime, magic or trade illustrate
causality/capabilities; they impose neither that genre nor those character abilities.

The unversioned `PROMPT_1_...` through `PROMPT_4_...` exports now contain only the
current quality source. Versioned v2/v3/v5 Markdown, `systems/legacy.json` and
`systems/prior-bases.json` are historical recognition material, not current combined
instructions. Known old sources are upgraded as complete presets; arbitrary edited
custom text is never stripped. The UI shows the active source and flags recognized
historical upgrades.
`systems/separated-prior-indices.json` identifies already separated historical
sources for migration; recognizing one must not restore former baked-in tone.

## Game profiles

Universal uses campaign-owned mechanics. D&D profiles supply actual 2014/2024
checks, effects, resources, action timing and advancement. Applicable social
conventions reside in all D&D profile variants, independently of the Social focus:
relevant loyalties and inducements, retained scales/meaning, debts and refusal
boundaries. These are not mandatory new vulnerabilities for every person. Existing
mind-affecting effects retain their actual scope; generic psychology grants no
unstated immunity. Success creates no unknown information or retroactive lever.

`game-common.md` is included once with every selected profile, including D&D and
Universal. It owns real dice receipts, legal replacement rolls, player resource
choices, source conflicts and the distinction between world time and session/play
cadence. Non-D&D profiles also receive `game-advancement.md` for campaign-owned
progression; D&D retains its own validated advancement procedure instead.
`coc7e.md`, `pf2e.md`, `gurps4e.md`, `cyberpunk_red.md`, `vtm5e.md` or `swade.md`
supplies one of the other systems independently of quality.
Rebuild these with `npm run sync-game-profiles` (also called by sync-systems).
The registry in `game-system-registry.js` defines stable IDs and whether progression
uses a built-in calculator. Only D&D uses its programmatic XP/class schema; all
other systems use their own model-maintained `MISC #character_progression` record.
The complete actual profile text is frozen in private snapshots. Adding unrelated
profiles does not change an existing D&D/Universal snapshot's instructions; updating
the shared contract does. Resume never silently reinterprets an earlier source.

## Optional layers

The `campaign/` sources define additional social depth, world style, tone and
public narration. They preserve quality horizons/budgets, system authority and
canon. The focus selects one depth adapter. Style influences undefined future
circumstances, tone their atmosphere, and narration the public presentation.
None assigns the player voluntary actions or feelings, requires romance or combat,
rewrites closed contents, or turns a genre preference into evidence for a fact.
Confirmed involuntary rules effects are applied only within their verified trigger,
resistance/result, scope and duration; they do not authorize extra feelings or choices.

The former built-in Grimdark and vivid prose are preserved once as explicit
preferences by `quality-source.js`. `systems/quality-defaults.json` is historical
migration metadata, not a hidden genre default or runtime text-edit recipe.

## Execution, previews and saved work

Standard, Light and Heavy own the current task, tools and output format. Existing
review stages receive relevant frozen criteria; no social/genre stages are added.
Reach/Light checks include the selected style/tone's applicable positive preparation
duties. Narration/Light checks include the selected prose task; prose-only repairs
cannot add facts, change outcomes or rewrite the board. No event or mood quota is
introduced, and already defined scenes may remain unchanged.
Repair corrects the same resolved interval. The UI's Composed instructions preview
shows quality + game + campaign + execution using saved preferences; board expansion,
live monitor and separate backgrounds are outside that preview.

Private snapshot v2 freezes exact quality, game-profile and layer texts. A previous
source version cannot be silently reinterpreted on resume. Older paused work stays
saved/exportable and needs its original extension and effective settings to continue.

## Rebuilding

- `npm run sync-prompt`: rebuild system bundles, current Markdown exports and Ultra.
- `npm run sync-campaign`: rebuild the optional campaign prompt bundle.
- `npm run sync-game-profiles`: rebuild the six additional game supplements.
- `npm test`: source contracts, composition, migration, state and private execution.
- `npm run test:browser`: local host fixtures; set the documented test host/runtime
  environment variables as needed. No paid model calls are made by these tests.

Static and fixture checks do not prove that a particular model follows the prompts.
