import { sessionHandoffTools } from "./session-handoff-schemas";
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
import { sessionMessageTool } from "./session-message-schema";
import { automationTool } from "./automation-schema";
import { workbenchObservationToolCatalog } from "./workbench-observation-schemas";
import { workbenchControlToolCatalog } from "./workbench-control-schemas";
import { sessionPresentationToolCatalog } from "./session-presentation-schemas";

export const appToolCatalog: readonly Tool[] = [
  {
    name: "load_workspace_dependencies",
    description:
      "Read the verified bundled Node and Python executable paths, recommended Python arguments, and document library versions for creating and inspecting Word, PowerPoint, spreadsheet, PDF and image files. Returns unavailable when the managed bundle is absent or invalid; never substitutes system runtimes. Use the returned Python executable with -I -B to keep imports isolated and avoid bytecode writes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  ...contentToolCatalog,
  readSessionTerminalTool,
  ...accountToolCatalog,
  uninstallPluginTool,
  ...sessionHandoffTools,
  createSessionTool,
  sessionMessageTool,
  sessionForkTool,
  automationTool,
  ...sidebarToolCatalog,
  ...sessionToolCatalog,
  ...sessionObservationToolCatalog,
  ...workbenchObservationToolCatalog,
  ...workbenchControlToolCatalog,
  ...sessionPresentationToolCatalog,
  {
    name: "query_content",
    description:
      "Requires a task bound to a Project. Run complete-or-fail read-only SQL over content authorized by your calling Project's durable grants. Use describe_content_schema for relations. Temporary resource consent and Library scope do not expand this query. There is no SQL cursor; narrow large results with SQL.",
    inputSchema: queryContentInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "describe_content_schema",
    description:
      "Requires a task bound to a Project. Describe public content relations and bound Data Source columns within your calling Project's durable resource grants.",
    inputSchema: { ...describeContentInputSchema, type: "object" },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "list_projects",
    description:
      "List available Nodex Projects and their local workspace Git capabilities. Project discovery does not grant access to Page or Database content.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_app_capabilities",
    description: "Read the application tools available through this native MCP connection.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];
