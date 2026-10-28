export const AUTOMATIONS_ROOT_PATH = "/automations";

/** The task dialog open over the Scheduled main pane. */
export type WorkbenchAutomationMode = "create" | "edit";

/**
 * Scheduled route state. `automationId` selects a task; `automationMode` opens the create or
 * edit dialog, and `templateId` seeds a new task; `runSessionId` presents a
 * run or Heartbeat chat in place.
 */
export interface WorkbenchAutomationsRouteState {
  automationId: string | null;
  automationMode: WorkbenchAutomationMode | null;
  templateId: string | null;
  runSessionId: string | null;
}

export interface BuildAutomationsPathInput {
  automationId?: string | null;
  automationMode?: WorkbenchAutomationMode | null;
  templateId?: string | null;
  runSessionId?: string | null;
}

function normalizeId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeAutomationMode(value: string | null | undefined): WorkbenchAutomationMode | null {
  return value === "create" || value === "edit" ? value : null;
}

export function buildAutomationsPath(input: BuildAutomationsPathInput = {}): string {
  const searchParams = new URLSearchParams();
  const automationId = normalizeId(input.automationId);
  const automationMode = normalizeAutomationMode(input.automationMode);
  const runSessionId = normalizeId(input.runSessionId);

  if (automationId) searchParams.set("automationId", automationId);
  // Editing needs a task to edit.
  if (automationMode === "create" || (automationMode === "edit" && automationId)) {
    searchParams.set("automationMode", automationMode);
  }
  // Only a new task starts from a template.
  const templateId = automationMode === "create" ? normalizeId(input.templateId) : null;
  if (templateId) searchParams.set("templateId", templateId);
  if (runSessionId) searchParams.set("runSessionId", runSessionId);

  const query = searchParams.toString();
  return query ? `${AUTOMATIONS_ROOT_PATH}?${query}` : AUTOMATIONS_ROOT_PATH;
}

export function resolveAutomationsRouteState(path: string): WorkbenchAutomationsRouteState {
  const queryStart = path.indexOf("?");
  const query = queryStart >= 0 ? path.slice(queryStart + 1) : "";
  const searchParams = new URLSearchParams(query);
  const automationId = normalizeId(searchParams.get("automationId"));
  const automationMode = normalizeAutomationMode(searchParams.get("automationMode"));
  const mode = automationMode === "edit" && automationId === null ? null : automationMode;
  return {
    automationId,
    automationMode: mode,
    templateId: mode === "create" ? normalizeId(searchParams.get("templateId")) : null,
    runSessionId: normalizeId(searchParams.get("runSessionId")),
  };
}
