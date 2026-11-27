import {
  DEFAULT_MINI_ANCHOR,
  DEFAULT_MINI_SETTINGS,
  miniVisibility,
  EMPTY_MINI_COVERAGE,
  miniCoverageIsEmpty,
  type MiniAnchor,
  type MiniCoverage,
  type MiniHideReason,
  type MiniPresentationEvent,
  type MiniVisibility,
} from "../../shared/mini";

interface MiniPresence {
  readonly visibility: MiniVisibility;
  readonly coverage: MiniCoverage;
  readonly workbenchFocused: boolean;
  readonly previewsDocked: boolean;
  readonly previewDockRequested: boolean;
}

export interface MiniPresentationState extends MiniPresence {
  readonly anchor: MiniAnchor;
  readonly event: MiniPresentationEvent;
}

export type MiniPresentationAction =
  | { readonly kind: "presence"; readonly update: Partial<MiniPresence> }
  | { readonly kind: "anchor"; readonly anchor: MiniAnchor }
  | { readonly kind: "shortcut" }
  | { readonly kind: "focus" }
  | { readonly kind: "release"; readonly generation: number }
  | { readonly kind: "open-settled"; readonly opened: boolean; readonly hasKeyboard: boolean }
  | { readonly kind: "blur"; readonly dialogOpen: boolean }
  | { readonly kind: "renderer-lost" };

export function initialMiniPresentation(
  visibility = miniVisibility(DEFAULT_MINI_SETTINGS),
): MiniPresentationState {
  return {
    visibility,
    coverage: EMPTY_MINI_COVERAGE,
    workbenchFocused: false,
    previewsDocked: false,
    previewDockRequested: false,
    anchor: DEFAULT_MINI_ANCHOR,
    event: { kind: "hidden", generation: 0, reason: "idle" },
  };
}

function show(
  state: MiniPresentationState,
  kind: "focused" | "resting",
  anchor = state.anchor,
): MiniPresentationState {
  if (kind === state.event.kind && anchor === state.anchor) return state;
  return { ...state, anchor, event: { kind, generation: state.event.generation + 1, anchor } };
}

function hide(state: MiniPresentationState, reason: MiniHideReason): MiniPresentationState {
  if (state.event.kind === "hidden") return state;
  return { ...state, event: { kind: "hidden", generation: state.event.generation + 1, reason } };
}

function settle(state: MiniPresentationState, reason: MiniHideReason): MiniPresentationState {
  if (state.visibility !== "on-demand" && (state.previewsDocked || state.previewDockRequested)) {
    return show(state, "resting");
  }
  const shouldRest =
    state.visibility === "always" ||
    (state.visibility === "active" && !miniCoverageIsEmpty(state.coverage));
  return shouldRest && !state.workbenchFocused ? show(state, "resting") : hide(state, reason);
}

export function transitionMiniPresentation(
  state: MiniPresentationState,
  action: MiniPresentationAction,
): MiniPresentationState {
  switch (action.kind) {
    case "focus":
      return show(state, "focused");
    case "shortcut":
      return state.event.kind === "focused" ? settle(state, "toggled") : show(state, "focused");
    case "release":
      if (state.event.kind !== "focused" || state.event.generation !== action.generation)
        return state;
      return settle(state, "dismissed");
    case "open-settled":
      if (state.event.kind !== "focused" || action.hasKeyboard) return state;
      return settle(state, action.opened ? "finished" : "blurred");
    case "blur":
      return state.event.kind === "focused" && !action.dialogOpen
        ? settle(state, "blurred")
        : state;
    case "presence": {
      const next = { ...state, ...action.update };
      if (next.visibility === "on-demand" && state.visibility !== "on-demand") {
        return hide({ ...next, previewDockRequested: false }, "idle");
      }
      return next.event.kind === "focused" ? next : settle(next, "idle");
    }
    case "anchor": {
      const { anchor } = action;
      if (
        anchor.vertical === state.anchor.vertical &&
        anchor.horizontal === state.anchor.horizontal
      )
        return state;
      return state.event.kind === "hidden"
        ? { ...state, anchor }
        : show(state, state.event.kind, anchor);
    }
    case "renderer-lost":
      return hide({ ...state, coverage: EMPTY_MINI_COVERAGE }, "finished");
  }
}
