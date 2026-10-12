/* oxlint-disable effecttsgo/async-function -- Promise-based descriptor and bounded filesystem reads stay at this Node Adapter. */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class NodeVisualizationFileError extends Schema.TaggedError<NodeVisualizationFileError>()(
  "NodeVisualizationFileError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class NodeVisualizationFiles extends Context.Service<
  NodeVisualizationFiles,
  {
    readonly canonicalRoot: (
      root: string,
    ) => Effect.Effect<string | null, NodeVisualizationFileError>;
    readonly temporaryRoots: Effect.Effect<readonly string[], NodeVisualizationFileError>;
    readonly read: (input: {
      readonly path: string;
      readonly boundary: string;
      readonly maxBytes: number;
    }) => Effect.Effect<NodeVisualizationRead, NodeVisualizationFileError>;
  }
>()("nodex/main/platform/node/NodeVisualizationFiles") {}

export type NodeVisualizationRead =
  | { readonly kind: "missing" }
  | { readonly kind: "too-large" }
  | { readonly kind: "read"; readonly contents: string };

const missing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new NodeVisualizationFileError({ operation, cause }),
  });

/** Trusted roots may resolve aliases; every descendant is inspected without following links. */
export const live: Layer.Layer<NodeVisualizationFiles> = Layer.succeed(NodeVisualizationFiles, {
  canonicalRoot: (root) =>
    attempt("canonical-root", () => realpath(root)).pipe(
      Effect.catch((error) => (missing(error.cause) ? Effect.succeed(null) : Effect.fail(error))),
    ),
  temporaryRoots: attempt("temporary-roots", async () => {
    const root = tmpdir();
    return [...new Set([root, await realpath(root)])];
  }),
  read: (input) =>
    attempt("read", async () => {
      const relative = path.relative(input.boundary, input.path);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new Error("Visualization is outside its boundary");
      let parent = path.dirname(input.path);
      let depth = 0;
      for (;;) {
        if (depth++ >= 64) throw new Error("Visualization parent chain is too deep");
        const metadata = await lstat(parent);
        if (!metadata.isDirectory() || metadata.isSymbolicLink())
          throw new Error("Visualization parent must be a regular directory");
        if (parent === input.boundary) break;
        const next = path.dirname(parent);
        if (next === parent) throw new Error("Visualization boundary is unreachable");
        parent = next;
      }
      const metadata = await lstat(input.path);
      if (!metadata.isFile() || metadata.isSymbolicLink())
        throw new Error("Visualization must be a regular file");
      if (metadata.size > input.maxBytes) return { kind: "too-large" } as const;
      const file = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await file.stat();
        if (!opened.isFile()) throw new Error("Visualization must be a regular file");
        if (opened.size > input.maxBytes) return { kind: "too-large" } as const;
        const chunks: Buffer[] = [];
        const buffer = Buffer.allocUnsafe(Math.min(65_536, input.maxBytes + 1));
        let length = 0;
        while (length <= input.maxBytes) {
          const { bytesRead } = await file.read(
            buffer,
            0,
            Math.min(buffer.length, input.maxBytes + 1 - length),
            null,
          );
          if (bytesRead === 0)
            return {
              kind: "read",
              contents: Buffer.concat(chunks, length).toString("utf8"),
            } as const;
          length += bytesRead;
          if (length > input.maxBytes) return { kind: "too-large" } as const;
          chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        }
        return { kind: "too-large" } as const;
      } finally {
        await file.close();
      }
    }).pipe(
      Effect.catch((error) =>
        missing(error.cause) ? Effect.succeed({ kind: "missing" } as const) : Effect.fail(error),
      ),
    ),
});
