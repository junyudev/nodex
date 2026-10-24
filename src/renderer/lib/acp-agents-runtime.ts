import type { AcpOperations, AcpResult } from "../../shared/acp-api";
import type {
  AcpAgentConfigurationStatus,
  AcpAgentSettings,
  AcpAgentSettingsUpdateResult,
  UpdateAcpAgentSettingsInput,
} from "../../shared/acp-agent-settings";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { agentRuntimeRuntime } from "./agent-runtime-runtime";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";
import { readAcpAgentSettings, updateAcpAgentSettings } from "./workbench-settings-runtime";

type Input<Method extends keyof AcpOperations> = AcpOperations[Method]["input"];
type Output<Method extends keyof AcpOperations> = AcpResult<AcpOperations[Method]["output"]>;

const command = <
  const Key extends string,
  const Channel extends Parameters<typeof invokePlainCommand>[0]["channel"],
>(
  key: Key,
  channel: Channel,
) =>
  defineRendererCommand({
    key,
    channel,
    authority: "external",
    owner: "AcpAgents",
    protocol: { kind: "returned_value" },
  });

const installStart = command("acp_agents.install.start", "acp:install:start");
const uninstall = command("acp_agents.registry.uninstall", "acp:registry:uninstall");
const connectionStart = command("acp_agents.connection.start", "acp:connection:start");
const operationCancel = command("acp_agents.operation.cancel", "acp:operation:cancel");
const authStart = command("acp_agents.auth.start", "acp:auth:start");
const authRespond = command("acp_agents.auth.respond", "acp:auth:respond");
const authCancel = command("acp_agents.auth.cancel", "acp:auth:cancel");
const authLogout = command("acp_agents.auth.logout", "acp:auth:logout");
const urlAuthAccept = command("acp_agents.url_auth.accept", "acp:urlAuth:accept");
const sessionsImport = command("acp_agents.sessions.import", "acp:sessions:import");
const sessionsDelete = command("acp_agents.sessions.delete", "acp:sessions:delete");
const modelProvidersSet = command("acp_agents.model_providers.set", "acp:modelProviders:set");
const modelProvidersDisable = command(
  "acp_agents.model_providers.disable",
  "acp:modelProviders:disable",
);

/**
 * ACP management crosses Main, which owns Profile settings, window ownership and project
 * directories. Inputs name settings instances; Main resolves Runtime identities. Expected domain
 * refusals arrive as typed failures; only transport and programming errors reject.
 */
