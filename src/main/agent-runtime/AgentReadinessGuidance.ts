import { createIntl, createIntlCache } from "@formatjs/intl";
import { agentDefinition } from "../../shared/agents/registry";
import { agentReadiness, type AgentReadinessProvider } from "../../shared/agents/readiness";
import { agentReadinessTitle } from "../../shared/agents/readiness-messages";

const intl = createIntl({ locale: "en" }, createIntlCache());

/** Gives unattended work the same diagnosis without attempting any setup on a person's behalf. */
export function agentReadinessGuidance(
  provider: AgentReadinessProvider | undefined,
  otherwise?: "no-models" | "choose-model",
): string | undefined {
  if (!provider) return undefined;
  const definition = agentDefinition(provider.driver);
  const readiness = agentReadiness({
    definition,
    provider,
    ...(otherwise ? { installation: { problem: { kind: otherwise } } } : {}),
  });
  if (!readiness || readiness.problem.kind === "checking") return provider.unavailableReason;
  const { message, values } = agentReadinessTitle(
    provider.displayName ?? definition.label,
    readiness.problem,
  );
  const title = intl.formatMessage(message, values);
  const next =
    readiness.action?.kind === "components"
      ? "Open Settings → General → Add-ons."
      : readiness.action?.kind === "check-again"
        ? "Check the Agent again or choose another Agent."
        : "Check the Agent in Settings or choose another Agent.";
  const detail =
    readiness.detail && !title.includes(readiness.detail) ? ` ${readiness.detail}` : "";
  return `${title}${/[.!?…]$/u.test(title) ? "" : "."}${detail} ${next}`;
}
