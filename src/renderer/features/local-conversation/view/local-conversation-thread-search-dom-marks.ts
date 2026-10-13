import { THREAD_VISUAL_TOKENS } from "./blocks/local-conversation-visual-tokens";
import {
  applyContentSearchDomMarks,
  clearContentSearchMarks,
  CONTENT_SEARCH_ACTIVE_MARK_CLASS,
} from "../../content-search/content-search-dom";
import type { LocalConversationSearchTarget } from "./local-conversation-persisted-search";

export interface LocalConversationSearchHighlight {
  readonly id: string;
  readonly target: LocalConversationSearchTarget;
}

/** Highlight only projected content units; tool output and widget documents are not search text. */
export function applyLocalConversationSearchHighlights(input: {
  readonly root: HTMLElement;
  readonly query: string;
  readonly target: LocalConversationSearchTarget | null;
  readonly retainedMatches?: readonly LocalConversationSearchHighlight[];
  readonly activeMatchId?: string;
}): HTMLElement | null {
  clearContentSearchMarks(input.root);
  let active: HTMLElement | null = null;
  const retainedByUnit = new Map<string, LocalConversationSearchHighlight[]>();
  for (const match of input.retainedMatches ?? []) {
    const matches = retainedByUnit.get(match.target.unitKey) ?? [];
    matches.push(match);
    retainedByUnit.set(match.target.unitKey, matches);
  }
  for (const unit of input.root.querySelectorAll<HTMLElement>("[data-content-search-unit-key]")) {
    const retained = retainedByUnit.get(unit.dataset.contentSearchUnitKey ?? "");
    if (input.retainedMatches && !retained) continue;
    const applied = applyContentSearchDomMarks({
      root: unit,
      query: input.query,
      idPrefix: `content-search:conversation:${unit.dataset.contentSearchUnitKey}`,
      ...(retained
        ? {
            limit: retained.length,
            matchIds: retained.map((match) => match.id),
            activeMatchId: input.activeMatchId,
          }
        : {
            activeMatchId:
              input.target !== null && input.target.unitKey === unit.dataset.contentSearchUnitKey
                ? `content-search:conversation:${unit.dataset.contentSearchUnitKey}:${input.target.occurrenceIndex}`
                : undefined,
          }),
    });
    if (retained) {
      active ??= applied.matches.find((match) => match.id === input.activeMatchId)?.element ?? null;
      continue;
    }
    if (!input.target || unit.dataset.contentSearchUnitKey !== input.target.unitKey) continue;
    active = applied.matches[input.target.occurrenceIndex]?.element ?? null;
  }
  active?.classList.add(CONTENT_SEARCH_ACTIVE_MARK_CLASS);
  return active;
}

const TURN_SEARCH_MATCHED_ROW_CLASS_NAME = "rounded-2xl bg-token-foreground/3";
const SEARCH_UNIT_MATCHED_CLASSES = THREAD_VISUAL_TOKENS.searchUnitMatched.split(" ");
const SEARCH_UNIT_ACTIVE_CLASSES = THREAD_VISUAL_TOKENS.searchUnitActive.split(" ");
const TURN_SEARCH_MATCHED_ROW_CLASSES = TURN_SEARCH_MATCHED_ROW_CLASS_NAME.split(" ");

export function applyThreadSearchDomMarks(input: {
  root: HTMLElement;
  matchedSearchUnitKeys: ReadonlySet<string>;
  matchedTurnKeys: ReadonlySet<string>;
  activeSearchUnitKey: string | null;
}): void {
  const { activeSearchUnitKey, matchedSearchUnitKeys, matchedTurnKeys, root } = input;

  for (const element of root.querySelectorAll<HTMLElement>("[data-content-search-unit-key]")) {
    const searchUnitKey = element.dataset.contentSearchUnitKey ?? "";
    const isMatched = matchedSearchUnitKeys.has(searchUnitKey);
    const isActive = activeSearchUnitKey !== null && activeSearchUnitKey === searchUnitKey;

    for (const className of SEARCH_UNIT_MATCHED_CLASSES) {
      element.classList.toggle(className, isMatched);
    }
    for (const className of SEARCH_UNIT_ACTIVE_CLASSES) {
      element.classList.toggle(className, isActive);
    }
  }

  for (const element of root.querySelectorAll<HTMLElement>("[data-content-search-turn-key]")) {
    const turnKey = element.dataset.contentSearchTurnKey ?? "";
    const isMatched = matchedTurnKeys.has(turnKey);
    for (const className of TURN_SEARCH_MATCHED_ROW_CLASSES) {
      element.classList.toggle(className, isMatched);
    }
  }
}
