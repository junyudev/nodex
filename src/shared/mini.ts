import type { MobileEventData } from "@nodex/mobile-protocol";

/**
 * Mini is Nodex's one presence over other apps: a dock that shows what your chats are doing,
 * cards for the ones that need you, a composer that starts a chat (`Enter`) or saves to the Inbox
 * (`Cmd/Ctrl+Enter`), and a home beside it for the live previews of agents using this computer. It is a client of the same Member companion contract the phone uses
 * (`@nodex/mobile-protocol`), so its chats, attention and actions read exactly as they do there.
 *
 * Main owns the panel window, its shortcut, where it sits, when it is on screen, whether it holds
 * the keyboard, and the previews docked beside it. The panel's renderer owns everything drawn in it.
 */

/** The renderer route the panel window loads. */
export const MINI_ROUTE = "/mini";

/** Main → panel renderer: how the panel is presented now. */
export const MINI_PRESENTATION_CHANNEL = "mini:presentation";

/** Main → panel renderer: one companion event (`changed`, `chat.activity`, `chat.patch`, …). */
export const MINI_COMPANION_EVENT_CHANNEL = "mini:companion:event";

/** Main → panel renderer: the chats with a live preview, and whether previews dock beside Mini. */
export const MINI_PREVIEWS_CHANNEL = "mini:previews";

export interface MiniRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What Mini draws, in its window's coordinates, so previews can dock beside it. */
export interface MiniContentLayout {
  /** Everything Mini draws now: its dock or composer, its cards, a passing notice. */
  readonly content: MiniRect;
  /** The dock, or the composer while it is open: the edge docked previews line up with. */
  readonly base: MiniRect;
}

export type MiniPreviewVisibility = "shown" | "hidden";

/**
 * Live previews of agents using this computer (Computer Use, Browser Use), as Mini offers them.
 * A chat appears while its agent has a live preview; its visibility is the person's choice for it.
 */
export interface MiniPreviews {
  /** By companion chat session id. */
  readonly chats: Readonly<Record<string, MiniPreviewVisibility>>;
  /** Whether previews dock beside Mini now, rather than in a Nodex window. */
  readonly docked: boolean;
}

export const NO_MINI_PREVIEWS: MiniPreviews = { chats: {}, docked: false };

/**
 * Where the panel sits on its display. Its content grows away from that edge: cards stack above a
 * dock at the bottom, below a dock at the top.
 */
export interface MiniAnchor {
  readonly vertical: "top" | "bottom";
  readonly horizontal: "left" | "center" | "right";
}

export const DEFAULT_MINI_ANCHOR: MiniAnchor = { vertical: "bottom", horizontal: "center" };

/** How a shown Mini rests on screen: while anything is your concern, or always. */
export const MINI_RESTING_MODES = ["active", "always"] as const;

export type MiniResting = (typeof MINI_RESTING_MODES)[number];

/**
 * Whether Mini is shown over other apps, and how it rests while shown. It starts hidden, and once
 * someone asks to see it, it stays in view; its shortcut opens it either way, and hiding it keeps
 * how it rests for when it is shown again.
 */
export interface MiniSettings {
  readonly shown: boolean;
  readonly resting: MiniResting;
}

export const DEFAULT_MINI_SETTINGS: MiniSettings = { shown: false, resting: "always" };

/**
 * When Mini is on screen without being asked for: `always`; `active` while any chat works or
 * something needs the person; `on-demand` only while its shortcut has it open.
 */
export const MINI_VISIBILITIES = ["always", "active", "on-demand"] as const;

export type MiniVisibility = (typeof MINI_VISIBILITIES)[number];

export const miniVisibility = ({ shown, resting }: MiniSettings): MiniVisibility =>
  shown ? resting : "on-demand";

export type MiniHideReason =
  /** Escape, or the renderer released the keyboard with nothing to show. */
  | "dismissed"
  /** The person clicked into another app or window while Mini held the keyboard. */
  | "blurred"
  /** The shortcut was pressed while Mini held the keyboard. */
  | "toggled"
  /** Current activity, visibility settings, or Workbench focus keep a resting Mini off screen. */
  | "idle"
  /** Nodex opened what Mini pointed to, or the panel renderer was retired. */
  | "finished";

