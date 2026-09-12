import * as Effect from "effect/Effect";
import { CodexGitProbe } from "./CodexGitProbe";

export const makeTestCodexGitProbe = (
  isNonGitWorkspaceOnHost: CodexGitProbe["Service"]["isNonGitWorkspaceOnHost"] = () =>
    Effect.succeed(false),
): CodexGitProbe["Service"] =>
  CodexGitProbe.of({
    readPath: () => Effect.succeed(null),
    isNonGitWorkspace: () => Effect.succeed(false),
    isNonGitWorkspaceOnHost,
  });
