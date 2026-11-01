/* @effect-diagnostics asyncFunction:off newPromise:off -- Node socket acquisition is a platform boundary owned by the application Scope. */
import { chmod, lstat, mkdir, unlink, readFile, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { makePrivate } from "./private-filesystem";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type { CodexEndpoint } from "../../codex-runtime/CodexEndpoint";
import type { AgentRuntimeProfileSnapshotSource } from "../../agent-runtime/AgentRuntimeProfileSnapshot";

export type WithExecutionSnapshot = <A, E, R>(
  capture: (snapshot?: AgentRuntimeProfileSnapshotSource) => Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | unknown, R>;

export class ProfileSnapshotControlError extends Schema.TaggedError<ProfileSnapshotControlError>()(
  "ProfileSnapshotControlError",
  { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

const failure = (cause: unknown) =>
  new ProfileSnapshotControlError({ message: "Profile snapshot coordination failed", cause });
const MAX_RESPONSE_BYTES = 1024 * 1024;
const requestSchema = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), capability: Schema.String }),
);
const releaseSchema = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), release: Schema.Literal(true) }),
);
const encodeResponse = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      status: Schema.Literals(["ready", "resumed", "error"]),
      message: Schema.optionalKey(Schema.String),
      executionSnapshot: Schema.optionalKey(
        Schema.Struct({
          leaseId: Schema.String,
          runtimeId: Schema.String,
          runtimeGeneration: Schema.String,
          sequence: Schema.Number,
          databasePath: Schema.String,
          attachmentsPath: Schema.String,
          environmentIdPath: Schema.String,
          nativeHistories: Schema.Array(
            Schema.Struct({
              providerInstanceId: Schema.String,
              driver: Schema.String,
              homePath: Schema.NullOr(Schema.String),
            }),
          ),
        }),
      ),
    }),
  ),
);

const rendezvousSchema = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    endpoint: Schema.String,
    capability: Schema.String,
    pid: Schema.Int,
  }),
);

const prepareSocket = async (profileHome: string, coreExecutable: string) => {
  const directory = join(profileHome, "ipc");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Profile snapshot IPC directory must be a real directory");
  if (
    process.platform !== "win32" &&
    (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
  )
    throw new Error("Profile snapshot IPC directory must be private and owned by this user");
  await makePrivate(directory, true, coreExecutable);
  const rendezvous = join(directory, "clone.json");
  const socketPath = join(directory, "clone.sock");
  const previous = await lstat(rendezvous).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (previous) {
    if (!previous.isFile() || previous.isSymbolicLink() || previous.size > 4096)
      throw new Error("Profile snapshot rendezvous must be a bounded regular file");
    if (
      process.platform !== "win32" &&
      (previous.uid !== stat.uid || (previous.mode & 0o077) !== 0)
    )
      throw new Error("Profile snapshot rendezvous must be private");
    const prior = Schema.decodeUnknownSync(rendezvousSchema)(await readFile(rendezvous, "utf8"));
    if (
      process.platform === "win32"
        ? !/^\\\\\.\\pipe\\nodex-clone-[a-f0-9]{32}$/u.test(prior.endpoint)
        : prior.endpoint !== socketPath
    )
      throw new Error("Profile snapshot endpoint is invalid");
    await new Promise<void>((resolve, reject) => {
      const probe = connect(prior.endpoint);
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
    await unlink(rendezvous);
  }
  if (process.platform !== "win32") {
    const previousSocket = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (previousSocket) {
      if (!previousSocket.isSocket() || previousSocket.uid !== stat.uid)
        throw new Error("Refusing to replace an unowned Profile snapshot socket");
      await unlink(socketPath);
    }
  }
  return {
    rendezvous,
    endpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\nodex-clone-${randomBytes(16).toString("hex")}`
        : socketPath,
    capability: randomBytes(32).toString("hex"),
  };
};

const handleConnection = Effect.fn("ProfileSnapshotControl.handleConnection")(function* (
  socket: Socket,
  capability: string,
  withSnapshot: CodexEndpoint["Service"]["withProfileSnapshot"],
  withExecutionSnapshot?: WithExecutionSnapshot,
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
  const send = (
    status: "ready" | "resumed" | "error",
    message?: string,
    executionSnapshot?: AgentRuntimeProfileSnapshotSource,
  ) =>
    Effect.callback<void, ProfileSnapshotControlError>((resume) => {
      const line = `${encodeResponse({ version: 1, status, ...(message ? { message } : {}), ...(executionSnapshot ? { executionSnapshot } : {}) })}\n`;
      if (Buffer.byteLength(line) > MAX_RESPONSE_BYTES) {
        resume(Effect.fail(failure("Snapshot configuration exceeds its response bound")));
        return;
      }
      socket.write(line, (error) => resume(error ? Effect.fail(failure(error)) : Effect.void));
    });
  const request = yield* Queue.take(messages).pipe(
    Effect.flatMap(Schema.decodeEffect(requestSchema)),
    Effect.timeout("5 seconds"),
  );
  const supplied = Buffer.from(request.capability);
  const expected = Buffer.from(capability);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    return yield* Effect.fail(failure("Invalid snapshot capability"));
  const capture = (snapshot?: AgentRuntimeProfileSnapshotSource) =>
    withSnapshot(
      send("ready", undefined, snapshot).pipe(
        Effect.andThen(Queue.take(messages)),
        Effect.flatMap(Schema.decodeEffect(releaseSchema)),
        Effect.timeout("5 minutes"),
      ),
    );
  yield* (withExecutionSnapshot ? withExecutionSnapshot(capture) : capture()).pipe(
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
  coreExecutable: string,
  withSnapshot: CodexEndpoint["Service"]["withProfileSnapshot"],
  withExecutionSnapshot?: WithExecutionSnapshot,
) {
  const endpoint = yield* Effect.tryPromise({
    try: () => prepareSocket(profileHome, coreExecutable),
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
    run(
      Effect.scoped(
        handleConnection(socket, endpoint.capability, withSnapshot, withExecutionSnapshot),
      ).pipe(Effect.ignore),
    );
  });
  yield* Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint.endpoint, () => {
          server.off("error", reject);
          resolve();
        });
      }),
    catch: failure,
  });
  if (process.platform !== "win32")
    yield* Effect.tryPromise({ try: () => chmod(endpoint.endpoint, 0o600), catch: failure });
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        await writeFile(
          endpoint.rendezvous,
          `${JSON.stringify({ version: 1, endpoint: endpoint.endpoint, capability: endpoint.capability, pid: process.pid })}\n`,
          { flag: "wx", mode: 0o600 },
        );
        await makePrivate(endpoint.rendezvous, false, coreExecutable);
      },
      catch: failure,
    }),
    () =>
      Effect.promise(async () => {
        const current = await readFile(endpoint.rendezvous, "utf8").catch(() => null);
        if (
          current &&
          Schema.decodeUnknownSync(rendezvousSchema)(current).capability === endpoint.capability
        )
          await unlink(endpoint.rendezvous);
      }),
  );
});
