import { mkdirSync } from "fs";
import { join, resolve } from "path";
import type { App } from "electron";

interface InstanceScopePaths {
  userDataPath: string;
  sessionDataPath: string;
}

const USER_DATA_DIR_NAME = "electron-user-data";
const SESSION_DATA_DIR_NAME = "electron-session-data";

export function resolveInstanceScopePaths(kanbanDir: string): InstanceScopePaths {
  const scopeRoot = resolve(kanbanDir);
  return {
    userDataPath: join(scopeRoot, USER_DATA_DIR_NAME),
    sessionDataPath: join(scopeRoot, SESSION_DATA_DIR_NAME),
  };
}

export function configureInstanceScopePaths(
  electronApp: Pick<App, "setPath">,
  kanbanDir: string,
): InstanceScopePaths {
  const scopedPaths = resolveInstanceScopePaths(kanbanDir);

  mkdirSync(scopedPaths.userDataPath, { recursive: true });
  mkdirSync(scopedPaths.sessionDataPath, { recursive: true });

  electronApp.setPath("userData", scopedPaths.userDataPath);
  electronApp.setPath("sessionData", scopedPaths.sessionDataPath);

  return scopedPaths;
}
