import type {
  AcpAgentInstanceConfig,
  AcpAgentInstanceInput,
} from "../../../shared/acp-agent-settings";
import {
  environmentDraftInput,
  validateEnvironmentDraft,
  type AgentEnvironmentDraft,
} from "../../lib/agent-environment-editor";
import { ACP_ENVIRONMENT_POLICY } from "../../lib/agent-environment-policies";
import {
  acpInstanceInput,
  parseAcpCustomModels,
  type AcpDistributionChoice,
} from "./acp-agent-model";

/** One launch argument, kept verbatim: empty strings and embedded newlines are values too. */
export interface AcpArgumentDraft {
  readonly id: string;
  readonly value: string;
}

export const acpArgumentDrafts = (
  args: readonly string[],
  createId: () => string = () => crypto.randomUUID(),
): AcpArgumentDraft[] => args.map((value) => ({ id: createId(), value }));

/** The editable part of a saved instance; identity, Agent and account storage stay fixed. */
export interface AcpAgentDraft {
  readonly displayName: string;
  readonly executable: string;
  readonly arguments: readonly AcpArgumentDraft[];
  readonly distribution: AcpDistributionChoice;
  readonly executableOverride: string;
  readonly customModelsText: string;
  readonly proxy: AcpAgentInstanceConfig["proxy"];
  readonly environment: readonly AgentEnvironmentDraft[];
}

export function acpAgentDraft(
  instance: AcpAgentInstanceConfig,
  createId: () => string = () => crypto.randomUUID(),
): AcpAgentDraft {
  const source = instance.source;
  return {
    displayName: instance.displayName,
    executable: source.kind === "local" ? source.executable : "",
    arguments: source.kind === "local" ? acpArgumentDrafts(source.args, createId) : [],
    distribution: source.kind === "registry" ? source.distribution : "auto",
    executableOverride: source.kind === "registry" ? (source.executableOverride ?? "") : "",
    customModelsText: instance.customModels.join("\n"),
    proxy: instance.proxy,
    environment: instance.environment.map((variable) => ({ ...variable, id: createId() })),
  };
}

/**
 * The draft applied to an instance as saved; fields the editor doesn't own (such as a pinned
 * installation saved meanwhile) come from `saved`. Choosing another distribution releases the
 * pinned installation, which belongs to the previous one, so the Agent installs again.
 */
export function acpDraftInput(
  saved: AcpAgentInstanceInput,
  draft: AcpAgentDraft,
): AcpAgentInstanceInput {
  const source = saved.source;
  const override = draft.executableOverride.trim();
  return {
    ...saved,
    displayName: draft.displayName.trim(),
    source:
      source.kind === "local"
        ? {
            kind: "local",
            executable: draft.executable.trim(),
            args: draft.arguments.map(({ value }) => value),
          }
        : {
            kind: "registry",
            agentId: source.agentId,
            distribution: draft.distribution,
            ...(source.installationId && draft.distribution === source.distribution
              ? { installationId: source.installationId }
              : {}),
            ...(override ? { executableOverride: override } : {}),
          },
    customModels: parseAcpCustomModels(draft.customModelsText),
    proxy: draft.proxy,
    environment: environmentDraftInput(draft.environment, ACP_ENVIRONMENT_POLICY),
  };
}

export const acpDraftChanged = (instance: AcpAgentInstanceConfig, draft: AcpAgentDraft) => {
  const saved = acpInstanceInput(instance);
  return JSON.stringify(acpDraftInput(saved, draft)) !== JSON.stringify(saved);
};

/** The first reason the draft cannot be saved, phrased for the field that owns it. */
export function acpDraftError(
  instance: AcpAgentInstanceConfig,
  draft: AcpAgentDraft,
): string | null {
  if (!draft.displayName.trim()) return "Enter a name.";
  if (instance.source.kind === "local" && !draft.executable.trim())
    return "Enter the executable to run.";
  return validateEnvironmentDraft(draft.environment, ACP_ENVIRONMENT_POLICY);
}

/** Adds secret rows for variables the Agent asked for, keeping rows that already name them. */
export function withAcpVariables(
  rows: readonly AgentEnvironmentDraft[],
  names: readonly string[],
  createId: () => string = () => crypto.randomUUID(),
): AgentEnvironmentDraft[] {
  const present = new Set(rows.map((row) => row.name.trim()));
  return [
    ...rows,
    ...names
      .filter((name) => !present.has(name))
      .map((name) => ({ id: createId(), name, value: "", sensitive: true })),
  ];
}
