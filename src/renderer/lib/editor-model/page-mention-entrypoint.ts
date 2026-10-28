import {
  selectMentionSuggestionSections,
  type MentionSuggestionFamily,
  type MentionSuggestionSection,
  type RankedMentionSuggestion,
} from "./mention-suggestion-model";

export type NfmPageMentionTrigger = "@" | "+" | "[[";
export type NfmPageMentionEntry = "broad" | "create_first" | "wiki_link";
export type NfmPageMentionProvider = MentionSuggestionFamily | "create_page";

export interface NfmPageMentionEntryProfile {
  readonly entry: NfmPageMentionEntry;
  readonly trigger: NfmPageMentionTrigger;
  readonly providers: readonly NfmPageMentionProvider[];
  readonly createPlacement: "after_broad_results" | "before_page_results" | "after_page_results";
  readonly emptyQueryPopup: "show" | "defer";
  readonly temporaryInput: true;
}

export interface NfmPageMentionCreateSection<Value> {
  readonly family: "create_page";
  readonly label: "New page" | null;
  readonly items: readonly Value[];
  readonly hiddenItemCount: 0;
}

export type NfmPageMentionSection<Value> =
  | MentionSuggestionSection<Value>
  | NfmPageMentionCreateSection<Value>;

const PAGE_MENTION_ENTRY_PROFILE_BY_TRIGGER: Readonly<
  Record<NfmPageMentionTrigger, NfmPageMentionEntryProfile>
> = {
  "@": {
    entry: "broad",
    trigger: "@",
    providers: ["page", "chat", "temporal", "create_page"],
    createPlacement: "after_broad_results",
    emptyQueryPopup: "show",
    temporaryInput: true,
  },
  "+": {
    entry: "create_first",
    trigger: "+",
    providers: ["create_page", "page"],
    createPlacement: "before_page_results",
    emptyQueryPopup: "defer",
    temporaryInput: true,
  },
  "[[": {
    entry: "wiki_link",
    trigger: "[[",
    providers: ["page", "create_page"],
    createPlacement: "after_page_results",
    emptyQueryPopup: "show",
    temporaryInput: true,
  },
};

export function getNfmPageMentionEntryProfile(
  trigger: NfmPageMentionTrigger,
): NfmPageMentionEntryProfile {
  return PAGE_MENTION_ENTRY_PROFILE_BY_TRIGGER[trigger];
}

function createSection<Value>(
  profile: NfmPageMentionEntryProfile,
  items: readonly Value[],
): NfmPageMentionCreateSection<Value> | null {
  if (items.length === 0) return null;
  return {
    family: "create_page",
    label: profile.entry === "broad" ? "New page" : null,
    items,
    hiddenItemCount: 0,
  };
}

/**
 * Composes one stable section plan for all Page-mention entries. Provider
 * ranking stays with the existing mention model; creation placement never
 * changes when asynchronous Page candidates arrive.
 */
export function selectNfmPageMentionSections<Value>(input: {
  readonly profile: NfmPageMentionEntryProfile;
  readonly query: string;
  readonly rankedResults: readonly RankedMentionSuggestion<Value>[];
  readonly createItems: readonly Value[];
  readonly expandedFamilies?: ReadonlySet<MentionSuggestionFamily>;
}): NfmPageMentionSection<Value>[] {
  const candidates =
    input.profile.entry === "broad"
      ? input.rankedResults
      : input.rankedResults.filter(({ rank }) => rank.family === "page");
  const resultSections = selectMentionSuggestionSections({
    query: input.query,
    candidates,
    expandedFamilies: input.expandedFamilies,
  });
  const creation = createSection(input.profile, input.createItems);
  if (!creation) return resultSections;
  if (input.profile.createPlacement === "before_page_results") {
    return [creation, ...resultSections];
  }
  return [...resultSections, creation];
}
