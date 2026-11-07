import * as Effect from "effect/Effect";
import {
  economicalUtilityModel,
  lightUtilityModelSelection,
} from "../../shared/agent-runtime-utility-model";
import { isModelOn, spendsNodexCredit, type ModelPolicy } from "../../shared/model-policy";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AgentRuntimeLaunch } from "../../shared/agent-runtime-api";
import type { AgentRuntimeTitleModel } from "../../shared/agent-runtime-settings";
import {
  buildThreadTitleGenerationPrompt,
  CODEX_THREAD_TITLE_OUTPUT_SCHEMA,
  CODEX_THREAD_TITLE_TIMEOUT_MS,
  parseGeneratedThreadMetadata,
} from "../codex/thread-title-generator";
import type { AgentRuntimeApplicationConnection } from "./AgentRuntimeApplication";

type ModelSelection = AgentRuntimeLaunch["modelSelection"];
type Providers = AgentRuntimeOperations["providers.read"]["output"];

/**
 * The Profile's title model, or else a light model on the chat's own Agent, so its first message
 * goes nowhere new. Credit is spent only on a model the person chose, so a credit chat keeps its own.
 */
const titleModelSelection = (
  input: {
    readonly modelSelection: ModelSelection;
    readonly titleModel: AgentRuntimeTitleModel | null;
    readonly modelPolicy: ModelPolicy;
  },
  providers: Providers,
): ModelSelection => {
  if (input.titleModel) return input.titleModel;
  const provider = providers.find(
    (candidate) => candidate.instanceId === input.modelSelection.instanceId,
  );
  if (!provider || spendsNodexCredit(provider)) return input.modelSelection;
  const light = economicalUtilityModel({
    driver: provider.driver,
    models: provider.models.filter((model) => isModelOn(input.modelPolicy, provider, model.slug)),
  });
  return light ? { instanceId: provider.instanceId, model: light.slug } : input.modelSelection;
};

/**
 * Generates a title from a chat's opening prompt through the Runtime's structured generation. The
 * Runtime refuses a chosen model that cannot run, and nothing replaces it. Returns null when the
 * prompt or the reply cannot produce a title.
 */
export const generateSessionTitle = Effect.fn("AgentRuntimeSessionTitle.generate")(function* (
  connection: Pick<AgentRuntimeApplicationConnection, "request">,
  input: {
    readonly prompt: string;
    readonly cwd: string;
    readonly modelSelection: ModelSelection;
    readonly titleModel: AgentRuntimeTitleModel | null;
    readonly modelPolicy: ModelPolicy;
  },
) {
  const prompt = buildThreadTitleGenerationPrompt(input.prompt);
  if (!prompt) return null;
  const providers = yield* connection.request("providers.read", {});
  const selection = titleModelSelection(input, providers);
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (provider?.supportsTextGeneration === false) return null;
  const output = yield* connection.request("text.generate-structured", {
    cwd: input.cwd,
    prompt,
    modelSelection: lightUtilityModelSelection(selection, providers),
    outputSchema: CODEX_THREAD_TITLE_OUTPUT_SCHEMA,
    timeoutMs: CODEX_THREAD_TITLE_TIMEOUT_MS,
  });
  return parseGeneratedThreadMetadata(output)?.title ?? null;
});