export interface AcpAgentsRuntime {
  readonly readSettings: () => Promise<AcpAgentSettings>;
  readonly updateSettings: (
    input: UpdateAcpAgentSettingsInput,
  ) => Promise<AcpAgentSettingsUpdateResult>;
  /** Whether saved settings reached the Runtime; never starts it or an Agent. */
  readonly readConfigurationStatus: () => Promise<AcpAgentConfigurationStatus>;
  /** Runtime provider snapshots Nodex already holds; never starts an Agent. */
  readonly knownProviders: () => Promise<AgentRuntimeOperations["providers.read"]["output"] | null>;
  readonly search: (input: Input<"acp.registry.search">) => Promise<Output<"acp.registry.search">>;
  readonly inspect: (input: Input<"acp.inspect">) => Promise<Output<"acp.inspect">>;
  readonly previewInstall: (
    input: Input<"acp.install.preview">,
  ) => Promise<Output<"acp.install.preview">>;
  readonly install: (input: Input<"acp.install.start">) => Promise<Output<"acp.install.start">>;
  readonly uninstall: (
    input: Input<"acp.registry.uninstall">,
  ) => Promise<Output<"acp.registry.uninstall">>;
  readonly connect: (
    input: Input<"acp.connection.start">,
  ) => Promise<Output<"acp.connection.start">>;
  readonly readOperation: (
    input: Input<"acp.operation.read">,
  ) => Promise<Output<"acp.operation.read">>;
  readonly cancelOperation: (
    input: Input<"acp.operation.cancel">,
  ) => Promise<Output<"acp.operation.cancel">>;
  readonly readAuth: (input: Input<"acp.auth.read">) => Promise<Output<"acp.auth.read">>;
  readonly startAuth: (input: Input<"acp.auth.start">) => Promise<Output<"acp.auth.start">>;
  readonly respondAuth: (input: Input<"acp.auth.respond">) => Promise<Output<"acp.auth.respond">>;
  readonly cancelAuth: (input: Input<"acp.auth.cancel">) => Promise<Output<"acp.auth.cancel">>;
  readonly logout: (input: Input<"acp.auth.logout">) => Promise<Output<"acp.auth.logout">>;
  readonly acceptUrlAuth: (
    input: Input<"acp.urlAuth.accept">,
  ) => Promise<Output<"acp.urlAuth.accept">>;
  readonly listSessions: (
    input: Input<"acp.sessions.list">,
  ) => Promise<Output<"acp.sessions.list">>;
  readonly prepareImport: (
    input: Input<"acp.sessions.prepareImport">,
  ) => Promise<Output<"acp.sessions.prepareImport">>;
  readonly importSession: (
    input: Input<"acp.sessions.import">,
  ) => Promise<Output<"acp.sessions.import">>;
  readonly deleteSession: (
    input: Input<"acp.sessions.delete">,
  ) => Promise<Output<"acp.sessions.delete">>;
  readonly listModelProviders: (
    input: Input<"acp.modelProviders.list">,
  ) => Promise<Output<"acp.modelProviders.list">>;
  readonly setModelProvider: (
    input: Input<"acp.modelProviders.set">,
  ) => Promise<Output<"acp.modelProviders.set">>;
  readonly disableModelProvider: (
    input: Input<"acp.modelProviders.disable">,
  ) => Promise<Output<"acp.modelProviders.disable">>;
}

export const acpAgentsRuntime: AcpAgentsRuntime = {
  readSettings: readAcpAgentSettings,
  updateSettings: updateAcpAgentSettings,
  readConfigurationStatus: () => invokeRendererQuery("settings:acp-agents:configuration-status"),
  knownProviders: agentRuntimeRuntime.knownCatalog,
  search: (input) => invokeRendererQuery("acp:registry:search", input),
  inspect: (input) => invokeRendererQuery("acp:inspect", input),
  previewInstall: (input) => invokeRendererQuery("acp:install:preview", input),
  install: (input) => invokePlainCommand(installStart, input),
  uninstall: (input) => invokePlainCommand(uninstall, input),
  connect: (input) => invokePlainCommand(connectionStart, input),
  readOperation: (input) => invokeRendererQuery("acp:operation:read", input),
  cancelOperation: (input) => invokePlainCommand(operationCancel, input),
  readAuth: (input) => invokeRendererQuery("acp:auth:read", input),
  startAuth: (input) => invokePlainCommand(authStart, input),
  respondAuth: (input) => invokePlainCommand(authRespond, input),
  cancelAuth: (input) => invokePlainCommand(authCancel, input),
  logout: (input) => invokePlainCommand(authLogout, input),
  acceptUrlAuth: (input) => invokePlainCommand(urlAuthAccept, input),
  listSessions: (input) => invokeRendererQuery("acp:sessions:list", input),
  prepareImport: (input) => invokeRendererQuery("acp:sessions:prepareImport", input),
  importSession: (input) => invokePlainCommand(sessionsImport, input),
  deleteSession: (input) => invokePlainCommand(sessionsDelete, input),
  listModelProviders: (input) => invokeRendererQuery("acp:modelProviders:list", input),
  setModelProvider: (input) => invokePlainCommand(modelProvidersSet, input),
  disableModelProvider: (input) => invokePlainCommand(modelProvidersDisable, input),
};
