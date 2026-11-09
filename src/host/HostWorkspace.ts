import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { localProjectSourceRoots, type ProjectSource } from "../shared/project-sources";

export class HostWorkspaceError extends Schema.TaggedError<HostWorkspaceError>()(
  "HostWorkspaceError",
  {
    message: Schema.String,
  },
) {}

/** Private filesystem resolution is a Host capability, independent of shared Project identity. */
export const HostWorkspace = Context.Reference<{
  readonly projectlessRoot?: string;
  readonly resolve: (
    sources: readonly ProjectSource[],
  ) => Effect.Effect<readonly string[], HostWorkspaceError>;
}>("nodex/host/HostWorkspace", {
  defaultValue: () => ({
    resolve: (sources) =>
      sources.some((source) => source.kind === "repository")
        ? Effect.fail(
            new HostWorkspaceError({
              message: "Repository sources require their execution Host's clone mapping",
            }),
          )
        : Effect.succeed(localProjectSourceRoots(sources)),
  }),
});
