/* @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off -- Node stdio and Duplex adapter. */
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { Duplex } from "node:stream";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { z } from "zod";

const MAX_REQUEST = 384 * 1024;
const MAX_RESPONSE = 4 * 1024 * 1024;
const MAX_CHUNK = 65_536;

const certificate = z.object({ subject: z.string(), issuer: z.string() });
const authenticode = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("verified"),
    signature: z.literal("embedded"),
    chain: z.array(certificate).min(1),
    codeSigningEku: z.boolean(),
    timestampPresent: z.boolean(),
    revocation: z.enum(["cacheChecked", "cacheUnavailable"]),
  }),
  z.object({
    status: z.literal("rejected"),
    signature: z.enum(["embedded", "none"]),
    trustStatus: z.string(),
  }),
]);
const pathSecurity = z.object({
  reparsePoint: z.boolean(),
  ownerSid: z.string(),
  currentUserSid: z.string(),
  grantsForeignWrite: z.boolean(),
});
const pid = z.number().int().positive().max(0xffffffff);
const processIdentity = z.object({
  pid,
  creationTime: z.string().regex(/^\d+$/u),
  imagePath: z.string(),
});
const pipeConnection = z.object({ connection: pid, peer: processIdentity });
const pipeNames = z.object({ names: z.array(z.string()), truncated: z.boolean() });
const hex = z.string().regex(/^(?:[0-9a-f]{2})*$/u);
const registryValue = z.object({
  kind: z.number().int().nonnegative(),
  dataHex: hex,
});
const nativeMessagingKey = z.object({
  browser: z.enum(["chrome", "edge"]),
  view: z.enum(["x86", "x64"]),
  host: z.string(),
});
const registration = z.object({
  key: nativeMessagingKey,
  installed: registryValue,
  previous: registryValue.nullable(),
  createdKey: z.boolean(),
});

export type Authenticode = z.infer<typeof authenticode>;
export type PathSecurity = z.infer<typeof pathSecurity>;
export type WindowsProcessIdentity = z.infer<typeof processIdentity>;
export type RegistryValue = z.infer<typeof registryValue>;
export type RegistrationReceipt = z.infer<typeof registration>;
export type NativeMessagingKey = Readonly<z.infer<typeof nativeMessagingKey>>;
export interface JobLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}
export interface WindowsPipeConnection {
  readonly peer: WindowsProcessIdentity;
  readonly stream: Duplex;
}
export interface WindowsPipeListener {
  readonly endpoint: string;
  /** One pending accept per listener. Interrupting it closes the listener. */
  readonly accept: NativeEffect<WindowsPipeConnection>;
}

export class WindowsDesktopToolsError extends Data.TaggedError("WindowsDesktopToolsError")<{
  readonly kind: "unsupported" | "native";
  readonly operation: string;
  readonly cause?: unknown;
}> {}

type NativeEffect<T, R = never> = Effect.Effect<T, WindowsDesktopToolsError, R>;
export interface WindowsDesktopToolsService {
  readonly verifyAuthenticode: (path: string) => NativeEffect<Authenticode>;
  readonly inspectPath: (path: string) => NativeEffect<PathSecurity>;
  readonly listenPipe: (prefix: string) => NativeEffect<WindowsPipeListener, Scope.Scope>;
  readonly connectPipe: (endpoint: string) => NativeEffect<WindowsPipeConnection, Scope.Scope>;
  readonly enumeratePipes: (
    prefix: string,
    limit: number,
  ) => NativeEffect<z.infer<typeof pipeNames>>;
  readonly processIdentity: (pid: number) => NativeEffect<WindowsProcessIdentity>;
  readonly descendants: (
    root: WindowsProcessIdentity,
  ) => NativeEffect<readonly WindowsProcessIdentity[]>;
  readonly terminateSubtree: (root: WindowsProcessIdentity) => NativeEffect<readonly number[]>;
  /** The returned child's job lasts until the surrounding Effect Scope closes. */
  readonly spawnInJob: (launch: JobLaunch) => NativeEffect<WindowsProcessIdentity, Scope.Scope>;
  readonly readRegistration: (key: NativeMessagingKey) => NativeEffect<RegistryValue | null>;
  readonly writeRegistration: (
    key: NativeMessagingKey,
    expected: RegistryValue | null,
    manifest: string,
  ) => NativeEffect<RegistrationReceipt>;
  readonly restoreRegistration: (
    key: NativeMessagingKey,
    receipt: RegistrationReceipt,
  ) => NativeEffect<boolean>;
}

