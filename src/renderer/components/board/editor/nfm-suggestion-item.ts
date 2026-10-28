import type { DefaultReactSuggestionItem } from "@blocknote/react";
import type { ReactNode } from "react";

import type { CommandPaletteHighlightSegment } from "@/lib/command-palette-highlight";
import type {
  MentionSuggestionFamily,
  MentionSuggestionRank,
} from "@/lib/editor-model/mention-suggestion-model";

/** Semantic suggestion row shared by the NFM menu and its authoritative subflows. */
export type NfmSuggestionItem = DefaultReactSuggestionItem & {
  key?: string;
  hint?: string | null;
  tooltipContent?: ReactNode | null;
  disabled?: boolean;
  detail?: string | null;
  titleSegments?: readonly CommandPaletteHighlightSegment[] | null;
  detailSegments?: readonly CommandPaletteHighlightSegment[] | null;
  mentionRank?: MentionSuggestionRank;
  mentionUtility?: {
    readonly kind: "expand_section";
    readonly family: MentionSuggestionFamily;
  };
  mentionCreate?: {
    readonly kind: "current_page" | "choose_destination";
  };
};
