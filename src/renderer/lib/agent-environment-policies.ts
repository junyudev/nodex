import {
  AcpEnvironmentInputSchema,
  acpEnvironmentNameError,
} from "../../shared/acp-agent-settings";
import { AGENT_ENVIRONMENT_LIMIT } from "../../shared/agent-environment";
import {
  CLAUDE_ENVIRONMENT_LIMIT,
  ClaudeEnvironmentInputSchema,
  claudeEnvironmentNameError,
} from "../../shared/claude-agent-settings";
import {
  OPENCODE_ENVIRONMENT_LIMIT,
  OpenCodeEnvironmentInputSchema,
  openCodeEnvironmentNameError,
} from "../../shared/opencode-agent-settings";
import type { AgentEnvironmentPolicy } from "./agent-environment-editor";

export const CLAUDE_ENVIRONMENT_POLICY: AgentEnvironmentPolicy = {
  limit: CLAUDE_ENVIRONMENT_LIMIT,
  nameError: claudeEnvironmentNameError,
  inputSchema: ClaudeEnvironmentInputSchema,
};

export const OPENCODE_ENVIRONMENT_POLICY: AgentEnvironmentPolicy = {
  limit: OPENCODE_ENVIRONMENT_LIMIT,
  nameError: openCodeEnvironmentNameError,
  inputSchema: OpenCodeEnvironmentInputSchema,
};

export const ACP_ENVIRONMENT_POLICY: AgentEnvironmentPolicy = {
  limit: AGENT_ENVIRONMENT_LIMIT,
  nameError: acpEnvironmentNameError,
  inputSchema: AcpEnvironmentInputSchema,
};
