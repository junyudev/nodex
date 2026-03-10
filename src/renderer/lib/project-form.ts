import { normalizeProjectIcon } from "./project-icon";

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface ProjectIdentityFormValues {
  id: string;
  name: string;
}

export interface ProjectFormValues extends ProjectIdentityFormValues {
  icon: string;
  workspacePath: string;
}

export function sanitizeProjectIdInput(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

export function isValidProjectId(value: string): boolean {
  return PROJECT_ID_PATTERN.test(value);
}

export function validateProjectIdInput(value: string): string | undefined {
  const trimmedValue = value.trim();
  if (!trimmedValue) return "Project ID is required.";
  if (!isValidProjectId(trimmedValue)) {
    return "Project ID must be lowercase alphanumeric with hyphens.";
  }
  return undefined;
}

export function validateProjectNameInput(value: string): string | undefined {
  return value.trim() ? undefined : "Project name is required.";
}

export function resolveProjectIconValue(value: string): string | undefined {
  const normalized = normalizeProjectIcon(value);
  if (!normalized) return undefined;
  return normalized;
}
