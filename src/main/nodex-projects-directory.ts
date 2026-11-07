import { isAbsolute, join } from "node:path";

/** Where Nodex makes a folder for a Project created without one. */
export function resolveNodexProjectsDirectory(input: {
  readonly configuredDirectory?: string | null;
  readonly documentsDirectory: string;
}): string {
  const configured = input.configuredDirectory?.trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("NODEX_PROJECTS_DIR must be an absolute path");
    return configured;
  }
  if (!isAbsolute(input.documentsDirectory)) {
    throw new Error("Electron Documents directory must be absolute");
  }
  return join(input.documentsDirectory, "Nodex");
}
