import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CODEX_APP_SERVER_REQUIRED_ARTIFACTS,
  OFFICIAL_CODEX_MACOS_SIGNING_TEAM_ID,
  parseCodexAppServerReleaseLock,
  type AgentRuntimeBuild,
  type AgentRuntimeTargetArch,
  type AgentRuntimeTargetKey,
  type AgentRuntimeTargetPlatform,
  type CodexAppServerReleaseLock,
  type CodexSchemaToolAsset,
} from "../src/shared/codex-app-server-release-lock.mjs";

export {
  CODEX_APP_SERVER_REQUIRED_ARTIFACTS,
  OFFICIAL_CODEX_MACOS_SIGNING_TEAM_ID,
  parseCodexAppServerReleaseLock,
};
export type {
  AgentRuntimeBuild,
  AgentRuntimeTargetArch,
  AgentRuntimeTargetKey,
  AgentRuntimeTargetPlatform,
  CodexAppServerReleaseLock,
  CodexSchemaToolAsset,
};

export function readCodexAppServerReleaseLock(lockPath: string): CodexAppServerReleaseLock {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(lockPath, "utf8")) as unknown;
  } catch {
    throw new Error(`Invalid Codex app-server release lock at ${lockPath}`);
  }
  return parseCodexAppServerReleaseLock(value);
}

export function resolveCodexAppServerReleaseLockPath(projectRoot: string): string {
  return path.join(projectRoot, "resources", "agent-runtime", "codex-app-server.lock.json");
}