export class WindowsDesktopTools extends Context.Service<
  WindowsDesktopTools,
  WindowsDesktopToolsService
>()("nodex/WindowsDesktopTools") {}

const unsupported = (operation: string) =>
  Effect.fail(new WindowsDesktopToolsError({ kind: "unsupported", operation }));

export const unsupportedWindowsDesktopTools: WindowsDesktopToolsService = {
  verifyAuthenticode: () => unsupported("verifyAuthenticode"),
  inspectPath: () => unsupported("inspectPath"),
  listenPipe: () => unsupported("listenPipe"),
  connectPipe: () => unsupported("connectPipe"),
  enumeratePipes: () => unsupported("enumeratePipes"),
  processIdentity: () => unsupported("processIdentity"),
  descendants: () => unsupported("descendants"),
  terminateSubtree: () => unsupported("terminateSubtree"),
  spawnInJob: () => unsupported("spawnInJob"),
  readRegistration: () => unsupported("readRegistration"),
  writeRegistration: () => unsupported("writeRegistration"),
  restoreRegistration: () => unsupported("restoreRegistration"),
};

const response = z.union([
  z.object({ id: pid, error: z.string() }),
  z.object({ id: pid, value: z.unknown() }),
]);
type Reply = z.infer<typeof response>;
type Request = Readonly<{ op: string } & Record<string, unknown>>;

class NativeSession {
  readonly #child;
  readonly #pending = new Map<
    number,
    { resolve: (reply: Reply) => void; reject: (error: Error) => void }
  >();
  readonly #streams = new Set<Duplex>();
  readonly #exited: Promise<void>;
  #buffer: Buffer = Buffer.alloc(0);
  #next = 0;
  #error: Error | undefined;
  #closing: Promise<void> | undefined;

