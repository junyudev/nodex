import { createContext, useContext } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import type { NfmPageAskSubmission } from "./nfm-page-ask";

/** How a Discussion starts from a selection: a plain Comment, a fact-check, or a question to Nodex. */
export type NfmDiscussionStartKind = "comment" | "check" | "ask";

/**
 * What the Page's Discussions owner offers the editor. Editors without Discussions, such as
 * previews and embedded documents, provide none and show no Discussion actions.
 */
export interface NfmPageDiscussionsCapability {
  /** Starts a Discussion on the current selection; the owner captures the range and opens a composer. */
  readonly start: (kind: NfmDiscussionStartKind) => void;
}

export const NfmPageDiscussionsCapabilityContext =
  createContext<NfmPageDiscussionsCapability | null>(null);

export function useNfmPageDiscussionsCapability(): NfmPageDiscussionsCapability | null {
  return useContext(NfmPageDiscussionsCapabilityContext);
}

/** The editor whose selection, marks and Blocks a Discussions owner works with. */
export type NfmDiscussionsEditor = BlockNoteEditor<any, any, any>;

/**
 * How a Page editor connects to the Page's Discussions owner. Functions must be stable for the
 * owner's lifetime; `overlay` renders inside the editor so it can float at document positions.
 */
export interface NfmPageDiscussionsBinding {
  readonly attachEditor: (editor: NfmDiscussionsEditor | null) => void;
  readonly start: (kind: NfmDiscussionStartKind) => void;
  /** Absent when the person cannot run Asks here. */
  readonly submitAsk: ((submission: NfmPageAskSubmission) => void) | null;
}
