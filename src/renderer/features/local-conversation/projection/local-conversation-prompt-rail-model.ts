import type {
  CodexPromptRailIndex,
  CodexPromptRailPreview,
  CodexPromptRailRevealTarget,
  CodexPromptRailTurnShell,
} from "../../../../shared/codex-prompt-rail-history";
import type { ThreadUserMessageNavigationItem } from "../thread-stage-types";
export {
  MARKER_NAVIGATION_VIRTUALIZE_AFTER as LOCAL_CONVERSATION_PROMPT_RAIL_VIRTUALIZE_AFTER,
  MARKER_NAVIGATION_ROW_HEIGHT_PX as LOCAL_CONVERSATION_PROMPT_RAIL_ROW_HEIGHT_PX,
  MARKER_NAVIGATION_OVERSCAN_ROWS as LOCAL_CONVERSATION_PROMPT_RAIL_OVERSCAN_ROWS,
  projectMarkerNavigationVirtualWindow as projectLocalConversationPromptRailVirtualWindow,
  type MarkerNavigationVirtualWindow as LocalConversationPromptRailVirtualWindow,
} from "../../../components/shared/marker-navigation-window";

export interface LocalConversationPromptRailShellState {
  readonly kind: "promptShell";
  readonly shell: CodexPromptRailTurnShell;
  readonly hasPreview: boolean;
}

export interface LocalConversationPromptRailItem extends ThreadUserMessageNavigationItem {
  readonly promptRailShell?: LocalConversationPromptRailShellState;
}

const appendUnique = (
  target: LocalConversationPromptRailItem[],
  seenIds: Set<string>,
  item: LocalConversationPromptRailItem,
): void => {
  if (seenIds.has(item.id)) return;
  seenIds.add(item.id);
  target.push(item);
};

const previewItems = (
  shell: CodexPromptRailTurnShell,
  previews: readonly CodexPromptRailPreview[],
): LocalConversationPromptRailItem[] => {
  if (previews.length === 0) return [shellItem(shell)];
  return previews.map((preview, index) => ({
    id: `${shell.turnId}:user:${index}`,
    turnId: shell.turnId,
    turnKey: shell.turnId,
    ordinal: 0,
    label: preview.promptPreview || "(No content)",
    responsePreview: preview.responsePreview,
    outputs: [],
    isHeartbeat: preview.isHeartbeat,
    promptRailShell: { kind: "promptShell", shell, hasPreview: true },
  }));
};

const shellItem = (shell: CodexPromptRailTurnShell): LocalConversationPromptRailItem => ({
  id: `${shell.turnId}:user:0`,
  turnId: shell.turnId,
  turnKey: shell.turnId,
  ordinal: 0,
  label: "Load prompt preview",
  responsePreview: "",
  outputs: [],
  isHeartbeat: false,
  promptRailShell: { kind: "promptShell", shell, hasPreview: false },
});

/**
 * Replaces indexed Turn shells with already-resident message markers or one lazily hydrated
 * preview. Raw Turn items never enter this projection.
 */
export function buildLocalConversationPromptRailItems(input: {
  readonly index: CodexPromptRailIndex | null;
  readonly residentItems: readonly ThreadUserMessageNavigationItem[];
  readonly previewsByTurnId: ReadonlyMap<string, readonly CodexPromptRailPreview[]>;
}): LocalConversationPromptRailItem[] {
  if (!input.index) return [...input.residentItems];

  const residentByTurnId = new Map<string, ThreadUserMessageNavigationItem[]>();
  for (const item of input.residentItems) {
    if (!item.turnId) continue;
    const turnItems = residentByTurnId.get(item.turnId) ?? [];
    turnItems.push(item);
    residentByTurnId.set(item.turnId, turnItems);
  }

  const indexedTurnIds = new Set(input.index.shells.map((shell) => shell.turnId));
  const items: LocalConversationPromptRailItem[] = [];
  const seenIds = new Set<string>();
  for (const resident of input.residentItems) {
    if (resident.turnId && indexedTurnIds.has(resident.turnId)) continue;
    appendUnique(items, seenIds, resident);
  }

  for (const shell of input.index.shells) {
    const resident = residentByTurnId.get(shell.turnId);
    if (resident) {
      for (const item of resident) appendUnique(items, seenIds, item);
      continue;
    }
    const previews = input.previewsByTurnId.get(shell.turnId);
    for (const item of previews ? previewItems(shell, previews) : [shellItem(shell)]) {
      appendUnique(items, seenIds, item);
    }
  }

  return items.map((item, index) => ({ ...item, ordinal: index + 1 }));
}

export function isLocalConversationPromptRailShellItem(
  item: ThreadUserMessageNavigationItem,
): item is LocalConversationPromptRailItem & {
  readonly promptRailShell: LocalConversationPromptRailShellState;
} {
  const shell = (item as Partial<LocalConversationPromptRailItem>).promptRailShell;
  return shell?.kind === "promptShell";
}

/** Missing identities take the Main-owned, request-capped identity-seek path. */
export function resolveCodexPromptRailRevealTarget(
  index: CodexPromptRailIndex,
  turnId: string,
): CodexPromptRailRevealTarget {
  const shell = index.shells.find((candidate) => candidate.turnId === turnId);
  return shell ? { kind: "shell", shell } : { kind: "knownTurn", turnId };
}
