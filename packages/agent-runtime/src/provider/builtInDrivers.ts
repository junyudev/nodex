/**
 * The provider drivers Nodex ships: Codex, Claude, OpenCode and ACP registry agents.
 * The `ProviderInstanceRegistry` resolves `providerInstances` entries against
 * this list; any other driver surfaces as an `"unavailable"` shadow snapshot.
 *
 * @module provider/builtInDrivers
 */
import {
  AcpRegistryDriver,
  type AcpRegistryDriverEnv,
} from "@t3tools/provider-acp-registry/server";
import { ClaudeDriver, type ClaudeDriverEnv } from "./Drivers/ClaudeDriver.ts";
import { CodexDriver, type CodexDriverEnv } from "./Drivers/CodexDriver.ts";
import { OpenCodeDriver, type OpenCodeDriverEnv } from "@t3tools/provider-opencode/server";
import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";

/** Infrastructure services required to construct any built-in driver. */
export type BuiltInDriversEnv =
  | AcpRegistryDriverEnv
  | ClaudeDriverEnv
  | CodexDriverEnv
  | OpenCodeDriverEnv;

/** Ordered for presentation; the registry is keyed by `driverKind`. */
export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  CodexDriver,
  ClaudeDriver,
  OpenCodeDriver,
  AcpRegistryDriver,
];
