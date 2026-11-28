import { join } from "node:path";
import type { AppComponentId } from "../../shared/app-components";
import { codexDefinition } from "./definitions/codex";
import { claudeCodeDefinition } from "./definitions/claude-code";
import { documentToolsDefinition } from "./definitions/document-tools";
import { desktopToolsDefinition } from "./definitions/desktop-tools";

/** One sealed archive, pinned by the release lock this build was made from. */
export interface AppComponentArchive {
  readonly assetName: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
}

/** How an unpacked archive is checked and laid out before it is published. */
export type AppComponentPayload =
  /** The Desktop Tools closure under `browser-runtime/`, bound to its manifest digest. */
  | { readonly kind: "desktop-tools"; readonly manifestSha256: string }
  | { readonly kind: "codex"; readonly metadataSha256: string; readonly entrypointSha256: string }
  /** One executable at `executable.path` inside the published root. */
  | {
      readonly kind: "claude-code";
      readonly executable: {
        readonly path: string;
        readonly size: number;
        readonly sha256: string;
      };
    }
  /** The managed Python closure, bound to its manifest digest. */
  | { readonly kind: "document-tools"; readonly manifestSha256: string };

export interface AppComponentDefinition {
  readonly id: AppComponentId;
  readonly archive: AppComponentArchive;
  readonly unpackedBytes: number;
  /**
   * `at-startup` installs in the background whenever it is turned on and missing. `on-first-use`
   * waits until a feature asks for it, then stays installed, including across updates.
   */
  readonly install: "at-startup" | "on-first-use";
  readonly payload: AppComponentPayload;
}

export interface AppComponentTarget {
  readonly platform: string;
  readonly arch: string;
  readonly isPackaged: boolean;
  readonly headless?: boolean;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export type AppComponentTargetKey = "darwin-arm64" | "win32-arm64" | "win32-x64";

export function appComponentTargetKey(target: AppComponentTarget): AppComponentTargetKey | null {
  const key = `${target.platform}-${target.arch}`;
  return key === "darwin-arm64" || key === "win32-arm64" || key === "win32-x64" ? key : null;
}

/** Components this build offers for installation after the app. */
export function appComponentCatalog(target: AppComponentTarget): readonly AppComponentDefinition[] {
  const key = appComponentTargetKey(target);
  if (!key) return [];
  const optIn =
    target.environment?.NODE_ENV === "test"
      ? "NODEX_TEST_APP_COMPONENTS"
      : "NODEX_DEV_APP_COMPONENTS";
  if (!target.isPackaged && target.environment?.[optIn] !== "1") return [];
  const documentTools = documentToolsDefinition(key);
  return [
    ...(target.headless ? [] : [desktopToolsDefinition(key)]),
    codexDefinition(key),
    claudeCodeDefinition(key),
    ...(documentTools ? [documentTools] : []),
  ];
}

export const appComponentDefinition = (
  target: AppComponentTarget,
  id: AppComponentId,
): AppComponentDefinition | null =>
  appComponentCatalog(target).find((component) => component.id === id) ?? null;

/** Serve and Desktop own separate stores even when given the same execution directory. */
export function appComponentHome(config: {
  readonly nodexHome: string;
  readonly headless?: boolean;
}) {
  return config.headless ? join(config.nodexHome, "runtime", "host") : config.nodexHome;
}
