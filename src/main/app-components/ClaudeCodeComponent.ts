import type { ClaudeCodeReadiness } from "@nodex/agent-runtime/contracts";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import type { AppComponentState } from "../../shared/app-components";
import {
  appComponentDefinition,
  appComponentHome,
  type AppComponentTarget,
} from "./AppComponentCatalog";
import { appComponentRoot, appComponentRemovalMarker } from "./AppComponentStore";
import type { AppComponents } from "./AppComponents";

export const CLAUDE_CODE_INSTALLING = "Claude Code is still installing.";
const turnedOff = "Claude Code is turned off in Settings → General → Components.";

export function claudeCodeLocation(config: AppComponentTarget & { readonly nodexHome: string }) {
  const definition = appComponentDefinition(config, "claude-code");
  if (definition?.payload.kind !== "claude-code") return undefined;
  return {
    executable: join(
      appComponentRoot(appComponentHome(config), definition),
      definition.payload.executable.path,
    ),
    removalMarker: appComponentRemovalMarker(appComponentHome(config), definition.id),
  };
}

export function claudeCodeReadiness(component: AppComponentState | undefined): ClaudeCodeReadiness {
  if (component && !component.enabled) return { status: "turned-off", message: turnedOff } as const;
  if (component?.installation.status === "installed") return { status: "ready" } as const;
  if (component?.installation.status === "failed" && component.installation.retryAt === null) {
    return {
      status: "failed",
      message: `Claude Code could not be installed. ${component.installation.message}`,
    } as const;
  }
  return { status: "installing", message: CLAUDE_CODE_INSTALLING } as const;
}

/** A Turn can wait briefly for activation. The shared install continues if the Turn stops waiting. */
export const ensureClaudeCode = (components: AppComponents["Service"]) =>
  components.ensure("claude-code").pipe(
    Effect.timeoutOption("4 seconds"),
    Effect.map((result) => {
      if (result._tag === "None") return CLAUDE_CODE_INSTALLING;
      if (result.value.status === "installed") return null;
      return result.value.reason === "turned-off" ? turnedOff : result.value.message;
    }),
  );
