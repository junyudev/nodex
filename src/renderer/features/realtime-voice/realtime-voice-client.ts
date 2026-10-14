import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import type {
  CodexRealtimeVoiceTarget,
  CodexRealtimeVoiceReadResult,
  CodexRealtimeVoiceGrant,
  CodexRealtimeVoiceEvent,
  CodexRealtimeVoiceMediaEvidence,
  CodexRealtimeVoiceMuteInput,
} from "../../../shared/codex-realtime-voice";
import type { ConversationTextRole } from "@nodex/codex-app-server-protocol";
import type { CodexAppModelContextAttachment } from "../../../shared/codex-untrusted-app-input";
import { isAppContextJson } from "../../../shared/codex-untrusted-app-input";
import type { ThreadRealtimeItemAddedNotification } from "@nodex/codex-app-server-protocol/v2";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
  invokeRendererQuery,
} from "../../lib/renderer-command";

const startVoiceCommand = defineRendererCommand({
  key: "realtime_voice.start",
  channel: "codex:realtime-voice:start",
  authority: "external",
  owner: "RealtimeVoiceWindow",
  protocol: { kind: "pending_operation" },
});
const stopVoiceCommand = defineRendererCommand({
  key: "realtime_voice.stop",
  channel: "codex:realtime-voice:stop",
  authority: "external",
  owner: "RealtimeVoiceWindow",
  protocol: { kind: "pending_operation" },
});
const appendVoiceTextCommand = defineRendererCommand({
  key: "realtime_voice.append_text",
  channel: "codex:realtime-voice:append-text",
  authority: "external",
  owner: "RealtimeVoiceWindow",
  protocol: { kind: "pending_operation" },
});
const appendVoiceSpeechCommand = defineRendererCommand({
  key: "realtime_voice.append_speech",
  channel: "codex:realtime-voice:append-speech",
  authority: "external",
  owner: "RealtimeVoiceWindow",
  protocol: { kind: "pending_operation" },
});
const injectVoiceContextCommand = defineRendererCommand({
  key: "realtime_voice.inject_context",
  channel: "codex:realtime-voice:inject-context",
  authority: "external",
  owner: "RealtimeVoiceWindow",
  protocol: { kind: "pending_operation" },
});
const native = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("thread/realtime/itemAdded"),
    params: z.object({
      threadId: z.string(),
      item: z.custom<ThreadRealtimeItemAddedNotification["item"]>(isAppContextJson),
    }),
  }),
  z.object({
    method: z.literal("thread/realtime/started"),
    params: z.object({
      threadId: z.string(),
      realtimeSessionId: z.string().nullable(),
      version: z.enum(["v1", "v2", "v3"]),
    }),
  }),
  z.object({
    method: z.literal("thread/realtime/sdp"),
    params: z.object({ threadId: z.string(), sdp: z.string() }),
  }),
  z.object({
    method: z.literal("thread/realtime/error"),
    params: z.object({ threadId: z.string(), message: z.string() }),
  }),
  z.object({
    method: z.literal("thread/realtime/closed"),
    params: z.object({ threadId: z.string(), reason: z.string().nullable() }),
  }),
]);
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("availabilityChanged") }).strict(),
  z.object({ type: z.literal("terminate"), claimId: z.string().uuid() }).strict(),
  z
    .object({
      type: z.literal("microphoneChanged"),
      claimId: z.string().uuid(),
      deviceId: z.string().nullable(),
    })
    .strict(),
  z
    .object({ type: z.literal("native"), claimId: z.string().uuid(), notification: native })
    .strict(),
  z
    .object({
      type: z.literal("snapshot"),
      snapshot: z
        .object({
          hostId: z.string(),
          threadId: z.string(),
          claimId: z.string().uuid(),
          realtimeSessionId: z.string().uuid(),
          phase: z.enum(["starting", "active", "stopping"]),
          microphoneMuted: z.boolean(),
          outputMuted: z.boolean(),
          revision: z.number().int().nonnegative(),
        })
        .strict(),
    })
    .strict(),
]);
export const parseRealtimeVoiceEvent = (input: unknown): CodexRealtimeVoiceEvent | null => {
  const result = eventSchema.safeParse(input);
  return result.success ? result.data : null;
};

/** The attempt uses semantic operations; SDP and native methods never cross a generic renderer RPC route. */
export interface RealtimeVoiceClient {
  read(target: CodexRealtimeVoiceTarget): Promise<CodexRealtimeVoiceReadResult>;
  prepare(target: CodexRealtimeVoiceTarget): Promise<CodexRealtimeVoiceGrant>;
  start(claimId: string, sdp: string): Promise<void>;
  reportMedia(claimId: string, evidence: CodexRealtimeVoiceMediaEvidence): Promise<void>;
  setMuted(input: CodexRealtimeVoiceMuteInput): Promise<void>;
  stop(claimId: string): Promise<void>;
  release(claimId: string): Promise<boolean>;
  appendText(claimId: string, role: ConversationTextRole, text: string): Promise<void>;
  appendSpeech(claimId: string, text: string): Promise<void>;
  injectContext(
    claimId: string,
    attachments: readonly CodexAppModelContextAttachment[],
  ): Promise<void>;
  subscribe(listener: (event: CodexRealtimeVoiceEvent) => void): () => void;
}
export const mainRealtimeVoiceClient: RealtimeVoiceClient = {
  read: (target) => invokeRendererQuery("codex:realtime-voice:read", target),
  prepare: (target) => invokeRendererControl("codex:realtime-voice:prepare", target),
  start: (claimId, sdp) => invokePlainCommand(startVoiceCommand, { claimId, sdp }),
  reportMedia: (claimId, evidence) =>
    invokeRendererControl("codex:realtime-voice:report-media", { claimId, evidence }),
  setMuted: (input) => invokeRendererControl("codex:realtime-voice:set-muted", input),
  stop: (claimId) => invokePlainCommand(stopVoiceCommand, { claimId }),
  release: (claimId) => invokeRendererControl("codex:realtime-voice:release", { claimId }),
  appendText: (claimId, role, text) =>
    invokePlainCommand(appendVoiceTextCommand, { claimId, role, text }),
  appendSpeech: (claimId, text) => invokePlainCommand(appendVoiceSpeechCommand, { claimId, text }),
  injectContext: (claimId, attachments) =>
    invokePlainCommand(injectVoiceContextCommand, { claimId, attachments }),
  subscribe: (listener) => {
    if (!window.api) return () => undefined;
    return window.api.on("codex:realtime-voice:event", (input) => {
      const event = parseRealtimeVoiceEvent(input);
      if (event) listener(event);
    });
  },
};

export const realtimeVoiceAvailabilityQueryOptions = (target: CodexRealtimeVoiceTarget | null) =>
  queryOptions({
    queryKey: [
      "realtime-voice-availability",
      target?.hostId ?? null,
      target?.threadId ?? null,
      target,
    ],
    enabled: target !== null,
    queryFn: () => {
      if (!target) throw new Error("A native chat is required");
      return mainRealtimeVoiceClient.read(target);
    },
    staleTime: 60_000,
    refetchOnWindowFocus: "always",
    retry: false,
  });
