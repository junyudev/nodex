/* oxlint-disable effecttsgo/async-function, effecttsgo/new-promise -- Node socket acquisition is a platform boundary owned by the application Scope. */
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type { CodexEndpoint } from "../../codex-runtime/CodexEndpoint";

export class ProfileSnapshotControlError extends Schema.TaggedError<ProfileSnapshotControlError>()(
  "ProfileSnapshotControlError",
  { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

const failure = (cause: unknown) =>
  new ProfileSnapshotControlError({ message: "Profile snapshot coordination failed", cause });
const requestSchema = Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(1) }));
const releaseSchema = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), release: Schema.Literal(true) }),
);
const encodeResponse = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      status: Schema.Literals(["ready", "resumed", "error"]),
      message: Schema.optionalKey(Schema.String),
    }),
  ),
);

const prepareSocket = async (profileHome: string): Promise<string> => {
  const directory = join(profileHome, "ipc");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error("Profile snapshot IPC directory must be private and owned by this user");
  const filename = join(directory, "clone.sock");
  const previous = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!previous) return filename;
  if (!previous.isSocket() || previous.uid !== stat.uid)
    throw new Error("Refusing to replace an unowned Profile snapshot endpoint");
  await new Promise<void>((resolve, reject) => {
    const probe = connect(filename);
    probe.setTimeout(1000, () => probe.destroy(new Error("Profile endpoint probe timed out")));
    probe.once("connect", () => {
      probe.destroy();
      reject(new Error("Another Desktop owns this Profile snapshot endpoint"));
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve();
      else reject(error);
    });
  });
  await unlink(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  return filename;
};

const handleConnection = Effect.fn("ProfileSnapshotControl.handleConnection")(function* (
  socket: Socket,
  withSnapshot: CodexEndpoint["Service"]["withProfileSnapshot"],
) {
  const messages = yield* Queue.bounded<string, ProfileSnapshotControlError>(2);
  const disconnected = yield* Deferred.make<void>();
  let buffer = "";
  const ended = () => {
    Deferred.doneUnsafe(disconnected, Effect.void);
    Queue.failCauseUnsafe(messages, Cause.fail(failure("Snapshot client disconnected")));
  };
  const data = (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > 256) {
      socket.destroy();
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (buffer.length > 0 || !Queue.offerUnsafe(messages, line)) socket.destroy();
  };
  socket.on("data", data);
  socket.on("end", ended);
  socket.on("error", ended);
  socket.on("close", ended);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      socket.off("data", data);
      socket.off("end", ended);
      socket.off("close", ended);
      // Keep the error listener until destroy finishes emitting socket events.
      socket.destroy();
    }),
  );
  socket.resume();
  const send = (status: "ready" | "resumed" | "error", message?: string) =>
    Effect.callback<void, ProfileSnapshotControlError>((resume) => {
      socket.write(
        `${encodeResponse({ version: 1, status, ...(message ? { message } : {}) })}\n`,
        (error) => resume(error ? Effect.fail(failure(error)) : Effect.void),
      );
    });
  yield* Queue.take(messages).pipe(
    Effect.flatMap(Schema.decodeEffect(requestSchema)),
    Effect.timeout("5 seconds"),
  );
  yield* withSnapshot(
    send("ready").pipe(
      Effect.andThen(Queue.take(messages)),
      Effect.flatMap(Schema.decodeEffect(releaseSchema)),
      Effect.timeout("5 minutes"),
    ),
  ).pipe(
    Effect.raceFirst(
      Deferred.await(disconnected).pipe(
        Effect.andThen(Effect.fail(failure("Client disconnected"))),
      ),
    ),
    Effect.matchEffect({
      onFailure: () =>
        send(
          "error",
          "Could not capture an idle local Agent. Wait for active work to finish and retry.",
        ),
      onSuccess: () => send("resumed"),
    }),
  );
});

/** A private, connection-bound lease; only the Endpoint supervisor can stop or restart its Agent. */
export const serveProfileSnapshotControl = Effect.fn("serveProfileSnapshotControl")(function* (
  profileHome: string,
  withSnapshot: CodexEndpoint["Service"]["withProfileSnapshot"],
) {
  const filename = yield* Effect.tryPromise({
    try: () => prepareSocket(profileHome),
    catch: failure,
  });
  const sockets = new Set<Socket>();
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => createServer({ pauseOnConnect: true, allowHalfOpen: true })),
    (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  const run = yield* FiberSet.makeRuntime();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      server.removeAllListeners("connection");
      for (const socket of sockets) socket.destroy();
    }),
  );
  server.on("connection", (socket) => {
    if (sockets.size >= 4) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    run(Effect.scoped(handleConnection(socket, withSnapshot)).pipe(Effect.ignore));
  });
  yield* Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(filename, () => {
          server.off("error", reject);
          resolve();
        });
      }),
    catch: failure,
  });
  yield* Effect.tryPromise({ try: () => chmod(filename, 0o600), catch: failure });
});
