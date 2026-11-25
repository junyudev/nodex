import type { ProviderInstanceEnvironment } from "@nodex/runtime-contracts";
import * as HostProcess from "@nodex/runtime-shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomePath } from "./pathExpansion.ts";

/**
 * Host variables that choose, configure or authenticate a provider. An isolated instance runs on
 * the credentials and homes its declaration names, so it never inherits these from the host.
 */
const HOST_PROVIDER_VARIABLE =
  /^(?:OPENAI_|ANTHROPIC_|AZURE_OPENAI_|CODEX_|CLAUDE_)|^(?:CLAUDECODE|NODEX_GATEWAY_API_KEY|NODEX_CODEX_LAUNCH_ARGS)$/iu;

export const isHostProviderVariable = (name: string): boolean => HOST_PROVIDER_VARIABLE.test(name);

/**
 * The environment an instance's processes run in: the host's, without the host's own provider
 * variables when the instance is isolated, then the variables its declaration owns. A declaration
 * never carries the host environment, so every host variable the platform allows reaches the
 * instance's tools unchanged, such as Windows' `ProgramFiles(x86)`.
 */
export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  options: { readonly isolated?: boolean | undefined; readonly host?: NodeJS.ProcessEnv } = {},
) {
  const host = options.host ?? (yield* HostProcess.Environment);
  const platform = yield* HostProcess.Platform;
  const inherited = options.isolated
    ? Object.fromEntries(Object.entries(host).filter(([name]) => !isHostProviderVariable(name)))
    : host;
  if (!environment?.length) return HostProcess.mergeProcessEnvironments(platform, inherited);
  const home = yield* HostProcess.HomeDirectory;
  const declared = environment.map(({ name, value }) => {
    // Child processes do not apply shell expansion to environment values.
    const key = platform === "win32" ? name.toUpperCase() : name;
    return {
      [name]: key === "CODEX_HOME" || key === "CLAUDE_CONFIG_DIR" ? expandHomePath(value, home) : value,
    };
  });
  return HostProcess.mergeProcessEnvironments(platform, inherited, ...declared);
});
