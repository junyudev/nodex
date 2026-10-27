import type { ModelSelection, ClaudeSettings } from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  getClaudeCatalogModelCapabilities,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogEffort,
  type ClaudeModelCatalog,
} from "./provider/ClaudeModelCatalog.ts";

/** What a running Claude Code process can change between turns. */
export interface ClaudeLiveSelection {
  readonly model: string;
  /** `null` returns the session to the model's default effort. */
  readonly effortLevel: string | null;
  /** `null` leaves Fast to the user's own Claude Code settings. */
  readonly fastMode: boolean | null;
  readonly ultracode: boolean;
}

export interface CompiledClaudeModelSelection {
  readonly apiModelId: string;
  readonly effort: string | undefined;
  readonly settings: Readonly<Record<string, boolean>>;
  readonly live: ClaudeLiveSelection;
  /**
   * Choices fixed when Claude Code starts. Thinking also decides the thinking display the
   * process is launched with, so changing it needs a new process; everything else is live.
   */
  readonly launchIdentity: string;
}

/** Compile every Claude model option at the provider boundary. */
export function compileClaudeModelSelection(
  selection: ModelSelection,
  catalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
  modelTraits: ClaudeSettings["modelTraits"] = {},
): CompiledClaudeModelSelection {
  const capabilities = getClaudeCatalogModelCapabilities(catalog, selection.model);
  const descriptors = getProviderOptionDescriptors({ caps: capabilities });
  const supportsBoolean = (id: string) =>
    descriptors.some((descriptor) => descriptor.type === "boolean" && descriptor.id === id);
  const rawEffort = getModelSelectionStringOptionValue(selection, "effort");
  const resolvedEffort = resolveClaudeCatalogEffort(catalog, selection.model, rawEffort);
  let effort = normalizeClaudeCatalogEffort(catalog, resolvedEffort, selection.model);
  const fastMode = supportsBoolean("fastMode")
    ? (getModelSelectionBooleanOptionValue(selection, "fastMode") ?? false)
    : undefined;
  // Ultracode is Claude Code's session-scoped workflow orchestration; it runs at any effort level.
  const ultracode =
    supportsBoolean("ultracode") && getModelSelectionBooleanOptionValue(selection, "ultracode");
  let apiModelId = resolveClaudeCatalogApiModelId(catalog, selection);
  const nativeTraits = knownThinkingTraits(apiModelId);
  const configuredTraits = modelTraits?.[selection.model];
  const traits = {
    ...nativeTraits,
    ...configuredTraits,
    ...(nativeTraits.disableThinking === false ? { disableThinking: false } : {}),
    ...(nativeTraits.disabledThinkingEfforts === undefined
      ? {}
      : {
          disabledThinkingEfforts:
            configuredTraits?.disabledThinkingEfforts === undefined
              ? nativeTraits.disabledThinkingEfforts
              : nativeTraits.disabledThinkingEfforts.filter((level) =>
                  configuredTraits.disabledThinkingEfforts?.includes(level),
                ),
        }),
  };
  const thinkingSelection = getModelSelectionBooleanOptionValue(selection, "thinking");
  const thinking =
    traits.disableThinking === false || traits.disabledThinkingEfforts?.length === 0
      ? true
      : supportsBoolean("thinking") || traits.disableThinking === true
        ? thinkingSelection
        : undefined;
  if (
    thinking === false &&
    traits.disabledThinkingEfforts !== undefined &&
    (effort === undefined || !traits.disabledThinkingEfforts.includes(effort))
  ) {
    effort = ["low", "medium", "high", "xhigh", "max"]
      .filter((level) => traits.disabledThinkingEfforts?.includes(level))
      .at(-1);
  }
  const context = getModelSelectionStringOptionValue(selection, "contextWindow");
  if (
    selection.model !== "default" &&
    context !== undefined &&
    traits.contextWindows?.includes(context)
  ) {
    apiModelId = `${apiModelId.replace(/\[\d+[km]\]$/i, "")}[${context}]`;
  }
  const settings = {
    ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
    ...(typeof fastMode === "boolean" ? { fastMode } : {}),
    ...(ultracode ? { ultracode: true } : {}),
  };
  return {
    apiModelId,
    effort,
    settings,
    live: {
      model: apiModelId,
      effortLevel: effort ?? null,
      fastMode: typeof fastMode === "boolean" ? fastMode : null,
      ultracode: ultracode === true,
    },
    launchIdentity: JSON.stringify({ thinking: settings.alwaysThinkingEnabled ?? null }),
  };
}

function knownThinkingTraits(model: string): NonNullable<ClaudeSettings["modelTraits"]>[string] {
  const base = model.replace(/\[\d+[km]\]$/i, "");
  if (base === "claude-sonnet-5-5" || base === "claude-opus-5-5") return { disableThinking: false };
  if (base === "claude-opus-5")
    return { disableThinking: true, disabledThinkingEfforts: ["low", "medium", "high"] };
  if (
    [
      "claude-opus-4-0",
      "claude-opus-4-1",
      "claude-opus-4-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-sonnet-4-0",
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ].includes(base)
  ) {
    return { disableThinking: true };
  }
  return {};
}
