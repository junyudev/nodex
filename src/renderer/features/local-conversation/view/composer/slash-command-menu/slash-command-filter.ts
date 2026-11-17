import type { IntlShape } from "@/lib/i18n";
import { createFuzzyQueryScorer } from "@/lib/settings-search-score";
import type {
  ComposerSlashCommand,
  ComposerSlashCommandGroup,
  ComposerSlashCommandHighlightIntent,
  ComposerSlashCommandTrigger,
  ComposerSlashCommandMatch,
} from "./slash-command-types";

const LONE_SLASH_COMMAND_DRAFT = /^\s*\/[^/\r\n]*\s*$/u;

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
 * Commands offered for a slash query. Without a query, unheaded commands lead in title order and
 * each section follows in heading order. A query keeps that section order and ranks each section
 * by the best fuzzy match of its titles, ID, and search aliases.
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
  const ordered: ComposerSlashCommandMatch[] = [];
  for (const command of input.commands) {
    if (command.isVisible === false || seenIds.has(command.id)) continue;
    seenIds.add(command.id);
    ordered.push({ command, title: input.resolveTitle?.(command) ?? command.title, score: 0 });
  }
  ordered.sort(
    (left, right) =>
      compareCodeUnits(left.command.group ?? "", right.command.group ?? "") ||
      compareCodeUnits(left.title, right.title),
  );
  const eligible = ordered.filter(
    (match) =>
      !(hasDraftText && match.command.requiresEmptyComposer === true) &&
      supportsSlashCommandTrigger(match.command, trigger),
  );
  if (input.query.trim().length === 0) return eligible;

  const sectionOrder = new Map<string | null, number>();
  for (const match of eligible) {
    const group = match.command.group ?? null;
    if (!sectionOrder.has(group)) sectionOrder.set(group, sectionOrder.size);
  }
  const score = createFuzzyQueryScorer(input.query);
  const sectionIndex = (match: ComposerSlashCommandMatch) =>
    sectionOrder.get(match.command.group ?? null) ?? Number.MAX_SAFE_INTEGER;
  return eligible
    .map((match) => ({
      ...match,
      score: Math.max(
        ...[
          match.title,
          match.command.title,
          match.command.id,
          ...(match.command.searchAliases ?? []),
        ].map(score),
      ),
    }))
    .filter((match) => match.score > 0)
    .sort(
      (left, right) =>
        sectionIndex(left) - sectionIndex(right) ||
        right.score - left.score ||
        compareCodeUnits(left.title, right.title),
    );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function supportsSlashCommandTrigger(
  command: ComposerSlashCommand,
  trigger: ComposerSlashCommandTrigger,
): boolean {
  return (command.triggers ?? ["/"]).includes(trigger);
}

/** Consecutive matches that share a heading form one section. */
export function groupComposerSlashCommandMatches(
  matches: readonly ComposerSlashCommandMatch[],
): ComposerSlashCommandGroup[] {
  const groups: ComposerSlashCommandGroup[] = [];
  for (const match of matches) {
    const label = match.command.group ?? null;
    const currentGroup = groups.at(-1);
    if (currentGroup && currentGroup.label === label) {
      currentGroup.matches.push(match);
      continue;
    }
    groups.push({ id: label === null ? "commands" : `group:${label}`, label, matches: [match] });
  }
  return groups;
}

export function resolveNextSlashHighlight(input: {
  matches: readonly ComposerSlashCommandMatch[];
  currentCommandId: string | null;
  direction: "first" | "next" | "previous";
}): string | null {
  if (input.matches.length === 0) return null;
  if (input.direction === "first" || !input.currentCommandId) {
    return input.matches[0]?.command.id ?? null;
  }

  const currentIndex = input.matches.findIndex(
    (match) => match.command.id === input.currentCommandId,
  );
  if (currentIndex < 0) return input.matches[0]?.command.id ?? null;

  if (input.direction === "next") {
    return input.matches[(currentIndex + 1) % input.matches.length]?.command.id ?? null;
  }

  return (
    input.matches[(currentIndex - 1 + input.matches.length) % input.matches.length]?.command.id ??
    null
  );
}

export function resolvePreservedSlashHighlight(input: {
  matches: readonly ComposerSlashCommandMatch[];
  currentCommandId: string | null;
}): string | null {
  if (input.matches.length === 0) return null;
  if (!input.currentCommandId) return input.matches[0]?.command.id ?? null;

  const currentStillVisible = input.matches.some(
    (match) => match.command.id === input.currentCommandId,
  );
  if (currentStillVisible) return input.currentCommandId;

  return input.matches[0]?.command.id ?? null;
}

export function resolveComposerSlashHighlight(input: {
  matches: readonly ComposerSlashCommandMatch[];
  intent: ComposerSlashCommandHighlightIntent;
}): ComposerSlashCommandHighlightIntent {
  const commandId = resolvePreservedSlashHighlight({
    matches: input.matches,
    currentCommandId: input.intent.commandId,
  });
  return {
    commandId,
    source: commandId === input.intent.commandId ? input.intent.source : "programmatic",
  };
}
