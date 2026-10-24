import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import type { AgentRuntimeLaunch } from "../../shared/agent-runtime-api";
import {
  buildThreadTitleGenerationPrompt,
  CODEX_THREAD_TITLE_OUTPUT_SCHEMA,
  CODEX_THREAD_TITLE_TIMEOUT_MS,
  parseGeneratedThreadMetadata,
} from "../codex/thread-title-generator";
import type { AgentRuntimeApplicationConnection } from "./AgentRuntimeApplication";

type Providers = AgentRuntimeOperations["providers.read"]["output"];
type ModelSelection = AgentRuntimeLaunch["modelSelection"];

const LIGHT_EFFORTS = ["minimal", "low"] as const;

/** The chat's own model at its lightest effort, so a title needs no other provider account. */
export const titleModelSelection = (
  selection: ModelSelection,
  providers: Providers,
): ModelSelection => {
  const model = providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((candidate) => candidate.slug === selection.model);
  const effort = model?.capabilities?.optionDescriptors?.find(
    (option) => option.type === "select" && /effort|reasoning/i.test(option.id),
  );
  const light =
    effort?.type === "select"
      ? LIGHT_EFFORTS.find((id) => effort.options.some((option) => option.id === id))
      : undefined;
  return {
    instanceId: selection.instanceId,
    model: selection.model,
    ...(effort && light ? { options: [{ id: effort.id, value: light }] } : {}),
  };
};

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
    modelSelection: titleModelSelection(input.modelSelection, providers),
    outputSchema: CODEX_THREAD_TITLE_OUTPUT_SCHEMA,
    timeoutMs: CODEX_THREAD_TITLE_TIMEOUT_MS,
  });
  return parseGeneratedThreadMetadata(output)?.title ?? null;
});
