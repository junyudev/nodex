import type { IntlShape } from "@/lib/i18n";
import { createFuzzyQueryScorer } from "@/lib/settings-search-score";
import type {
  ComposerSlashCommand,
  ComposerSlashCommandGroup,
  ComposerSlashCommandMatch,
  ComposerSlashCommandTrigger,
  ComposerSlashHighlightIntent,
  ComposerSlashSectionKind,
  ComposerSlashSubmenu,
  ComposerSlashSubmenuItem,
  ComposerSlashSubmenuSectionView,
} from "./slash-command-types";

const LONE_SLASH_COMMAND_DRAFT = /^\s*\/[^/\r\n]*\s*$/u;

/** The chat's own commands lead; skills come next, then the Agent's own commands. */
const SECTION_RANK: Readonly<Record<ComposerSlashSectionKind | "commands", number>> = {
  commands: 0,
  skills: 1,
  agent: 2,
};

/** Whether the draft holds more than a lone slash command; empty-only commands then hide. */
export function composerHasDraftText(text: string): boolean {
  return text.trim().length !== 0 && !LONE_SLASH_COMMAND_DRAFT.test(text);
}

/** The title as the menu shows it. */
export function resolveComposerSlashCommandTitle(
  command: ComposerSlashCommand,
  intl: Pick<IntlShape, "formatMessage">,
): string {
  return command.titleMessage ? intl.formatMessage(command.titleMessage) : command.title;
}

/**
 * Commands offered for a slash query. Without a query, each section lists its commands in title
 * order. A query keeps the section order and ranks each section by the best fuzzy match of its
 * titles, ID, and search aliases.
 */
export function filterComposerSlashCommands(input: {
  commands: readonly ComposerSlashCommand[];
  query: string;
  composerText: string;
  trigger?: ComposerSlashCommandTrigger;
  resolveTitle?: (command: ComposerSlashCommand) => string;
}): ComposerSlashCommandMatch[] {
  const trigger = input.trigger ?? "/";
  const hasDraftText = composerHasDraftText(input.composerText);
  const seenIds = new Set<string>();
  const eligible: ComposerSlashCommandMatch[] = [];
  for (const command of input.commands) {
    if (command.isVisible === false || seenIds.has(command.id)) continue;
    seenIds.add(command.id);
    if (hasDraftText && command.requiresEmptyComposer === true) continue;
    if (!(command.triggers ?? ["/"]).includes(trigger)) continue;
    eligible.push({ command, title: input.resolveTitle?.(command) ?? command.title, score: 0 });
  }
  eligible.sort(
    (left, right) =>
      sectionRank(left.command) - sectionRank(right.command) ||
      compareCodeUnits(left.title, right.title),
  );
  if (input.query.trim().length === 0) return eligible;

  const score = createFuzzyQueryScorer(input.query);
  return eligible
    .map((match) => ({
      ...match,
      score: bestScore(score, [
        match.title,
        match.command.title,
        match.command.id,
        ...(match.command.searchAliases ?? []),
      ]),
    }))
    .filter((match) => match.score > 0)
    .sort(
      (left, right) =>
        sectionRank(left.command) - sectionRank(right.command) ||
        right.score - left.score ||
        compareCodeUnits(left.title, right.title),
    );
}

/** Consecutive matches in one section form a group; the chat's own commands have no heading. */
export function groupComposerSlashCommandMatches(
  matches: readonly ComposerSlashCommandMatch[],
): ComposerSlashCommandGroup[] {
  const groups: ComposerSlashCommandGroup[] = [];
  for (const match of matches) {
    const id = match.command.section?.kind ?? "commands";
    const currentGroup = groups.at(-1);
    if (currentGroup?.id === id) {
      currentGroup.matches.push(match);
      continue;
    }
    groups.push({ id, label: match.command.section?.label ?? null, matches: [match] });
  }
  return groups;
}

/**
 * A submenu's sections for the query typed after the slash. Without a query, rows keep their
 * order and search-only sections stay empty; a query ranks each section by fuzzy match.
 */
export function filterComposerSlashSubmenu(
  submenu: ComposerSlashSubmenu,
  query: string,
): ComposerSlashSubmenuSectionView[] {
  const searching = query.trim().length > 0;
  const score = searching ? createFuzzyQueryScorer(query) : null;
  return submenu.sections.map((section) => {
    const items =
      !searching && section.showOnlyWhenSearching
        ? []
        : score
          ? section.items
              .map((item, index) => ({
                item,
                index,
                score: bestScore(score, [item.title, item.id, ...(item.searchAliases ?? [])]),
              }))
              .filter((entry) => entry.score > 0)
              .sort((left, right) => right.score - left.score || left.index - right.index)
              .map((entry) => entry.item)
          : section.items;
    return {
      id: section.id,
      title: section.title ?? null,
      items,
      emptyState: items.length === 0 && !searching ? (section.emptyState ?? null) : null,
      loading: section.loading === true,
    };
  });
}

/** Rows that keyboard and pointer can highlight and choose. */
export function selectableComposerSlashSubmenuItems(
  sections: readonly ComposerSlashSubmenuSectionView[],
): ComposerSlashSubmenuItem[] {
  return sections.flatMap((section) =>
    section.items.filter((item) => item.run !== undefined && item.disabled !== true),
  );
}

export function resolveNextSlashHighlight(input: {
  rowIds: readonly string[];
  currentRowId: string | null;
  direction: "next" | "previous";
}): string | null {
  const { rowIds } = input;
  if (rowIds.length === 0) return null;
  const currentIndex = input.currentRowId === null ? -1 : rowIds.indexOf(input.currentRowId);
  if (currentIndex < 0) return rowIds[0] ?? null;
  const offset = input.direction === "next" ? 1 : -1;
  return rowIds[(currentIndex + offset + rowIds.length) % rowIds.length] ?? null;
}

/**
 * Keeps a row the person moved to while it stays listed. Otherwise the highlight follows the
 * list: the preferred row (a submenu's setting in effect) or the first, best-matching row.
 */
export function resolveComposerSlashHighlight(input: {
  rowIds: readonly string[];
  intent: ComposerSlashHighlightIntent;
  preferredRowId?: string | null;
}): ComposerSlashHighlightIntent {
  const { rowIds, intent } = input;
  if (intent.rowId !== null && intent.source !== "programmatic" && rowIds.includes(intent.rowId))
    return intent;
  const preferred =
    input.preferredRowId && rowIds.includes(input.preferredRowId) ? input.preferredRowId : null;
  return { rowId: preferred ?? rowIds[0] ?? null, source: "programmatic" };
}

function sectionRank(command: ComposerSlashCommand): number {
  return SECTION_RANK[command.section?.kind ?? "commands"];
}

function bestScore(score: (candidate: string) => number, candidates: readonly string[]): number {
  let best = 0;
  for (const candidate of candidates) best = Math.max(best, score(candidate));
  return best;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
