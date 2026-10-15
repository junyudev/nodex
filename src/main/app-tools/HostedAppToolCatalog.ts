import { appToolCatalog } from "../../shared/nodex-app-tools/catalog";
import { isContentTool } from "../../shared/nodex-app-tools/content-catalog";
import { sidebarSchemas } from "../../shared/nodex-app-tools/sidebar-schemas";
import { sessionSchemas } from "../../shared/nodex-app-tools/session-schemas";
import { sessionObservationSchemas } from "../../shared/nodex-app-tools/session-observation-schemas";

const commonNames = new Set([
  "load_workspace_dependencies",
  "query_content",
  "describe_content_schema",
  "list_projects",
  "get_app_capabilities",
  "send_message_to_session",
  "send_to_inbox",
  "automation_update",
  "read_session_terminal",
]);

export const nativeAppToolCatalog = appToolCatalog.filter(
  (tool) =>
    commonNames.has(tool.name) ||
    isContentTool(tool.name) ||
    Object.hasOwn(sidebarSchemas, tool.name) ||
    Object.hasOwn(sessionSchemas, tool.name) ||
    Object.hasOwn(sessionObservationSchemas, tool.name),
);
const nativeNames = new Set(nativeAppToolCatalog.map((tool) => tool.name));
export const isNativeAppTool = (name: string): boolean => nativeNames.has(name);
