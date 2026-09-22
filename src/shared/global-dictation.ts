import type { DictationError, DictationGesture } from "./dictation";

export const GLOBAL_DICTATION_COMMAND_CHANNEL = "global-dictation:command";
export type GlobalDictationContextMenuAction = "close-window" | null;

export interface GlobalDictationTarget {
  readonly pid: number;
  readonly bundleIdentifier: string;
}

export interface GlobalDictationPasteFailure {
  readonly text: string;
  readonly copied: boolean;
  readonly reason: "accessibility" | "clipboard-changed" | "paste";
}

export type GlobalDictationDeclineReason =
  | "busy"
  | "deadline-expired"
  | "focus-not-owned"
  | "hidden"
  | "unavailable";

export type GlobalDictationRendererCommand =
  | {
      readonly type: "idle";
      readonly configuredHotkey: string | null;
      readonly configuredToggleHotkey: string | null;
    }
  | {
      readonly type: "start";
      readonly sessionId: string;
      readonly requestId: string;
      readonly deadlineAtMs: number;
      readonly gesture: Extract<DictationGesture, "hold" | "toggle">;
      readonly activationStartedAtMs?: number;
    }
  | { readonly type: "stop"; readonly sessionId: string }
  | { readonly type: "cancel"; readonly sessionId: string }
  | { readonly type: "finish"; readonly sessionId: string }
  | {
      readonly type: "paste-completed";
      readonly sessionId: string;
      readonly clipboardRestoreMs: number;
    }
  | {
      readonly type: "paste-failed";
      readonly sessionId: string;
      readonly error: DictationError;
      readonly failure: GlobalDictationPasteFailure;
    };

export type GlobalDictationRendererEvent =
  | { readonly type: "ready" }
  | {
      readonly type: "accepted";
      readonly sessionId: string;
      readonly requestId: string;
      readonly targetId: string;
    }
  | {
      readonly type: "declined";
      readonly sessionId: string;
      readonly requestId: string;
      readonly reason: GlobalDictationDeclineReason;
    }
  | {
      readonly type: "state";
      readonly sessionId: string;
      readonly state: "listening" | "transcribing";
    }
  | { readonly type: "completed"; readonly sessionId: string; readonly transcript: string }
  | { readonly type: "recording-stopped"; readonly sessionId: string }
  | { readonly type: "stop-requested"; readonly sessionId: string }
  | { readonly type: "copy-transcript"; readonly sessionId: string }
  | { readonly type: "open-accessibility-settings"; readonly sessionId: string }
  | { readonly type: "view-recording"; readonly sessionId: string; readonly recordingId: string }
  | { readonly type: "copy-recovered-text"; readonly sessionId: string; readonly text: string }
  | { readonly type: "cancelled"; readonly sessionId: string }
  | { readonly type: "failed"; readonly sessionId: string; readonly error: DictationError }
  | { readonly type: "dismiss"; readonly sessionId: string }
  | { readonly type: "close"; readonly sessionId: string | null }
  | { readonly type: "interactive"; readonly enabled: boolean };

export type GlobalDictationManagerSnapshot =
  | { readonly kind: "idle" }
  | { readonly kind: "routing-in-app"; readonly sessionId: string }
  | { readonly kind: "overlay-starting"; readonly sessionId: string }
  | {
      readonly kind: "recording" | "transcribing";
      readonly sessionId: string;
      readonly owner: "in-app" | "overlay";
    }
  | { readonly kind: "pasting"; readonly sessionId: string }
  | {
      readonly kind: "retryable-error";
      readonly sessionId: string;
      readonly error: DictationError;
    };
