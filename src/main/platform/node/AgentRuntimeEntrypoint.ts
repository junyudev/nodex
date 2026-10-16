import { isAbsolute, join } from "node:path";

/** Standalone Node cannot read an Electron ASAR; the execution closure is unpacked. */
export const agentRuntimeEntrypoint = (input: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly projectRootPath: string;
}) =>
  join(
    input.isPackaged ? join(input.resourcesPath, "app.asar.unpacked") : input.projectRootPath,
    "out/agent-runtime/entry.mjs",
  );

/** Disposable scenarios may select their own Node; packaged execution always uses verified assets. */
export function agentRuntimeNodeExecutable(input: {
  readonly isPackaged: boolean;
  readonly bundledExecutable: string | null;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): string {
  const override = input.environment.NODEX_TEST_AGENT_RUNTIME_NODE_EXECUTABLE?.trim();
  if (
    !input.isPackaged &&
    input.environment.NODE_ENV === "test" &&
    input.environment.NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT?.trim() &&
    override
  ) {
    if (!isAbsolute(override))
      throw new Error("Scenario Agent Runtime Node must be an absolute executable path");
    return override;
  }
  if (input.bundledExecutable) return input.bundledExecutable;
  throw new Error("The verified Node execution runtime is unavailable");
}
