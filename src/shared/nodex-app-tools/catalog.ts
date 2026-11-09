import { replyToOriginTool } from "./coordinator-schema";
import { sessionQuestionTool } from "./session-question-schema";
import { sessionControlToolCatalog } from "./session-control-schemas";
import { sessionHandoffTool, handoffStatusTool } from "./session-handoff-schemas";
import { contentToolCatalog } from "./content-catalog";
import { readSessionTerminalTool } from "./terminal-schema";
import { accountToolCatalog } from "./account-schemas";
import { uninstallPluginTool } from "./plugin-schema";
import { queryContentInputSchema, describeContentInputSchema } from "./query-schemas";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { sidebarToolCatalog } from "./sidebar-schemas";
import { sessionToolCatalog } from "./session-schemas";
import { sessionObservationToolCatalog } from "./session-observation-schemas";
import { createSessionTool } from "./session-launch-schema";
import { sessionForkTool } from "./session-fork-schema";
import { sessionMergeTool } from "./session-merge-schema";
import { sessionMessageTool } from "./session-message-schema";
import { coordinatorToolCatalog } from "./coordinator-schema";
import {
  reportWorkTool,
  startWorkTool,
  handBackMessageTool,
  followThreadTool,
} from "./work-schema";
import { sendToInboxTool } from "./inbox-schema";
import { automationTool } from "./automation-schema";
import { workbenchObservationToolCatalog } from "./workbench-observation-schemas";
import { workbenchControlToolCatalog } from "./workbench-control-schemas";
import { sessionPresentationToolCatalog } from "./session-presentation-schemas";

/** Each advertised group has one semantic executor at the Runtime Host boundary. */
export const appToolGroups = {
  dependencies: [
    {
      name: "load_workspace_dependencies",
      description:
        "Read the verified bundled Node and Python executable paths, recommended Python arguments, and document library versions for creating and inspecting Word, PowerPoint, spreadsheet, PDF and image files. Returns unavailable when the managed bundle is absent or invalid; never substitutes system runtimes. Use the returned Python executable with -I -B to keep imports isolated and avoid bytecode writes.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
  ],
  content: contentToolCatalog,
  terminal: [readSessionTerminalTool],
  account: accountToolCatalog,
  plugin: [uninstallPluginTool],
  handoff: [sessionHandoffTool],
  handoffStatus: [handoffStatusTool],
  sessionCommands: [
    createSessionTool,
    sessionMessageTool,
    sessionQuestionTool,
    sessionForkTool,
    sessionMergeTool,
  ],
  inbox: [sendToInboxTool],
  work: [reportWorkTool, startWorkTool],
  followThread: [followThreadTool],
  messageHandback: [handBackMessageTool],
  coordinator: [replyToOriginTool, ...coordinatorToolCatalog],
  automations: [automationTool],
  workspace: [...sidebarToolCatalog, ...sessionToolCatalog],
  sessionControls: sessionControlToolCatalog,
  session: sessionObservationToolCatalog,
  workbench: [
    ...workbenchObservationToolCatalog,
    ...workbenchControlToolCatalog,
    ...sessionPresentationToolCatalog,
  ],
  query: [
    {
      name: "query_content",
      description:
        "Run complete-or-fail read-only SQL over the current Profile's Library content. Use describe_content_schema for relations and explicit filters for a selected Project. There is no SQL cursor; narrow large results with SQL.",
      inputSchema: queryContentInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "describe_content_schema",
      description:
        "Describe public content relations and bound Data Source columns in the current Profile's Library.",
      inputSchema: describeContentInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
  ],
  basic: [
    {
      name: "list_projects",
      description: "List Nodex Projects and their local workspace Git capabilities.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "get_app_capabilities",
      description: "Read the application tools available through this native MCP connection.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
  ],
} as const satisfies Record<string, readonly Tool[]>;

export const appToolCatalog: readonly Tool[] = Object.values(appToolGroups).flat();
