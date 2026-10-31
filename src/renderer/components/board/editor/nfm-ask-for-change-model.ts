import type { PageTextRewriteInput } from "../../../../shared/page-text-rewrite";

/** One-tap instructions for the most common rewrites; anything else is typed. */
export const NFM_ASK_FOR_CHANGE_QUICK_INSTRUCTIONS = [
  {
    label: "Improve writing",
    instruction: "Improve the writing: clearer and more natural, with the same meaning.",
  },
  { label: "Make shorter", instruction: "Make this shorter while keeping every point." },
  { label: "Fix spelling & grammar", instruction: "Fix spelling and grammar only." },
] as const;

/** Surrounding text informs the rewrite; a few thousand characters on each side is plenty. */
const SURROUNDING_TEXT_CHARACTERS = 2_000;

export interface NfmAskForChangeSource {
  /** The selection as Nodex Markdown, exactly what Accept replaces. */
  readonly markdown: string;
  readonly before: string;
  readonly after: string;
}

/**
 * The review of one rewrite. Each request rewrites a basis: the selection at first, then the
 * current proposal when the user asks for another change to it.
 */
export type NfmAskForChangeState =
  | { readonly phase: "closed" }
  | { readonly phase: "compose"; readonly source: NfmAskForChangeSource }
  | {
      readonly phase: "working";
      readonly source: NfmAskForChangeSource;
      readonly basis: string;
      readonly instruction: string;
    }
  | {
      readonly phase: "review";
      readonly source: NfmAskForChangeSource;
      readonly basis: string;
      readonly instruction: string;
      readonly proposal: string;
    }
  | {
      readonly phase: "failed";
      readonly source: NfmAskForChangeSource;
      readonly basis: string;
      readonly instruction: string;
      readonly message: string;
    };

export type NfmAskForChangeEvent =
  | { readonly type: "open"; readonly source: NfmAskForChangeSource }
  | { readonly type: "ask"; readonly instruction: string }
  | { readonly type: "retry" }
  | { readonly type: "settled"; readonly proposal: string }
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "close" };

export function reduceNfmAskForChange(
  state: NfmAskForChangeState,
  event: NfmAskForChangeEvent,
): NfmAskForChangeState {
  switch (event.type) {
    case "open":
      return { phase: "compose", source: event.source };
    case "close":
      return { phase: "closed" };
    case "ask": {
      const instruction = event.instruction.trim();
      if (!instruction || state.phase === "closed" || state.phase === "working") return state;
      // A further change refines what is on screen; otherwise the selection is the basis.
      const basis = state.phase === "review" ? state.proposal : state.source.markdown;
      return { phase: "working", source: state.source, basis, instruction };
    }
    case "retry":
      if (state.phase !== "review" && state.phase !== "failed") return state;
      return {
        phase: "working",
        source: state.source,
        basis: state.basis,
        instruction: state.instruction,
      };
    case "settled":
      if (state.phase !== "working") return state;
      return { ...state, phase: "review", proposal: event.proposal };
    case "failed":
      if (state.phase !== "working") return state;
      return { ...state, phase: "failed", message: event.message };
  }
}

/** The request for a working review: its basis, instruction and the text around the selection. */
export function buildNfmAskForChangeRequest(
  state: Extract<NfmAskForChangeState, { phase: "working" }>,
): PageTextRewriteInput {
  const before = state.source.before.slice(-SURROUNDING_TEXT_CHARACTERS);
  const after = state.source.after.slice(0, SURROUNDING_TEXT_CHARACTERS);
  const context = {
    ...(before.trim() ? { before } : {}),
    ...(after.trim() ? { after } : {}),
  };
  return {
    markdown: state.basis,
    instruction: state.instruction,
    ...(Object.keys(context).length > 0 ? { context } : {}),
  };
}
