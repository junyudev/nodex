import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { isProviderInstanceId } from "@nodex/agent-runtime/contracts";
import type { AgentBackendBinding } from "../agent-backend.ts";
import { acpRegistryAgent } from "./acp-registry.ts";
import { antigravityAgent } from "./antigravity.ts";
import { claudeAgent } from "./claude.ts";
import { CODEX_BINDING } from "./codex.ts";
import { openCodeAgent } from "./opencode.ts";

const legacyDrivers = {
  claude: claudeAgent.driver,
  opencode: openCodeAgent.driver,
  antigravity: antigravityAgent.driver,
  acp: acpRegistryAgent.driver,
} as const;

export type LegacyAgentProfileKind = keyof typeof legacyDrivers;

/** For profile and saved-state migrations only. Existing Runtime IDs remain byte-for-byte stable. */
export function legacyAgentInstanceId(
  kind: LegacyAgentProfileKind | "acp_unconfigured",
  id: string,
): string {
  const digest = sha256(utf8ToBytes(JSON.stringify([kind, id])));
  const encoded = btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return `${kind}_${encoded}`;
}

export function decodeLegacyAgentBinding(value: unknown): AgentBackendBinding | null {
  if (!value || typeof value !== "object" || !("kind" in value)) return null;
  const { kind } = value;
  const explicit = "runtimeInstanceId" in value ? value.runtimeInstanceId : undefined;
  if (explicit !== undefined && !isProviderInstanceId(explicit)) return null;
  if (kind === CODEX_BINDING.driver)
    return { ...CODEX_BINDING, instanceId: explicit ?? CODEX_BINDING.instanceId };
  if (typeof kind !== "string" || !Object.hasOwn(legacyDrivers, kind)) return null;
  const legacyKind = kind as LegacyAgentProfileKind;
  const driver = legacyDrivers[legacyKind];
  if (explicit !== undefined) return { driver, instanceId: explicit };
  const configId = "instanceConfigId" in value ? value.instanceConfigId : undefined;
  if (typeof configId === "string" && configId && configId.trim() === configId)
    return { driver, instanceId: legacyAgentInstanceId(legacyKind, configId) };
  if (
    legacyKind !== "acp" ||
    !("agentDefinitionId" in value) ||
    typeof value.agentDefinitionId !== "string"
  )
    return null;
  return { driver, instanceId: legacyAgentInstanceId("acp_unconfigured", value.agentDefinitionId) };
}
