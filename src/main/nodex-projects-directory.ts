import { isAbsolute, join } from "node:path";
import type { MainConfigValue } from "./app/MainConfig";

/**
 * Where Nodex makes folders for work it was given none for: a Project created without a folder
 * and a chat started without a Project. A real Profile keeps them in the user's Documents/Nodex.
 * An isolated run, a development launcher home or a test harness, keeps them in its own home, so
 * nothing it creates lands in the user's real folders. `NODEX_PROJECTS_DIR` names the directory
 * for either.
 */
export function resolveNodexProjectsDirectory(
  config: Pick<
    MainConfigValue,
    "projectsDirectory" | "documentsPath" | "isolatedRunId" | "nodexHome"
  >,
): string {
  const configured = config.projectsDirectory?.trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("NODEX_PROJECTS_DIR must be an absolute path");
    return configured;
  }
  if (config.isolatedRunId !== null) {
    if (!isAbsolute(config.nodexHome)) throw new Error("An isolated run's home must be absolute");
    return join(config.nodexHome, "workspace");
  }
  if (!isAbsolute(config.documentsPath)) {
    throw new Error("Electron Documents directory must be absolute");
  }
  return join(config.documentsPath, "Nodex");
}
