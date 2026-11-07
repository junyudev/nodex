import type { GlobalDictationRendererEvent } from "../../../shared/global-dictation";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
} from "@/lib/renderer-command";

const transcribeDictationCommand = defineRendererCommand({
  key: "dictation.transcribe",
  channel: "codex:dictation:transcribe",
  authority: "external",
  owner: "DictationSessionController",
  protocol: { kind: "pending_operation" },
});

export function reportGlobalDictationEvent(event: GlobalDictationRendererEvent) {
  return invokeRendererControl("global-dictation:event", event);
}

export function cancelDictationRequest(requestId: string) {
  return invokeRendererControl("codex:dictation:transcribe:cancel", requestId);
}

export function transcribeDictationRequest(input: {
  readonly requestId: string;
  readonly contentType: string;
  readonly base64Payload: string;
}) {
  return invokePlainCommand(transcribeDictationCommand, input);
}
