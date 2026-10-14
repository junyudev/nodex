import type { ConversationTextRole } from "@nodex/codex-app-server-protocol";
import type {
  ThreadRealtimeStartParams,
  ThreadRealtimeStartedNotification,
  ThreadRealtimeClosedNotification,
  ThreadRealtimeErrorNotification,
  ThreadRealtimeSdpNotification,
  ThreadRealtimeAppendSpeechParams,
  ThreadRealtimeItemAddedNotification,
} from "@nodex/codex-app-server-protocol/v2";

export interface CodexRealtimeVoiceTarget {
  readonly hostId: string;
  readonly threadId: string;
}

export interface CodexRealtimeVoiceGrant extends CodexRealtimeVoiceTarget {
  readonly claimId: string;
  readonly realtimeSessionId: string;
  readonly microphoneInputDeviceId: string | null;
  readonly builtInMicrophoneLabelHint: string | null;
  readonly bufferInputWhileConnecting: boolean;
}

export type CodexRealtimeVoicePhase = "starting" | "active" | "stopping";

export interface CodexRealtimeVoiceSnapshot extends CodexRealtimeVoiceTarget {
  readonly claimId: string;
  readonly realtimeSessionId: string;
  readonly phase: CodexRealtimeVoicePhase;
  readonly microphoneMuted: boolean;
  readonly outputMuted: boolean;
  readonly revision: number;
}

/** Native startup settings remain a generated-protocol projection, never a parallel wire shape. */
export type CodexRealtimeVoiceStartSettings = Readonly<
  Omit<
    ThreadRealtimeStartParams,
    "threadId" | "transport" | "realtimeSessionId" | "codexResponseHandoffChannelPrefixes"
  >
> & {
  readonly codexResponseHandoffChannelPrefixes?: Readonly<Record<string, readonly string[]>> | null;
};

export type CodexRealtimeVoiceNativeNotification =
  | {
      readonly method: "thread/realtime/started";
      readonly params: ThreadRealtimeStartedNotification;
    }
  | { readonly method: "thread/realtime/sdp"; readonly params: ThreadRealtimeSdpNotification }
  | { readonly method: "thread/realtime/closed"; readonly params: ThreadRealtimeClosedNotification }
  | { readonly method: "thread/realtime/error"; readonly params: ThreadRealtimeErrorNotification }
  | {
      readonly method: "thread/realtime/itemAdded";
      readonly params: ThreadRealtimeItemAddedNotification;
    };

export type CodexRealtimeVoiceMediaEvidence = "connected" | "initialized";

export type CodexRealtimeVoiceEvent =
  | { readonly type: "snapshot"; readonly snapshot: CodexRealtimeVoiceSnapshot }
  | {
      readonly type: "native";
      readonly claimId: string;
      readonly notification: CodexRealtimeVoiceNativeNotification;
    }
  | { readonly type: "terminate"; readonly claimId: string }
  | { readonly type: "availabilityChanged" }
  | {
      readonly type: "microphoneChanged";
      readonly claimId: string;
      readonly deviceId: string | null;
    };

export interface CodexRealtimeVoiceStartupEvidence {
  readonly requestAccepted: boolean;
  readonly started: boolean;
  readonly connected: boolean;
  readonly initialized: boolean;
}

export const isCodexRealtimeVoiceStartupComplete = (
  evidence: CodexRealtimeVoiceStartupEvidence,
): boolean =>
  evidence.requestAccepted && evidence.started && evidence.connected && evidence.initialized;

export interface CodexRealtimeVoiceReadResult {
  readonly available: boolean;
  /** The Profile's current claim, including when it belongs to another Thread or window. */
  readonly session: CodexRealtimeVoiceSnapshot | null;
}
export interface CodexRealtimeVoiceClaimInput {
  readonly claimId: string;
}
export interface CodexRealtimeVoiceStartInput extends CodexRealtimeVoiceClaimInput {
  readonly sdp: string;
}
export interface CodexRealtimeVoiceMediaInput extends CodexRealtimeVoiceClaimInput {
  readonly evidence: CodexRealtimeVoiceMediaEvidence;
}
export interface CodexRealtimeVoiceMuteInput extends CodexRealtimeVoiceClaimInput {
  readonly microphoneMuted: boolean;
  readonly outputMuted: boolean;
}
export interface CodexRealtimeVoiceAppendTextInput extends CodexRealtimeVoiceClaimInput {
  readonly role: ConversationTextRole;
  readonly text: string;
}
export interface CodexRealtimeVoiceAppendSpeechInput
  extends CodexRealtimeVoiceClaimInput, Readonly<Pick<ThreadRealtimeAppendSpeechParams, "text">> {}
export interface CodexRealtimeVoiceInjectContextInput extends CodexRealtimeVoiceClaimInput {
  readonly attachments: readonly import("./codex-untrusted-app-input").CodexAppModelContextAttachment[];
}
