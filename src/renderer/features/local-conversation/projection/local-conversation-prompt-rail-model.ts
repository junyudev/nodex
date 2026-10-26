import type { CodexPromptRailPreview } from "../../../../shared/codex-prompt-rail-history";
import type { ConversationPromptTurn } from "../conversation-runtime";
import type { ThreadUserMessageNavigationItem } from "../thread-stage-types";

export interface LocalConversationPromptRailShellState {
  readonly kind: "promptShell";
  readonly turnId: string;
  readonly hasPreview: boolean;
}

export interface LocalConversationPromptRailItem extends ThreadUserMessageNavigationItem {
  readonly promptRailShell?: LocalConversationPromptRailShellState;
}

const shellItems = (
  turnId: string,
  previews: readonly CodexPromptRailPreview[] | undefined,
): LocalConversationPromptRailItem[] => {
  if (!previews?.length)
    return [
      {
        id: `${turnId}:user:0`,
        turnId,
        turnKey: turnId,
        ordinal: 0,
        label: "Load prompt preview",
        responsePreview: "",
        outputs: [],
        isHeartbeat: false,
        promptRailShell: { kind: "promptShell", turnId, hasPreview: false },
      },
    ];
  return previews.map((preview, index) => ({
    id: `${turnId}:user:${index}`,
    turnId,
    turnKey: turnId,
    ordinal: 0,
    label: preview.promptPreview || "(No content)",
    responsePreview: preview.responsePreview,
    outputs: [],
    isHeartbeat: preview.isHeartbeat,
    promptRailShell: { kind: "promptShell", turnId, hasPreview: true },
  }));
};

/**
 * Orders every indexed Turn, replacing each with its resident message markers or a preview.
 * A resident marker outside the index keeps its place before the next indexed resident Turn,
 * or follows the index when it is newer than every indexed Turn.
 */
export function buildLocalConversationPromptRailItems(input: {
  readonly turns: readonly ConversationPromptTurn[] | null;
  readonly residentItems: readonly ThreadUserMessageNavigationItem[];
  readonly previewsByTurnId: ReadonlyMap<string, readonly CodexPromptRailPreview[]>;
}): LocalConversationPromptRailItem[] {
  if (!input.turns) return [...input.residentItems];

  const indexedTurnIds = new Set(input.turns.map((turn) => turn.turnId));
  const residentByTurnId = new Map<string, ThreadUserMessageNavigationItem[]>();
  const unindexedBeforeTurnId = new Map<string, ThreadUserMessageNavigationItem[]>();
  let unindexed: ThreadUserMessageNavigationItem[] = [];
  for (const item of input.residentItems) {
    if (!item.turnId || !indexedTurnIds.has(item.turnId)) {
      unindexed.push(item);
      continue;
    }
    if (!residentByTurnId.has(item.turnId)) {
      residentByTurnId.set(item.turnId, []);
      if (unindexed.length > 0) unindexedBeforeTurnId.set(item.turnId, unindexed);
      unindexed = [];
    }
    residentByTurnId.get(item.turnId)!.push(item);
  }

  const items: LocalConversationPromptRailItem[] = [];
  const seenIds = new Set<string>();
  const append = (item: LocalConversationPromptRailItem) => {
    if (seenIds.has(item.id)) return;
    seenIds.add(item.id);
    items.push(item);
  };
  for (const turn of input.turns) {
    for (const item of unindexedBeforeTurnId.get(turn.turnId) ?? []) append(item);
    const resident = residentByTurnId.get(turn.turnId);
    for (const item of resident ??
      shellItems(turn.turnId, input.previewsByTurnId.get(turn.turnId) ?? turn.previews))
      append(item);
  }
  for (const item of unindexed) append(item);

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
