import * as Effect from "effect/Effect";
import { lightUtilityModelSelection } from "../../shared/agent-runtime-utility-model";
import type { AgentRuntimeLaunch } from "../../shared/agent-runtime-api";
import {
  buildThreadTitleGenerationPrompt,
  CODEX_THREAD_TITLE_OUTPUT_SCHEMA,
  CODEX_THREAD_TITLE_TIMEOUT_MS,
  parseGeneratedThreadMetadata,
} from "../codex/thread-title-generator";
import type { AgentRuntimeApplicationConnection } from "./AgentRuntimeApplication";

type ModelSelection = AgentRuntimeLaunch["modelSelection"];

/**
 * Generates a title from a chat's opening prompt through the Runtime's structured generation.
 * Returns null when the prompt or the reply cannot produce one.
 */
export const generateSessionTitle = Effect.fn("AgentRuntimeSessionTitle.generate")(function* (
  connection: Pick<AgentRuntimeApplicationConnection, "request">,
  input: { readonly prompt: string; readonly cwd: string; readonly modelSelection: ModelSelection },
) {
  const prompt = buildThreadTitleGenerationPrompt(input.prompt);
  if (!prompt) return null;
  const providers = yield* connection.request("providers.read", {});
  const provider = providers.find(
    (candidate) => candidate.instanceId === input.modelSelection.instanceId,
  );
  if (provider?.supportsTextGeneration === false) return null;
  const output = yield* connection.request("text.generate-structured", {
    cwd: input.cwd,
    prompt,
    modelSelection: lightUtilityModelSelection(input.modelSelection, providers),
    outputSchema: CODEX_THREAD_TITLE_OUTPUT_SCHEMA,
    timeoutMs: CODEX_THREAD_TITLE_TIMEOUT_MS,
  });
  return parseGeneratedThreadMetadata(output)?.title ?? null;
});
