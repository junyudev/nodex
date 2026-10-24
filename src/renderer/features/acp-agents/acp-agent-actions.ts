import type { AcpAgentInstanceConfig } from "../../../shared/acp-agent-settings";
import { acpFailureText } from "./acp-agent-model";
import type { AcpAgentsOwner } from "./acp-agents-owner";

/**
 * Installs the Registry version the user saw. The cached preview binds the request to that
 * exact build, so a catalog that moved meanwhile is reported instead of silently installed.
 * Returns why nothing started, or null once installation is under way.
 */
export async function installReviewedVersion(
  owner: AcpAgentsOwner,
  instance: AcpAgentInstanceConfig,
  expectedVersion: string | null,
): Promise<string | null> {
  const source = instance.source;
  if (source.kind !== "registry") return null;
  const preview = await owner.previewInstall(source.agentId, source.distribution);
  if (!preview.ok) return acpFailureText(preview.error, "install");
  if (expectedVersion && preview.value.version !== expectedVersion)
    return `The Registry now offers v${preview.value.version}. Check again.`;
  owner.install(
    instance.id,
    {
      agentId: source.agentId,
      distribution: source.distribution,
      expectedInstallationId: preview.value.installationId,
    },
    "connect",
  );
  return null;
}
