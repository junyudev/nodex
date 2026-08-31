import {
  TESTED_BROWSER_APP_SERVER_PAIRS as testedPairs,
  isTestedBrowserAppServerPair as isTestedPair,
  projectBundledAppServerRuntimeIdentity as projectRuntimeIdentity,
  projectBrowserPeerRuntimeIdentity as projectBrowserIdentity,
} from "./browser-app-server-compatibility.mjs";
import type { BundledAgentRuntimeMetadata } from "./codex-runtime-metadata";

type BrowserRuntimeCompatibilityMetadata = {
  browserPlugin: { version: string };
  runtimeVersions: { codexCli: string };
  targetArch: string;
  targetPlatform: string;
};

export type AppServerRuntimeIdentity = {
  entrypointSha256: string;
  protocolSchemaFingerprint: string;
  runtimeVersion: string;
  sourceCommit: string;
  targetArch: string;
  targetPlatform: string;
};

export type BrowserPeerRuntimeIdentity = {
  browserPluginVersion: string;
  manifestSha256: string;
  peerCliVersion: string;
  targetArch: string;
  targetPlatform: string;
};

export type TestedBrowserAppServerPair = {
  appServer: AppServerRuntimeIdentity;
  browser: BrowserPeerRuntimeIdentity;
};

export const TESTED_BROWSER_APP_SERVER_PAIRS = testedPairs as readonly TestedBrowserAppServerPair[];

export const projectBundledAppServerRuntimeIdentity = projectRuntimeIdentity as (
  metadata: BundledAgentRuntimeMetadata,
) => AppServerRuntimeIdentity;

export const projectBrowserPeerRuntimeIdentity = projectBrowserIdentity as (
  metadata: BrowserRuntimeCompatibilityMetadata,
  manifestSha256: string,
) => BrowserPeerRuntimeIdentity;

export function isTestedBrowserAppServerPair(
  appServer: AppServerRuntimeIdentity,
  browser: BrowserPeerRuntimeIdentity,
  pairs: readonly TestedBrowserAppServerPair[] = TESTED_BROWSER_APP_SERVER_PAIRS,
): boolean {
  return isTestedPair(appServer, browser, pairs);
}
