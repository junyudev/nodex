/* oxlint-disable effecttsgo/async-function -- Private socket acquisition is a Node resource boundary; application execution enters the scoped callback runtime once. */
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { listenAppToolsPipe, type AppToolsPipeDescriptor } from "@nodex/app-tools-mcp/pipe";
import type { AppToolsHost } from "@nodex/app-tools-mcp/server";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";

export class AppToolPipeError extends Schema.TaggedError<AppToolPipeError>()("AppToolPipeError", {
  cause: Schema.Defect(),
}) {}

export interface AppToolPipeHandler<E> {
  readonly listTools: Effect.Effect<Tool[], E>;
  readonly callTool: (
    input: Omit<Parameters<AppToolsHost["callTool"]>[0], "signal">,
  ) => Effect.Effect<CallToolResult, E>;
}

/** A short private directory avoids Unix socket path limits for deeply nested Profiles. */
export const acquireAppToolPipe = Effect.fn("NodexAppToolPipe.acquire")(function* <E>(
  handler: AppToolPipeHandler<E>,
) {
  const callbacks = yield* ScopedCallbackRuntime;
  const lease = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const directory = await mkdtemp(join(tmpdir(), "nx-mcp-"));
        try {
          await chmod(directory, 0o700);
          const descriptor: AppToolsPipeDescriptor = {
            path: join(directory, "host.sock"),
            instanceId: randomUUID(),
            token: randomBytes(32).toString("hex"),
          };
          const pipe = await listenAppToolsPipe(descriptor, {
            listTools: (signal) => callbacks.runPromise(handler.listTools, { signal }),
            callTool: ({ signal, ...input }) =>
              callbacks.runPromise(handler.callTool(input), { signal }),
          });
          return { descriptor, pipe, directory };
        } catch (error) {
          await rm(directory, { recursive: true, force: true });
          throw error;
        }
      },
      catch: (cause) => new AppToolPipeError({ cause }),
    }),
    (lease) =>
      Effect.promise(async () => {
        try {
          await lease.pipe.close();
        } finally {
          await rm(lease.directory, { recursive: true, force: true });
        }
      }),
  );
  return lease.descriptor;
});
