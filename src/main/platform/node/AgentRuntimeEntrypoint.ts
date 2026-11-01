import type { NodeExecutionRuntime } from "./NodeExecutionRuntime";
import { isAbsolute, join } from "node:path";

/** The dev launcher supplies this opt-in only for a home with a scripted seed receipt. */
export const scenarioAgentRuntimeProjectRoot = (input: {
  readonly isPackaged: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): string | undefined => {
  if (input.isPackaged) return undefined;
  return (
    (input.environment.NODE_ENV === "test"
      ? input.environment.NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT
      : input.environment.NODEX_DEV_AGENT_RUNTIME_PROJECT_ROOT
    )?.trim() || undefined
  );
};

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
  readonly nodeRuntime: NodeExecutionRuntime;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): string {
  const override = (
    input.environment.NODE_ENV === "test"
      ? input.environment.NODEX_TEST_AGENT_RUNTIME_NODE_EXECUTABLE
      : input.environment.NODEX_DEV_AGENT_RUNTIME_NODE_EXECUTABLE
  )?.trim();
  if (scenarioAgentRuntimeProjectRoot(input) && override) {
    if (!isAbsolute(override))
      throw new Error("Scenario Agent Runtime Node must be an absolute executable path");
    return override;
  }
  if (input.nodeRuntime.status === "available") return input.nodeRuntime.executable;
  throw new Error("The verified Node execution runtime is unavailable");
}
