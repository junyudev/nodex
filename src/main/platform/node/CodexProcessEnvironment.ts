import * as Effect from "effect/Effect";
import { codexRuntimeError } from "../../codex-runtime/CodexRuntimeError";

export const resolveCodexProcessEnvironment = (input: {
  readonly additionalSearchPaths: readonly string[];
  readonly pathDelimiter: string;
  readonly codexHome: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}) =>
  Effect.try({
    try: () => {
      const inheritedPath = input.environment.PATH ?? "";
      return {
        ...input.environment,
        CODEX_HOME: input.codexHome,
        PATH: [...input.additionalSearchPaths, inheritedPath]
          .filter(Boolean)
          .join(input.pathDelimiter),
      };
    },
    catch: (cause) =>
      codexRuntimeError({
        operation: "session.resolve-environment",
        reason: "spawn",
        retryable: false,
        hostId: "local",
        cause,
      }),
  });
