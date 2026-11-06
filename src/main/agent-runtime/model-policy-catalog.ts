import { managedNodexAccountId } from "../nodex-account/managed-providers";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { NodexAccountIdentity } from "../../shared/nodex-account";
import { NODEX_MODELS } from "../../shared/nodex-models";
import { projectModelPolicyCatalog, type ModelPolicy } from "../../shared/model-policy";

type Providers = AgentRuntimeOperations["providers.read"]["output"];
/** Account metadata supplies Settings inventory even when no managed execution instance exists. */
export function modelPolicyCatalog(
  providers: Providers,
  policy: ModelPolicy,
  identity: NodexAccountIdentity | null,
): Providers {
  const additions: Providers[number][] = [];
  if (identity) {
    const account = managedNodexAccountId(identity);
    for (const [kind, driver, protocol] of [
      ["codex", "codex", "openai"],
      ["claude", "claudeAgent", "anthropic"],
    ] as const) {
      const instanceId = `nodex_${kind}_${account}`;
      if (providers.some((provider) => provider.instanceId === instanceId)) continue;
      additions.push({
        instanceId,
        driver,
        source: "nodex",
        displayName: "Nodex",
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: providers[0]?.checkedAt ?? "1970-01-01T00:00:00.000Z",
        slashCommands: [],
        skills: [],
        models: NODEX_MODELS.filter((model) => model.protocol === protocol).map((model) => ({
          slug: model.id,
          name: model.label,
          isCustom: false,
          capabilities: null,
        })),
      });
    }
  }
  return projectModelPolicyCatalog([...providers, ...additions], policy);
}
