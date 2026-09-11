import {
  responses,
  type ScriptedModelExchange,
} from "../../../scripts/scenarios/runtime/scripted-model-server";

/** Title generation runs alongside the tested user Turn and must not consume its responses. */
export const workbenchScriptedTitle: ScriptedModelExchange = {
  name: "automatic task title",
  expectedCalls: 1,
  maximumCalls: 1,
  match: (request) => request.hasUserInputText("Generate a concise UI title"),
  respond: responses.stream([
    responses.created("workbench_title"),
    responses.assistantMessage(
      "workbench_title_answer",
      '{"title":"Workbench verification"}',
      "final_answer",
    ),
    responses.completed("workbench_title", true),
  ]),
};
