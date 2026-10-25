import { scoreSettingsQueryMatch } from "./settings-search-score";

export interface SettingsSearchContext {
  projectNames: readonly string[];
  activeProjectName: string | null;
}

export interface SettingsSearchSection<TSectionId extends string = string> {
  id: TSectionId;
  label: string;
  disabled?: boolean;
  externalUrl?: string;
  searchMessages: readonly string[];
  searchTerms?: (context: SettingsSearchContext) => readonly string[];
}

export interface SettingsSearchTarget<TSectionId extends string = string> {
  sectionId: TSectionId;
  panelLabel: string;
  messageTexts: readonly string[];
  termTexts: readonly string[];
}

export interface SettingsSearchResult<TSectionId extends string = string> {
  sectionId: TSectionId;
  panelLabel: string;
  label: string;
}

interface ScoredSettingsSearchResult<
  TSectionId extends string = string,
> extends SettingsSearchResult<TSectionId> {
  /** 0: the panel itself; 1: one setting holds the whole query; 2: its words are spread out. */
  matchPriority: 0 | 1 | 2;
  score: number;
}

export function buildSettingsSearchTargets<TSectionId extends string>(
  sections: readonly SettingsSearchSection<TSectionId>[],
  context: SettingsSearchContext,
): SettingsSearchTarget<TSectionId>[] {
  return sections.flatMap((section) => {
    if (section.disabled || section.externalUrl != null) return [];

    return [
      {
        sectionId: section.id,
        panelLabel: section.label,
        messageTexts: section.searchMessages,
        termTexts: section.searchTerms?.(context) ?? [],
      },
    ];
  });
}

export function buildSettingsSearchResults<TSectionId extends string>({
  query,
  targets,
  visibleSectionIds,
}: {
  query: string;
  targets: readonly SettingsSearchTarget<TSectionId>[];
  visibleSectionIds: readonly TSectionId[];
}): SettingsSearchResult<TSectionId>[] {
  if (query.trim().length === 0) return [];

  const queryTerms = query.trim().split(/\s+/).filter(Boolean);
  const visibleOrder = new Map<TSectionId, number>();

  for (const [index, sectionId] of visibleSectionIds.entries()) {
    if (!visibleOrder.has(sectionId)) {
      visibleOrder.set(sectionId, index);
    }
  }

  return targets
    .flatMap((target) => {
      if (!visibleOrder.has(target.sectionId)) return [];

      const scored = scoreSettingsSearchTarget(target, query, queryTerms);
      return scored === null ? [] : [scored];
    })
    .sort((left, right) => {
      if (left.matchPriority !== right.matchPriority) {
        return left.matchPriority - right.matchPriority;
      }

      if (left.score !== right.score) {
        return right.score - left.score;
      }

      return (visibleOrder.get(left.sectionId) ?? 0) - (visibleOrder.get(right.sectionId) ?? 0);
    })
    .map(({ label, panelLabel, sectionId }) => ({
      label,
      panelLabel,
      sectionId,
    }));
}

export function settingsQueryRendersResultsMode(query: string): boolean {
  return query.trim().length > 0;
}

function scoreSettingsSearchTarget<TSectionId extends string>(
  target: SettingsSearchTarget<TSectionId>,
  query: string,
  queryTerms: readonly string[],
): ScoredSettingsSearchResult<TSectionId> | null {
  const panelLabelScore = scoreSettingsQueryMatch(target.panelLabel, query);

  if (panelLabelScore > 0) {
    return {
      label: target.panelLabel,
      matchPriority: 0,
      panelLabel: target.panelLabel,
      score: panelLabelScore,
      sectionId: target.sectionId,
    };
  }

  const multiTermScore = scoreAllQueryTerms(
    [target.panelLabel, ...target.messageTexts, ...target.termTexts],
    queryTerms,
  );

  if (multiTermScore === 0) return null;

  const phraseScore = Math.max(
    0,
    ...[...target.messageTexts, ...target.termTexts].map((text) =>
      scoreSettingsQueryMatch(text, query),
    ),
  );
  let bestMessage: { score: number; text: string } | null = null;

  for (const text of target.messageTexts) {
    const score = scoreMessageLabelCandidate(text, query, queryTerms);

    if (score > 0 && (bestMessage === null || score > bestMessage.score)) {
      bestMessage = { score, text };
    }
  }

  return {
    label:
      bestMessage === null || /[<{]/u.test(bestMessage.text) ? target.panelLabel : bestMessage.text,
    matchPriority: phraseScore > 0 ? 1 : 2,
    panelLabel: target.panelLabel,
    score: phraseScore > 0 ? phraseScore : multiTermScore,
    sectionId: target.sectionId,
  };
}

function scoreMessageLabelCandidate(
  text: string,
  query: string,
  queryTerms: readonly string[],
): number {
  const fullQueryScore = scoreSettingsQueryMatch(text, query);
  if (fullQueryScore > 0) return fullQueryScore;

  const termScores = queryTerms.map((term) => scoreSettingsQueryMatch(text, term));
  if (termScores.length === 0 || termScores.some((score) => score === 0)) return 0;

  return termScores.reduce((sum, score) => sum + score, 0);
}

function scoreAllQueryTerms(texts: readonly string[], queryTerms: readonly string[]): number {
  const scores = queryTerms.map((term) =>
    Math.max(0, ...texts.map((text) => scoreSettingsQueryMatch(text, term))),
  );

  if (scores.length === 0 || scores.some((score) => score === 0)) return 0;

  return scores.reduce((sum, score) => sum + score, 0);
}
