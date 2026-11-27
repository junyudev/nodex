import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { GitHubThreads } from "../../../host/github/GitHubThreads";
import {
  gitHubThreadCommandSchema,
  gitHubThreadRefSchema,
  gitHubThreadSummariesInputSchema,
} from "../../../shared/github-thread";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";

class GitHubThreadIpcError extends Schema.TaggedError<GitHubThreadIpcError>()(
  "GitHubThreadIpcError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

const parse = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (cause) => new GitHubThreadIpcError({ message: "Invalid GitHub thread request", cause }),
  });

/** Space routing authenticates the sender and admits these handlers in the personal Space. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const threads = yield* GitHubThreads;
    yield* ipc.handleQuery("github:thread", (_, ref) =>
      parse(() => gitHubThreadRefSchema.parse(ref)).pipe(Effect.flatMap(threads.read)),
    );
    yield* ipc.handleQuery("github:thread-summaries", (_, refs) =>
      parse(() => gitHubThreadSummariesInputSchema.parse(refs)).pipe(
        Effect.flatMap(threads.summaries),
      ),
    );
    yield* ipc.handleQuery("github:thread-files", (_, ref) =>
      parse(() => gitHubThreadRefSchema.parse(ref)).pipe(Effect.flatMap(threads.files)),
    );
    yield* ipc.handlePlainCommand("github:thread-command", (_, ref, command) =>
      Effect.gen(function* () {
        const target = yield* parse(() => gitHubThreadRefSchema.parse(ref));
        const action = yield* parse(() => gitHubThreadCommandSchema.parse(command));
        return yield* threads.command(target, action);
      }),
    );
  }),
);
