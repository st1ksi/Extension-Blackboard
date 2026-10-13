/**
 * System prompt instructions for autonomous scene background generation and setting.
 */
export const DEFAULT_BACKGROUND_SYSTEM_PROMPT = `### DYNAMIC SCENE VISUALIZATION (\`SetSceneBackground\`)
You have access to the \`SetSceneBackground\` tool to generate and apply an atmospheric visual background to the chat interface.

- **Strict Tool Order:** When invoked, call \`SetSceneBackground\` after any required dice rolls and, when Simulation Blackboard is enabled, after the final confirmed post-action \`UpdateBlackboard\` call.
- **Perspective & Anti-Leak Filtering:**
  - The visual description MUST reflect ONLY what {{user}} currently sees from their physical vantage point, posture, and ambient lighting.
  - DO NOT depict elements concealed from {{user}}'s line of sight (e.g. secret passages, items behind paintings, hidden compartments, concealed traps, or undetected creatures in shadows).
- **When to Invoke:** Call \`SetSceneBackground\` whenever:
  1. A new location, room, or distinct area is entered (whenever \`[SCENE]\` changes or player crosses a threshold).
  2. {{user}} dramatically shifts their vantage point or tactical vantage within the space (e.g. climbs from floor into high rafters, steps out onto an exterior ledge, ascends to a belfry).
  3. The physical environment undergoes a dramatic visual transformation (e.g. fire spreads, lighting is extinguished, wall collapses, violent storm breaks through).
- **When NOT to Invoke:**
  - Do NOT call it on dialogue turns, social interactions, skill checks, static combat rounds, tactical deliberation, or OOC turns where the visual viewpoint remains unchanged.
- **Prompt Guidelines:**
  - The \`prompt\` argument MUST be formulated strictly in ENGLISH.
  - Image output cannot establish new world facts. Environment / landscape establishing view only: architectural materials, atmospheric lighting, weather, depth, and spatial geometry.
  - DO NOT include character portraits, specific named NPCs, facial close-ups, combat poses, dialogue, or UI graphics. This ensures the background remains valid regardless of NPC movements.`;

export const PRIVATE_BACKGROUND_PROTOCOL = `BACKGROUND EXECUTION — PRIVATE
SetSceneBackground stages a request during simulation only. Its queued receipt does not mean an image was generated or installed. The extension executes an accepted request after publication; a discarded request is not executed. Detection, repair and verification cannot request images. Do not claim generation succeeded before the tool confirms it.`;

export const STANDARD_BACKGROUND_PROTOCOL = `BACKGROUND EXECUTION — STANDARD
SetSceneBackground generates and applies the background when called. Wait for its result; do not claim success after an error or unavailable generator. An image illustrates established facts and never changes the world's state.`;

export function backgroundInstructions(settings) {
    if (!settings.autoSceneBackground) return '';
    const custom = typeof settings.customBackgroundPrompt === 'string' && settings.customBackgroundPrompt.trim()
        ? settings.customBackgroundPrompt : DEFAULT_BACKGROUND_SYSTEM_PROMPT;
    return custom + (settings.functionTool === false ? '\n\nSimulation Blackboard is disabled. Use the established chat scene as your source; do not call or wait for UpdateBlackboard. Generate backgrounds directly in the ordinary turn.' : '') + '\n\n' + (settings.functionTool !== false && settings.privateReview ? PRIVATE_BACKGROUND_PROTOCOL : STANDARD_BACKGROUND_PROTOCOL);
}
