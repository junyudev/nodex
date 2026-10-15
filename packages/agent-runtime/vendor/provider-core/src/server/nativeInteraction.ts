import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type {
  ThreadRealtimeStartParams, ThreadRealtimeStartResponse,
  ThreadRealtimeStopParams, ThreadRealtimeStopResponse,
  ThreadRealtimeAppendTextParams, ThreadRealtimeAppendTextResponse,
  ThreadRealtimeAppendSpeechParams, ThreadRealtimeAppendSpeechResponse,
  ThreadRealtimeListVoicesResponse, ThreadInjectItemsParams, ThreadInjectItemsResponse,
  ThreadResumeParams, ThreadResumeResponse, ThreadForkParams, ThreadForkResponse,
  TurnStartParams, TurnStartResponse, TurnInterruptParams, TurnInterruptResponse,
  ThreadUnsubscribeParams, ThreadUnsubscribeResponse, ExperimentalFeatureListParams, ExperimentalFeatureListResponse,
} from "@nodex/codex-app-server-protocol/v2";
import type { ProviderAdapterV2Error } from "./ProviderAdapter.ts";

/** Finite native capabilities on the Session's existing client; never a transport RPC. */
export interface CodexNativeMethods {
  "thread/realtime/start": [ThreadRealtimeStartParams, ThreadRealtimeStartResponse];
  "thread/realtime/stop": [ThreadRealtimeStopParams, ThreadRealtimeStopResponse];
  "thread/realtime/appendText": [ThreadRealtimeAppendTextParams, ThreadRealtimeAppendTextResponse];
  "thread/realtime/appendSpeech": [ThreadRealtimeAppendSpeechParams, ThreadRealtimeAppendSpeechResponse];
  "thread/realtime/listVoices": [Record<string, never>, ThreadRealtimeListVoicesResponse];
  "experimentalFeature/list": [ExperimentalFeatureListParams, ExperimentalFeatureListResponse];
  "thread/inject_items": [ThreadInjectItemsParams, ThreadInjectItemsResponse];
  "thread/resume": [ThreadResumeParams, ThreadResumeResponse];
  "thread/fork": [ThreadForkParams, ThreadForkResponse];
  "turn/start": [TurnStartParams, TurnStartResponse];
  "turn/interrupt": [TurnInterruptParams, TurnInterruptResponse];
  "thread/unsubscribe": [ThreadUnsubscribeParams, ThreadUnsubscribeResponse];
}
export interface CodexNativeNotification { readonly method: string; readonly params?: unknown }
export interface CodexNativeInteraction {
  readonly initialize: Effect.Effect<{ readonly userAgent: string }, ProviderAdapterV2Error>;
  readonly request: <M extends keyof CodexNativeMethods>(method: M, params: CodexNativeMethods[M][0]) => Effect.Effect<CodexNativeMethods[M][1], ProviderAdapterV2Error>;
  readonly notifications: Stream.Stream<CodexNativeNotification, ProviderAdapterV2Error>;
  /** Emitted only after the Adapter has retained this exact unknown root Turn's early frames. */
  readonly inputs: Stream.Stream<{ readonly nativeThreadId: string; readonly nativeTurnId: string; readonly text: string }>;
  readonly retain: (nativeThreadId: string) => Effect.Effect<Effect.Effect<void>>;
  /** Hidden helpers never enter product history or native-origin Turn adoption. */
  readonly hasPendingTurn: (nativeThreadId: string, nativeTurnId: string) => Effect.Effect<boolean>;
  readonly cancelPendingTurn: (nativeThreadId: string, nativeTurnId: string) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly voice: (nativeThreadId: string, active: boolean) => Effect.Effect<void>;
  readonly helper: (nativeThreadId: string, active: boolean) => Effect.Effect<void>;
}