export type MiniPresentationEvent =
  | {
      /** On screen and holding the keyboard; focus what the renderer last asked for. */
      readonly kind: "focused";
      readonly generation: number;
      readonly anchor: MiniAnchor;
    }
  | {
      /** On screen without the keyboard: the dock and its cards. */
      readonly kind: "resting";
      readonly generation: number;
      readonly anchor: MiniAnchor;
    }
  | {
      readonly kind: "hidden";
      readonly generation: number;
      readonly reason: MiniHideReason;
    };

/**
 * What Mini is showing: the chats and Page Turns it has a card for, and whether a passing notice
 * (such as `Saved to Inbox`) wants it on screen. With `active` visibility Mini rests on screen only
 * while this is not empty, and while it rests it stands in for the system notifications of exactly
 * what it covers.
 */
export interface MiniCoverage {
  /** Chat session ids. */
  readonly chats: readonly string[];
  readonly turns: readonly MiniTurnRef[];
  readonly notice: boolean;
}

export interface MiniTurnRef {
  readonly pageId: string;
  readonly episode: string;
}

export const EMPTY_MINI_COVERAGE: MiniCoverage = { chats: [], turns: [], notice: false };

export const miniCoverageIsEmpty = (coverage: MiniCoverage): boolean =>
  coverage.chats.length === 0 && coverage.turns.length === 0 && !coverage.notice;

export type MiniDrag =
  | { readonly phase: "start"; readonly x: number; readonly y: number }
  | { readonly phase: "end" };

/** What Mini can bring forward in a Nodex window. */
export type MiniOpenTarget =
  | { readonly kind: "inbox"; readonly scope: import("./inbox").InboxScope }
  | { readonly kind: "page"; readonly pageId: string }
  | { readonly kind: "session"; readonly sessionId: string };

/** Companion methods the panel may call; everything else in the contract is the phone's alone. */
export const MINI_COMPANION_METHODS = [
  "projects.list",
  "chats.list",
  "chats.unread",
  "chats.start",
  "chat.open",
  "chat.close",
  "chat.send",
  "chat.stop",
  "chat.respond",
  "chat.markRead",
  "inbox.window",
  "inbox.turns",
  "inbox.decide",
] as const;

type MiniCompanionEventName = "changed" | "chat.activity" | "chat.patch" | "chat.snapshot";

export type MiniCompanionEvent = {
  [K in MiniCompanionEventName]: {
    readonly event: K;
    readonly data: MobileEventData<K>;
  };
}[MiniCompanionEventName];

export type MiniCompanionMethod = (typeof MINI_COMPANION_METHODS)[number];

/**
 * A companion call's outcome. Errors keep the contract's own shape (`RpcError`) so the panel can
 * say what the phone would say.
 */
export type MiniCompanionResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: import("@nodex/mobile-protocol").RpcError };

/** IPC channels the panel renderer invokes; only the Mini panel window may call them. */
export interface MiniIpcApi {
  /** Where Mini's drawn content sits now; null while nothing is drawn. */
  "mini:layout": { args: [layout: MiniContentLayout | null]; result: void };
  /** Show or hide one chat's live preview, as its own preview controls would. */
  "mini:preview-visibility": {
    args: [sessionId: string, visibility: MiniPreviewVisibility];
    result: void;
  };
  /** The renderer mounted and can be shown. */
  "mini:ready": { args: []; result: void };
  /** Whether the pointer is over drawn content; elsewhere it reaches the app beneath. */
  "mini:pointer": { args: [overContent: boolean]; result: void };
  /** What Mini is showing now; see `MiniCoverage`. */
  "mini:activity": { args: [coverage: MiniCoverage]; result: void };
  /**
   * Move Mini with the pointer: `start` once it is held past a small threshold, from the screen
   * point where it was grabbed; `end` when it is released, to settle at the nearest placement.
   */
  "mini:drag": { args: [drag: MiniDrag]; result: void };
  /** Take the keyboard, for the composer or a card's reply. */
  "mini:focus": { args: []; result: void };
  /** Give the keyboard back, from the presentation that held it. */
  "mini:release": { args: [generation: number]; result: void };
  /** Bring a Nodex window forward showing the target; Mini keeps resting. */
  "mini:open": { args: [target: MiniOpenTarget]; result: void };
  /** One Member companion call, as the personal Space's owner on this desktop. */
  "mini:companion:invoke": {
    args: [method: MiniCompanionMethod, params: unknown];
    result: MiniCompanionResult;
  };
}
