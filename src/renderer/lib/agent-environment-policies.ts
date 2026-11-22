import {
  AcpEnvironmentInputSchema,
  acpEnvironmentNameError,
} from "../../shared/acp-agent-settings";
import { AGENT_ENVIRONMENT_LIMIT } from "../../shared/agent-environment";
import type { AgentEnvironmentPolicy } from "./agent-environment-editor";

export const ACP_ENVIRONMENT_POLICY: AgentEnvironmentPolicy = {
  limit: AGENT_ENVIRONMENT_LIMIT,
  nameError: acpEnvironmentNameError,
  inputSchema: AcpEnvironmentInputSchema,
};
