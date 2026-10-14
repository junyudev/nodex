import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { z } from "zod";
import type { IpcMainInvokeEvent } from "electron";
import { MainConfig } from "../../app/MainConfig";
import { CodexRealtimeVoice } from "../../codex-application/CodexRealtimeVoice";
import { CodexRealtimeVoicePolicy } from "../../codex-application/CodexRealtimeVoicePolicy";
import { RendererClientRuntime } from "../../host-runtime/RendererClientRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";

const identity = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value);
const targetSchema = z.object({ hostId: identity, threadId: identity }).strict();
const claimSchema = z.object({ claimId: z.string().uuid() }).strict();
const startSchema = claimSchema.extend({ sdp: z.string().min(1).max(1_048_576) }).strict();
const mediaSchema = claimSchema.extend({ evidence: z.enum(["connected", "initialized"]) }).strict();
const muteSchema = claimSchema
  .extend({ microphoneMuted: z.boolean(), outputMuted: z.boolean() })
  .strict();
const textSchema = claimSchema
  .extend({
    role: z.enum(["user", "developer", "assistant"]),
    text: z.string().min(1).max(1_048_576),
  })
  .strict();
export class CodexRealtimeVoiceIpcError extends Schema.TaggedError<CodexRealtimeVoiceIpcError>()(
  "CodexRealtimeVoiceIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

/** Physical sender identity is resolved in Main; renderer input never chooses its microphone owner. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const voice = yield* CodexRealtimeVoice;
    const policy = yield* CodexRealtimeVoicePolicy;
    const clients = yield* RendererClientRuntime;
    const config = yield* MainConfig;
    const trusted = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Realtime voice", config.rendererUrl);
          if (clients.getClientIdForWebContentsId(event.sender.id) === null)
            throw new Error("A registered application renderer is required");
        },
        catch: (cause) => new CodexRealtimeVoiceIpcError({ operation: "authorize", cause }),
      });
    const decode = <T>(event: IpcMainInvokeEvent, input: unknown, schema: z.ZodType<T>) =>
      trusted(event).pipe(
        Effect.andThen(
          Effect.try({
            try: () => schema.parse(input),
            catch: (cause) => new CodexRealtimeVoiceIpcError({ operation: "input", cause }),
          }),
        ),
      );
    yield* ipc.handleQuery("codex:realtime-voice:read", (event, input) =>
      decode(event, input, targetSchema).pipe(
        Effect.flatMap((target) =>
          policy
            .isAvailable(target)
            .pipe(Effect.map((available) => ({ available, session: voice.readSession() }))),
        ),
      ),
    );
    yield* ipc.handleControl("codex:realtime-voice:prepare", (event, input) =>
      decode(event, input, targetSchema).pipe(
        Effect.flatMap((target) => voice.prepare(event.sender.id, target)),
      ),
    );
    yield* ipc.handlePlainCommand("codex:realtime-voice:start", (event, input) =>
      decode(event, input, startSchema).pipe(
        Effect.flatMap((value) => voice.start(event.sender.id, value.claimId, value.sdp)),
      ),
    );
    yield* ipc.handleControl("codex:realtime-voice:report-media", (event, input) =>
      decode(event, input, mediaSchema).pipe(
        Effect.flatMap((value) =>
          voice.reportMedia(event.sender.id, value.claimId, value.evidence),
        ),
      ),
    );
    yield* ipc.handleControl("codex:realtime-voice:set-muted", (event, input) =>
      decode(event, input, muteSchema).pipe(
        Effect.flatMap((value) => voice.setMuted(event.sender.id, value.claimId, value)),
      ),
    );
    yield* ipc.handlePlainCommand("codex:realtime-voice:stop", (event, input) =>
      decode(event, input, claimSchema).pipe(
        Effect.flatMap((value) => voice.stop(event.sender.id, value.claimId)),
      ),
    );
    yield* ipc.handleControl("codex:realtime-voice:release", (event, input) =>
      decode(event, input, claimSchema).pipe(
        Effect.flatMap((value) => voice.release(event.sender.id, value.claimId)),
      ),
    );
    yield* ipc.handlePlainCommand("codex:realtime-voice:append-text", (event, input) =>
      decode(event, input, textSchema).pipe(
        Effect.flatMap((value) =>
          voice.appendText(event.sender.id, value.claimId, value.role, value.text),
        ),
      ),
    );
  }),
);
