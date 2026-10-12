import { THREAD_VISUAL_TOKENS } from "./blocks/local-conversation-visual-tokens";
import {
  applyContentSearchDomMarks,
  clearContentSearchMarks,
  CONTENT_SEARCH_MARK_CLASS,
  CONTENT_SEARCH_ACTIVE_MARK_CLASS,
} from "../../content-search/content-search-dom";
import type { LocalConversationSearchTarget } from "./local-conversation-persisted-search";

/** Highlight only projected content units; tool output and widget documents are not search text. */
export function applyLocalConversationSearchHighlights(input: {
  readonly root: HTMLElement;
  readonly query: string;
  readonly target: LocalConversationSearchTarget;
}): HTMLElement | null {
  clearContentSearchMarks(input.root);
  let active: HTMLElement | null = null;
  for (const unit of input.root.querySelectorAll<HTMLElement>("[data-content-search-unit-key]")) {
    applyContentSearchDomMarks({
      root: unit,
      query: input.query,
      idPrefix: `content-search:conversation:${unit.dataset.contentSearchUnitKey}`,
    });
    if (unit.dataset.contentSearchUnitKey !== input.target.unitKey) continue;
    active = unit
      .querySelectorAll<HTMLElement>(`mark.${CONTENT_SEARCH_MARK_CLASS}`)
      .item(input.target.occurrenceIndex);
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
