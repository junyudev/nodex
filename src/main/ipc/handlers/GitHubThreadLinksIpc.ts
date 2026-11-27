import * as Effect from "effect/Effect";
import { gitHubThreadRefSchema, type GitHubThreadLinks } from "../../../shared/github-thread";
import type { CoreModuleClients } from "../../core-runtime/CoreModules";
import type { ElectronIpc } from "../../platform/electron/ElectronIpc";

/** Both window types supply the Core connection bound to their Space. */
export const registerGitHubThreadLinksQuery = (
  ipc: Pick<ElectronIpc["Service"], "handleQuery">,
  core: CoreModuleClients,
) =>
  ipc.handleQuery("github:thread-links", (_, input) =>
    Effect.gen(function* () {
      const ref = gitHubThreadRefSchema.safeParse(input);
      if (!ref.success) return yield* Effect.fail(new Error("Invalid GitHub thread address"));
      const { host, owner, repo, number } = ref.data;
      const { value } = yield* core.workspace.read(
        {
          kind: "sources",
          read: { kind: "github_thread_links", host, repository: `${owner}/${repo}`, number },
        },
        undefined,
        null,
      );
      if (value.kind !== "sources" || value.value.kind !== "github_thread_links")
        return yield* Effect.fail(new Error("Invalid GitHub thread links response"));
      return value.value.links satisfies GitHubThreadLinks;
    }),
  );
