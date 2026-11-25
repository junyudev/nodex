import type { components } from "@nodex/core-protocol";
import type { CoreClient } from "../../../src/main/core-client/core-client";
import { createUuidV7 } from "../../../src/shared/uuid-v7";

export async function seedDecisionRun(
  client: Pick<CoreClient, "workspaceApply">,
  decision: components["schemas"]["NodexDecisionRunInput"],
  title: string,
) {
  const sessionId = createUuidV7();
  const { outcome } = await client.workspaceApply({
    operationId: createUuidV7(),
    intent: {
      kind: "create_agent_runtime_session",
      decision_run: decision,
      session_id: sessionId,
      project_id: null,
      title,
      initial_page_ids: [],
      runtime_id: "scenario:decisions",
      runtime_thread_id: createUuidV7(),
      launch_request_id: createUuidV7(),
    },
  });
  const [boundSessionId] = outcome.affected_session_ids;
  if (!boundSessionId) throw new Error("Core did not return the bound decision run");
  return boundSessionId;
}