  constructor(executable: string) {
    if (!isAbsolute(executable))
      throw new Error("Expected the absolute packaged Core executable path");
    this.#child = spawn(executable, ["--desktop-tools-native"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.#exited = new Promise((resolve) => {
      this.#child.once("close", (code) => {
        this.#fail(new Error(`Desktop Tools platform command exited (${code})`));
        resolve();
      });
    });
    this.#child.on("error", (error) => this.#fail(error));
    this.#child.stdin.on("error", (error) => this.#fail(error));
    this.#child.stdout.on("error", (error) => this.#fail(error));
    this.#child.stdout.on("data", (chunk: Buffer) => this.#receive(chunk));
  }

  #receive(chunk: Buffer) {
    let offset = 0;
    try {
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(offset, end);
        if (this.#buffer.length + part.length > MAX_RESPONSE)
          throw new Error("Platform response limit exceeded");
        this.#buffer = this.#buffer.length === 0 ? part : Buffer.concat([this.#buffer, part]);
        if (newline < 0) return;
        const reply = response.parse(JSON.parse(this.#buffer.toString("utf8")));
        this.#buffer = Buffer.alloc(0);
        offset = newline + 1;
        const request = this.#pending.get(reply.id);
        if (!request) throw new Error("Unexpected platform response");
        this.#pending.delete(reply.id);
        request.resolve(reply);
      }
    } catch (cause) {
      this.#fail(asError(cause));
      this.#child.kill();
    }
  }

  #fail(error: Error) {
    this.#error ??= error;
    for (const request of this.#pending.values()) request.reject(error);
    this.#pending.clear();
    for (const stream of this.#streams) stream.destroy();
  }

  async request<T>(body: Request, schema: z.ZodType<T>): Promise<T> {
    if (this.#error) throw this.#error;
    if (this.#pending.size >= 32) throw new Error("Too many pending platform requests");
    const id = ++this.#next;
    const frame = `${JSON.stringify({ id, body })}\n`;
    if (Buffer.byteLength(frame) > MAX_REQUEST) throw new Error("Platform request limit exceeded");
    const reply = await new Promise<Reply>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#child.stdin.write(frame);
    });
    if ("error" in reply) throw new Error(reply.error);
    return schema.parse(reply.value);
  }

  close(): Promise<void> {
    return (this.#closing ??= this.#closeOwned());
  }

  async #closeOwned(): Promise<void> {
    this.#fail(new Error("Desktop Tools platform command closed"));
    this.#child.stdin.end();
    // EOF normally releases the native resources. Bound teardown even if a
    // native API is stalled. Job handles also close on forced termination.
    const deadline = setTimeout(() => this.#child.kill(), 1000);
    try {
      await this.#exited;
    } finally {
      clearTimeout(deadline);
    }
  }

  stream({ connection, peer }: z.infer<typeof pipeConnection>): WindowsPipeConnection {
    const request = <T>(op: string, schema: z.ZodType<T>, fields?: object) =>
      this.request({ op, connection, ...fields }, schema);
    const write = async (chunk: Buffer) => {
      for (let offset = 0; offset < chunk.length; offset += MAX_CHUNK) {
        await request("write", z.null(), {
          hex: chunk.subarray(offset, offset + MAX_CHUNK).toString("hex"),
        });
      }
    };
    const stream = new Duplex({
      allowHalfOpen: false,
      read() {
        void request("read", hex.max(MAX_CHUNK * 2).nullable()).then(
          (data) => this.push(data === null ? null : Buffer.from(data, "hex")),
          (error: unknown) => this.destroy(asError(error)),
        );
      },
      write(chunk: Buffer, _encoding, callback) {
        void write(chunk).then(
          () => callback(),
          (error: unknown) => callback(asError(error)),
        );
      },
      destroy: (error, callback) => {
        this.#streams.delete(stream);
        if (this.#error) {
          callback(error);
          return;
        }
        void request("close", z.null()).then(
          () => callback(error),
          () => callback(error),
        );
      },
    });
    this.#streams.add(stream);
    return { peer, stream };
  }
}

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const nativeError = (operation: string, cause: unknown) =>
  new WindowsDesktopToolsError({ kind: "native", operation, cause });

function makeWindowsDesktopTools(coreExecutable: string): WindowsDesktopToolsService {
  const session = (operation: string) =>
    Effect.acquireRelease(
      Effect.try({
        try: () => new NativeSession(coreExecutable),
        catch: (cause) => nativeError(operation, cause),
      }),
      (session) => Effect.promise(() => session.close()),
    );
  const request = <T>(session: NativeSession, body: Request, schema: z.ZodType<T>) =>
    Effect.tryPromise({
      try: () => session.request(body, schema),
      catch: (cause) => nativeError(body.op, cause),
    });
  const open = <T>(body: Request, schema: z.ZodType<T>) =>
    Effect.gen(function* () {
      const native = yield* session(body.op);
      const value = yield* request(native, body, schema).pipe(
        Effect.timeoutOrElse({
          duration: "20 seconds",
          orElse: () => Effect.fail(nativeError(body.op, "Platform command timed out")),
        }),
      );
      return { native, value };
    });
  const once = <T>(body: Request, schema: z.ZodType<T>) =>
    Effect.scoped(open(body, schema).pipe(Effect.map(({ value }) => value)));

  return {
    verifyAuthenticode: (path) => once({ op: "verifyAuthenticode", path }, authenticode),
    inspectPath: (path) => once({ op: "inspectPath", path }, pathSecurity),
    listenPipe: (prefix) =>
      open({ op: "listenPipe", prefix }, z.string()).pipe(
        Effect.map(({ native, value: endpoint }) => ({
          endpoint,
          accept: request(native, { op: "accept" }, pipeConnection).pipe(
            Effect.map((connection) => native.stream(connection)),
            Effect.onInterrupt(() => Effect.promise(() => native.close())),
          ),
        })),
      ),
    connectPipe: (endpoint) =>
      open({ op: "connectPipe", endpoint }, pipeConnection).pipe(
        Effect.map(({ native, value }) => native.stream(value)),
      ),
    enumeratePipes: (prefix, limit) => once({ op: "enumeratePipes", prefix, limit }, pipeNames),
    processIdentity: (pid) => once({ op: "processIdentity", pid }, processIdentity),
    descendants: (root) => once({ op: "descendants", root }, z.array(processIdentity)),
    terminateSubtree: (root) => once({ op: "terminateSubtree", root }, z.array(pid)),
    spawnInJob: (launch) =>
      open({ op: "spawnInJob", ...launch }, processIdentity).pipe(Effect.map(({ value }) => value)),
    readRegistration: (key) => once({ op: "readRegistration", key }, registryValue.nullable()),
    writeRegistration: (key, expected, manifest) =>
      once({ op: "writeRegistration", key, expected, manifest }, registration),
    restoreRegistration: (key, receipt) =>
      once({ op: "restoreRegistration", key, receipt }, z.boolean()),
  };
}

/** Supply the resolved Core executable from the existing desktop runtime paths. */
export const windowsDesktopToolsLayer = (platform: NodeJS.Platform, coreExecutable: string) =>
  Layer.succeed(
    WindowsDesktopTools,
    platform === "win32" ? makeWindowsDesktopTools(coreExecutable) : unsupportedWindowsDesktopTools,
  );
