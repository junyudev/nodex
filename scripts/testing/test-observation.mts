import { executionAsyncId, createHook } from "node:async_hooks";
import childProcess from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import dgram from "node:dgram";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import type { RequestOptions } from "node:http";
import Module, { registerHooks, syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ConnectionOptions } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import workers from "node:worker_threads";

type PathState = "absent" | "file" | "directory";
export type ReadKind =
  | "content"
  | "stat"
  | "lstat"
  | "access"
  | "exists"
  | "realpath"
  | "readlink"
  | "readdir"
  | "opendir";
type Reason =
  | "external filesystem"
  | "filesystem operation"
  | "unresolved descriptor"
  | "unstable filesystem input"
  | "unfinished filesystem operation"
  | "subprocess"
  | "network"
  | "worker"
  | "native addon"
  | "native filesystem"
  | "module resolution"
  | "file attribution";

export interface PathEvidence {
  readonly state: PathState;
  readonly error?: string;
  readonly digest?: string;
  readonly target?: string;
  readonly mode?: number;
  readonly recursive?: boolean;
  readonly bufferSize?: number;
}

export interface ObservedPath {
  readonly path: string;
  readonly kind: ReadKind;
  readonly evidence: PathEvidence;
}

export interface TestObservation {
  readonly version: number;
  readonly file: string;
  readonly reads: readonly string[];
  readonly listings: readonly ObservedPath[];
  readonly pathEvidence: readonly ObservedPath[];
  readonly unobservable: Readonly<Record<string, readonly string[]>>;
  readonly nativeResolution: boolean;
  readonly missingModuleCandidates: readonly string[];
}

interface Observation {
  readonly file: string;
  readonly recordPath: string;
  readonly pool: string;
  readonly child?: boolean;
  readonly root: string;
  readonly directory: string;
  readonly temporary: readonly string[];
  readonly created: Set<string>;
  readonly descriptors: Map<number, { path: string; identity: string }>;
  readonly reads: Set<string>;
  readonly ignored: readonly string[];
  readonly snapshots: Map<string, ObservedPath>;
  readonly reasons: Map<Reason, Set<string>>;
  nativeResolution: boolean;
  readonly missingModuleCandidates: Set<string>;
  pending: number;
  pendingChildren: number;
  finished: boolean;
}

// Native, host-realm originals. The recorder and its output must never become inputs.
const raw = {
  readFile: fs.readFileSync,
  stat: fs.statSync,
  lstat: fs.lstatSync,
  fstat: fs.fstatSync,
  access: fs.accessSync,
  realpath: fs.realpathSync.native,
  readlink: fs.readlinkSync,
  readdir: fs.readdirSync,
  opendir: fs.opendirSync,
  mkdir: fs.mkdirSync,
  writeFile: fs.writeFileSync,
  rename: fs.renameSync,
};
const observedRuntime = process.env.NODEX_TEST_OBSERVATION_RUNTIME;
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const virtualStore = path.join(repositoryRoot, "node_modules", ".pnpm");
const virtualStoreUrl = pathToFileURL(virtualStore + path.sep).href;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const relative = (root: string, filename: string) =>
  path.relative(root, filename).split(path.sep).join("/");
const inside = (root: string, filename: string) => {
  const name = path.relative(root, filename);
  return name !== ".." && !name.startsWith(".." + path.sep) && !path.isAbsolute(name);
};
const missing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "");
function coveredByInstall(root: string, filename: string, canonical: string) {
  if (!inside(root, filename) || !relative(root, filename).split("/").includes("node_modules"))
    return false;
  const install = path.join(repositoryRoot, "node_modules");
  if (!inside(install, canonical)) return false;
  const first = relative(install, canonical).split("/")[0];
  // Tests and tools also put independent outputs under node_modules/.cache.
  return !first.startsWith(".") || first === ".pnpm";
}
const isListing = (kind: ReadKind): kind is "readdir" | "opendir" =>
  kind === "readdir" || kind === "opendir";
const identity = (stat: fs.BigIntStats) => `${stat.dev}:${stat.ino}`;
// Normalizing an unresolved parent segment can change the meaning of a path through a symlink.
const parentSegment =
  process.platform === "win32" ? /(?:^|[\\/])\.\.(?:[\\/]|$)/u : /(?:^|\/)\.\.(?:\/|$)/u;
const resolvePath = (name: string) =>
  name && !parentSegment.test(name) ? path.resolve(name) : undefined;
const processPath = (value: unknown) => {
  try {
    if (typeof value === "string") return resolvePath(value);
    if (Buffer.isBuffer(value)) {
      const decoded = value.toString();
      return Buffer.from(decoded).equals(value) ? resolvePath(decoded) : undefined;
    }
    if (value && typeof value === "object" && "href" in value && typeof value.href === "string")
      return path.resolve(fileURLToPath(value.href));
  } catch {
    return undefined;
  }
};
const tryRealpath = (filename: string): string => {
  try {
    return raw.realpath(filename);
  } catch (error) {
    if (!missing(error)) throw error;
    const parent = path.dirname(filename);
    if (parent === filename) throw error;
    return path.join(tryRealpath(parent), path.basename(filename));
  }
};

let active: Observation | undefined;
let tracing = false;
let nativeHooksInstalled = false;
let internal = 0;
const origins = new Map<number, Observation>();
function withinRecorder<T>(run: () => T): T {
  internal++;
  try {
    return run();
  } finally {
    internal--;
  }
}

function publish(observation: Observation) {
  const { directory, descriptors, file, pool, reads, reasons, snapshots } = observation;
  const probes = new Map<string, PathState>();
  for (const entry of snapshots.values()) probes.set(entry.path, entry.evidence.state);
  const record = {
    version: 2,
    file,
    pool,
    worker: { pid: process.pid, threadId: workers.threadId },
    reads: [...reads].sort(),
    nativeResolution: observation.nativeResolution,
    missingModuleCandidates: [...observation.missingModuleCandidates].sort(),
    probes: Object.fromEntries(probes),
    listings: [...snapshots.values()].filter(({ kind }) => isListing(kind)),
    pathEvidence: [...snapshots.values()].filter(({ kind }) => !isListing(kind)),
    unobservable: Object.fromEntries(
      [...reasons].map(([reason, details]) => [reason, [...details].sort()]),
    ),
  };
  withinRecorder(() => {
    const target = observation.recordPath;
    const temporary = target + `.${process.pid}.${workers.threadId}.tmp`;
    raw.mkdir(directory, { recursive: true });
    raw.writeFile(temporary, JSON.stringify(record) + "\n");
    raw.rename(temporary, target);
  });
  descriptors.clear();
}

function block(observation: Observation, reason: Reason, detail: string) {
  const details = observation.reasons.get(reason);
  if (details?.has(detail)) return;
  if (details) details.add(detail);
  else observation.reasons.set(reason, new Set([detail]));
  if (observation.finished) publish(observation);
}

function current() {
  if (internal) return;
  if (tracing) {
    const origin = origins.get(executionAsyncId());
    if (origin?.finished) {
      if (origin.reasons.size === 0)
        block(origin, "file attribution", "operation after the file finished");
      return;
    }
  }
  // An opaque operation has already committed the file to execution on the next check.
  if (active?.reasons.size === 0) return active;
}

function inputPath(observation: Observation, value: unknown, method: string) {
  if (typeof value === "number") {
    const opened = observation.descriptors.get(value);
    if (opened) {
      try {
        if (
          identity(raw.fstat(value, { bigint: true })) === opened.identity &&
          identity(raw.stat(opened.path, { bigint: true })) === opened.identity
        )
          return opened.path;
      } catch {
        // A descriptor is independent of the continued existence of its original path.
      }
    }
    block(observation, "unresolved descriptor", method);
    return;
  }
  const filename = processPath(value);
  if (!filename) block(observation, "filesystem operation", method + " path");
  return filename;
}

const runnerCache = (observation: Observation, filename: string) =>
  observation.ignored.some(
    (directory) => filename === directory || filename.startsWith(directory + path.sep),
  );

function classify(observation: Observation, filename: string) {
  const { root, temporary, created } = observation;
  // Vitest's transform files and the locked pnpm store are represented by runner/install identity.
  if (runnerCache(observation, filename)) return;
  const canonical = tryRealpath(filename);
  if (created.has(canonical) && filename === canonical) return;
  if (
    coveredByInstall(root, filename, canonical) ||
    coveredByInstall(repositoryRoot, filename, canonical)
  )
    return;
  if (inside(root, filename) && inside(root, canonical)) return canonical;
  if (temporary.some((directory) => inside(directory, canonical))) {
    for (let parent = canonical; parent !== path.dirname(parent); parent = path.dirname(parent)) {
      if (created.has(parent)) return;
    }
  }
  block(observation, "external filesystem", filename);
}

function listDirectory(
  filename: string,
  kind: "readdir" | "opendir",
  recursive: boolean,
  bufferSize?: number,
) {
  const encode = (entry: fs.Dirent) => [
    entry.parentPath ? relative(filename, entry.parentPath) : "",
    entry.name,
    entry.isDirectory()
      ? "directory"
      : entry.isFile()
        ? "file"
        : entry.isSymbolicLink()
          ? "symlink"
          : "special",
  ];
  if (kind === "readdir")
    return raw.readdir(filename, { recursive, withFileTypes: true }).map(encode);
  const entries: string[][] = [];
  const directory = raw.opendir(
    filename,
    bufferSize === undefined ? { recursive } : { recursive, bufferSize },
  );
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync())
      entries.push(encode(entry));
  } finally {
    directory.closeSync();
  }
  return entries;
}

export function pathSnapshot(filename: string, kind: ReadKind, options: unknown): PathEvidence {
  const flags = options && typeof options === "object" ? options : {};
  const encoding =
    typeof options === "string" ? options : "encoding" in flags ? flags.encoding : undefined;
  if (isListing(kind) && encoding && encoding !== "utf8" && encoding !== "utf-8")
    throw new Error("Untracked directory encoding");
  const recursive = isListing(kind) && "recursive" in flags && flags.recursive === true;
  const mode = kind === "access" && typeof options === "number" ? options : undefined;
  const bufferSize =
    kind === "opendir" && "bufferSize" in flags && typeof flags.bufferSize === "number"
      ? flags.bufferSize
      : undefined;
  const replay = {
    ...(recursive ? { recursive } : {}),
    ...(mode === undefined ? {} : { mode }),
    ...(bufferSize === undefined ? {} : { bufferSize }),
  };
  try {
    const stat =
      kind === "lstat" || kind === "readlink"
        ? raw.lstat(filename, { bigint: true })
        : raw.stat(filename, { bigint: true });
    if (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink())
      throw new Error("Non-regular filesystem input");
    const state = stat.isDirectory() ? "directory" : "file";
    if (kind === "exists") return { state };
    if (kind === "access") {
      let outcome = "ok";
      try {
        raw.access(filename, mode);
      } catch (error) {
        outcome = (error as NodeJS.ErrnoException).code ?? "unknown";
      }
      return { state, digest: digest(outcome), ...replay };
    }
    if (kind === "realpath") return { state, target: raw.realpath(filename) };
    if (kind === "readlink")
      return {
        state,
        ...(stat.isSymbolicLink()
          ? { digest: digest(raw.readlink(filename, { encoding: "buffer" })) }
          : {}),
      };
    if (kind === "stat" || kind === "lstat")
      return {
        state,
        digest: digest(
          JSON.stringify(stat, (_, value: unknown) =>
            typeof value === "bigint" ? String(value) : value,
          ),
        ),
      };
    if (kind === "content") return { state };
    if (!isListing(kind)) throw new Error("Unsupported read operation");
    const entries =
      state === "directory" ? listDirectory(filename, kind, recursive, bufferSize) : [];
    return { state, digest: digest(JSON.stringify(entries)), ...replay };
  } catch (error) {
    if (!missing(error)) throw error;
    return { state: "absent", error: (error as NodeJS.ErrnoException).code, ...replay };
  }
}

function recordRead(observation: Observation, filename: string, kind: ReadKind, options: unknown) {
  try {
    if (runnerCache(observation, filename)) return;
    // The engine validates this exact executable's regular-file bytes.
    if (
      filename === observedRuntime &&
      filename === process.execPath &&
      (kind === "content" || kind === "exists") &&
      raw.realpath(filename) === filename &&
      raw.stat(filename).isFile()
    )
      return;
    const name = relative(observation.root, filename) || ".";
    if (kind === "content" && observation.reads.has(name))
      return { state: "file" } satisfies PathEvidence;
    const canonical = classify(observation, filename);
    if (!canonical) return;
    // A path alias is not portable and can be retargeted independently of the file it names.
    if (canonical !== filename) {
      block(observation, "filesystem operation", "path alias " + name);
      return;
    }
    const snapshot = pathSnapshot(filename, kind, options);
    if (kind === "content" && snapshot.state === "file") {
      observation.reads.add(name);
      return snapshot;
    }
    const evidence =
      snapshot.target === undefined
        ? snapshot
        : { ...snapshot, target: relative(observation.root, snapshot.target) || "." };
    const key = JSON.stringify([
      name,
      kind,
      evidence.mode,
      evidence.recursive,
      evidence.bufferSize,
    ]);
    const previous = observation.snapshots.get(key);
    if (previous && JSON.stringify(previous.evidence) !== JSON.stringify(evidence)) {
      block(observation, "unstable filesystem input", name);
      return;
    }
    observation.snapshots.set(key, { path: name, kind, evidence });
    return evidence;
  } catch {
    block(observation, "filesystem operation", kind + " " + filename);
  }
}

type Completion = (result: unknown) => void;
type Inspect = (observation: Observation, args: unknown[], receiver: unknown) => Completion | void;
type Api = "sync" | "promise" | "callback";

// Preserve function properties, prototypes, constructor behavior, and callback receivers.
function intercept(owner: object, key: PropertyKey, apply: ProxyHandler<Function>) {
  const original: unknown = Reflect.get(owner, key);
  if (typeof original === "function") Reflect.set(owner, key, new Proxy(original, apply));
}

function observe(
  owner: object,
  method: string,
  api: Api,
  inspect: Inspect,
  suppressNested = false,
) {
  intercept(owner, method, {
    apply(original, receiver, args: unknown[]) {
      const observation = current();
      if (!observation) return Reflect.apply(original, receiver, args);
      const complete = withinRecorder(() => {
        try {
          const onComplete = inspect(observation, args, receiver);
          if (!onComplete) return;
          return (result: unknown) => {
            try {
              onComplete(result);
            } catch {
              block(observation, "filesystem operation", method + " completion");
            }
          };
        } catch {
          block(observation, "filesystem operation", method);
        }
      });
      if (api === "sync" && (complete || suppressNested))
        return withinRecorder(() => {
          const result: unknown = Reflect.apply(original, receiver, args);
          complete?.(result);
          return result;
        });
      if (!complete) return Reflect.apply(original, receiver, args);
      const callback = args.at(-1);
      if (api === "callback" && typeof callback !== "function")
        return Reflect.apply(original, receiver, args);
      observation.pending++;
      const settled = (ok: boolean, result: unknown) => {
        observation.pending--;
        if (observation.finished)
          block(observation, "file attribution", method + " completed after the file finished");
        else if (ok) withinRecorder(() => complete(result));
      };
      if (api === "callback" && typeof callback === "function") {
        args[args.length - 1] = function (this: unknown, ...values: unknown[]) {
          const exists = method === "exists";
          settled(exists || !values[0], values[exists ? 0 : 1]);
          return Reflect.apply(callback, this, values);
        };
      }
      try {
        const result: unknown = Reflect.apply(original, receiver, args);
        if (api === "callback") return result;
        return (result as Promise<unknown>).then(
          (value) => {
            settled(true, value);
            return value;
          },
          (error: unknown) => {
            settled(false, undefined);
            throw error;
          },
        );
      } catch (error) {
        observation.pending--;
        throw error;
      }
    },
  });
}

const pathReaders: Readonly<Record<string, ReadKind>> = {
  access: "access",
  exists: "exists",
  stat: "stat",
  lstat: "lstat",
  realpath: "realpath",
  readlink: "readlink",
  readdir: "readdir",
  opendir: "opendir",
  readFile: "content",
  createReadStream: "content",
  openAsBlob: "content",
  fstat: "stat",
  read: "content",
  readv: "content",
};

function readOperation(method: string, kind: ReadKind): Inspect {
  return (observation, args) => {
    const options = args[1] as { fd?: number | fsPromises.FileHandle } | undefined;
    const source = method === "createReadStream" ? (options?.fd ?? args[0]) : args[0];
    const fd = source && typeof source === "object" && "fd" in source ? source.fd : source;
    const filename = inputPath(observation, fd, method);
    if (!filename) return;
    const before = recordRead(observation, filename, kind, args[1]);
    if (!before) return;
    // The parent hashes content once and rejects ctime newer than the start of the batch.
    if (kind === "content" && before.state === "file") return () => {};
    return (result) => {
      if (
        kind === "exists" &&
        typeof result === "boolean" &&
        result !== (before.state !== "absent")
      ) {
        block(observation, "unstable filesystem input", relative(observation.root, filename));
      }
      recordRead(observation, filename, kind, args[1]);
    };
  };
}

const handleReaders = {
  read: "content",
  readv: "content",
  readFile: "content",
  readLines: "content",
  createReadStream: "content",
  readableWebStream: "content",
  stat: "stat",
} as const;
const handlePrototypes = new WeakSet<object>();

function observeHandle(handle: fsPromises.FileHandle) {
  const prototype: object = Object.getPrototypeOf(handle);
  if (handlePrototypes.has(prototype)) return;
  handlePrototypes.add(prototype);
  for (const [method, kind] of Object.entries(handleReaders)) {
    observe(
      prototype,
      method,
      ["readLines", "createReadStream", "readableWebStream"].includes(method) ? "sync" : "promise",
      (observation, args, receiver) =>
        readOperation(method, kind)(
          observation,
          [(receiver as fsPromises.FileHandle).fd, ...args],
          receiver,
        ),
    );
  }
}

function createsFile(flags: unknown) {
  if (typeof flags === "number") return (flags & fs.constants.O_CREAT) !== 0;
  return typeof flags === "string" && /^[wa]/u.test(flags);
}

function absentPath(filename: string) {
  try {
    raw.lstat(filename);
    return false;
  } catch (error) {
    return missing(error);
  }
}

function rememberCreated(observation: Observation, filename: string) {
  // Never exempt a link or its target based on a creation at the link's spelling.
  const canonical = tryRealpath(filename);
  if (inside(observation.root, filename)) {
    if (canonical === filename) observation.created.add(filename);
    return;
  }
  if (observation.temporary.some((directory) => inside(directory, canonical)))
    observation.created.add(canonical);
}

function openOperation(observation: Observation, [value, flags]: unknown[]): Completion | void {
  const filename = inputPath(observation, value, "open");
  if (!filename) return;
  const installed = runnerCache(observation, filename);
  const creates = !installed && createsFile(flags) && absentPath(filename);
  if (!creates && !installed) recordRead(observation, filename, "exists", undefined);
  return (result) => {
    if (creates) rememberCreated(observation, filename);
    const handle = typeof result === "number" ? undefined : (result as fsPromises.FileHandle);
    const fd = handle?.fd ?? (result as number);
    if (handle) observeHandle(handle);
    try {
      observation.descriptors.set(fd, {
        path: filename,
        identity: identity(raw.fstat(fd, { bigint: true })),
      });
    } catch {
      block(observation, "unresolved descriptor", "open");
    }
  };
}

function mutation(method: string): Inspect {
  return (observation, args) => {
    const value = ["copyFile", "cp", "link", "symlink", "rename"].includes(method)
      ? args[1]
      : args[0];
    const filename = processPath(value);
    if (!filename || runnerCache(observation, filename)) return;
    const removal = ["rm", "rmdir", "unlink", "rename"].includes(method)
      ? processPath(args[0])
      : undefined;
    const removed = removal && tryRealpath(removal);
    const forgetRemoved = () => {
      if (!removed) return;
      for (const created of observation.created)
        if (inside(removed, created)) observation.created.delete(created);
    };
    if (method !== "mkdir" && !inside(observation.root, filename)) {
      classify(observation, filename);
      return removed ? forgetRemoved : undefined;
    }
    if (
      method === "mkdir" &&
      !inside(observation.root, filename) &&
      !observation.temporary.some((directory) => inside(directory, tryRealpath(filename)))
    ) {
      classify(observation, filename);
      return;
    }
    if (["rm", "rmdir", "unlink"].includes(method)) {
      recordRead(observation, filename, "exists", undefined);
      return forgetRemoved;
    }
    if (["cp", "symlink", "link"].includes(method) || !absentPath(filename)) return;
    return (firstCreated) => {
      forgetRemoved();
      rememberCreated(observation, filename);
      if (method !== "mkdir" || typeof firstCreated !== "string") return;
      for (
        let parent = path.dirname(filename);
        inside(firstCreated, parent);
        parent = path.dirname(parent)
      )
        rememberCreated(observation, parent);
    };
  };
}

function hookFilesystem() {
  for (const [method, kind] of Object.entries(pathReaders)) {
    // Node's synchronous file reads can call the public descriptor API internally.
    observe(fs, method + "Sync", "sync", readOperation(method, kind), true);
    observe(
      fs,
      method,
      method === "createReadStream" ? "sync" : method === "openAsBlob" ? "promise" : "callback",
      readOperation(method, kind),
    );
    observe(fsPromises, method, "promise", readOperation(method, kind));
  }
  // `util.promisify(fs.exists)` uses a separate native wrapper with a captured reference.
  const exists = fs.exists;
  const existsWithCustomPromisifier = Object.defineProperty(
    (filename: fs.PathLike, callback: (found: boolean) => void) => exists(filename, callback),
    promisify.custom,
    {
      value: (filename: fs.PathLike) =>
        new Promise<boolean>((resolve) => exists(filename, resolve)),
    },
  );
  Reflect.set(fs, "exists", existsWithCustomPromisifier);
  observe(fs.realpath, "native", "callback", readOperation("realpath", "realpath"));
  observe(fs.realpathSync, "native", "sync", readOperation("realpath", "realpath"));
  observe(fs, "open", "callback", openOperation);
  observe(fs, "openSync", "sync", openOperation);
  observe(fsPromises, "open", "promise", openOperation);
  const temporaryDirectory: Inspect = (observation, [prefix]) => {
    const name = processPath(prefix);
    if (!name) return;
    return (result) => {
      const created = processPath(
        result && typeof result === "object" && "path" in result ? result.path : result,
      );
      if (created) rememberCreated(observation, created);
      else block(observation, "filesystem operation", "temporary directory");
    };
  };
  observe(fs, "mkdtemp", "callback", temporaryDirectory);
  observe(fs, "mkdtempSync", "sync", temporaryDirectory);
  observe(fs, "mkdtempDisposableSync", "sync", temporaryDirectory);
  for (const method of ["mkdtemp", "mkdtempDisposable"])
    observe(fsPromises, method, "promise", temporaryDirectory);
  for (const method of ["writeFile", "appendFile", "mkdir", "rm", "rmdir", "unlink"]) {
    observe(fs, method, "callback", mutation(method));
    observe(fs, method + "Sync", "sync", mutation(method));
    observe(fsPromises, method, "promise", mutation(method));
  }
  for (const method of ["copyFile", "cp", "link", "rename", "truncate"]) {
    const inspect: Inspect =
      method === "cp"
        ? opaqueFilesystem(method)
        : (observation, args) => {
            const filename = inputPath(observation, args[0], method);
            if (filename)
              recordRead(
                observation,
                filename,
                method === "rename" ? "exists" : "content",
                undefined,
              );
          };
    // Observe source input and destination creation around the same call.
    const combined: Inspect = (observation, args, receiver) => {
      const read = inspect(observation, args, receiver);
      const write = mutation(method)(observation, args, receiver);
      if (read || write)
        return (result) => {
          read?.(result);
          write?.(result);
        };
    };
    // copyFile and rename are installed here so their own source reads are observed only once.
    observe(fs, method, "callback", combined);
    observe(fs, method + "Sync", "sync", combined);
    observe(fsPromises, method, "promise", combined);
  }
  for (const method of ["glob", "watch", "watchFile", "statfs"]) {
    observe(fs, method, "sync", opaqueFilesystem(method));
    observe(fs, method + "Sync", "sync", opaqueFilesystem(method));
    observe(fsPromises, method, "sync", opaqueFilesystem(method));
  }
  for (const stream of ["ReadStream", "FileReadStream"]) {
    intercept(fs, stream, {
      construct(original, args, target) {
        const observation = current();
        if (observation)
          withinRecorder(() => readOperation(stream, "content")(observation, args, undefined));
        return Reflect.construct(original, args, target);
      },
      apply(original, receiver, args) {
        const observation = current();
        if (observation)
          withinRecorder(() => readOperation(stream, "content")(observation, args, receiver));
        return Reflect.apply(original, receiver, args);
      },
    });
  }
}

function opaqueFilesystem(method: string): Inspect {
  return (observation, args) => {
    const filename = processPath(args[0]);
    if (method !== "glob" && filename && !classify(observation, filename)) return;
    block(observation, "filesystem operation", method);
  };
}

function subprocess(observation: Observation, executable: unknown) {
  // A later caller can resolve declared native executable identities at this boundary.
  block(observation, "subprocess", typeof executable === "string" ? executable : "<unknown>");
}

const inheritedCa = process.env.NODE_EXTRA_CA_CERTS;
const childObservationEnv = "NODEX_TEST_OBSERVATION_CHILD";
const inheritedNodeOption = /^(?:--use-system-ca|--max-old-space-size=\d+)$/u;
const safeCliFlag = /^(?:--no-warnings|--expose-gc|--disable-warning=[\w-]+)$/u;

interface ChildObservation {
  readonly file: string;
  readonly root: string;
  readonly recordPath: string;
  readonly created: readonly string[];
  readonly entry?: string;
}

const pipeOrIgnore = (entry: unknown) =>
  entry === undefined ||
  entry === null ||
  entry === "pipe" ||
  entry === "ignore" ||
  entry === "overlapped";
const safeChildStdio = (stdio: unknown) =>
  Array.isArray(stdio)
    ? stdio.every((entry, index) => pipeOrIgnore(entry) || (index === 3 && entry === "ipc"))
    : pipeOrIgnore(stdio);

function childInvocation(
  observation: Observation,
  file: unknown,
  args: readonly unknown[],
  cwdValue: unknown,
  env: ReadonlyMap<string, string>,
  stdio: unknown,
) {
  if (
    observation.child ||
    file !== process.execPath ||
    !safeChildStdio(stdio) ||
    (process.versions.electron && env.get("ELECTRON_RUN_AS_NODE") !== "1") ||
    env
      .get("NODE_OPTIONS")
      ?.trim()
      .split(/\s+/u)
      .some((flag) => flag && !inheritedNodeOption.test(flag)) ||
    [...env.keys()].some((name) =>
      /^(?:DYLD_|LD_|NODE_ICU_DATA$|NODE_V8_COVERAGE$|OPENSSL_CONF$)/u.test(name),
    )
  )
    return;
  const cwd = cwdValue == null ? process.cwd() : processPath(cwdValue);
  if (!cwd) return;
  const ca = env.get("NODE_EXTRA_CA_CERTS");
  // The suite validates the inherited CA file; changing its spelling or cwd
  // can make Node open a different file before the preload runs.
  if (ca && (ca !== inheritedCa || (!path.isAbsolute(ca) && cwd !== observation.root))) return;
  const withinCreated = (filename: string) => {
    const canonical = tryRealpath(filename);
    return [...observation.created].some((created) => inside(created, canonical));
  };
  if (!withinCreated(cwd) && classify(observation, cwd) !== cwd) return;
  const entryArgument = args.findIndex((arg) => typeof arg !== "string" || !safeCliFlag.test(arg));
  if (entryArgument < 0) return;
  const first = args[entryArgument];
  if (typeof first !== "string") return;
  const entry =
    !first.startsWith("-") && /\.[cm]?[jt]s$/u.test(first) ? path.resolve(cwd, first) : undefined;
  if (!entry && (first !== "-e" || typeof args[entryArgument + 1] !== "string")) return;
  if (entry) {
    if (!withinCreated(entry) && (!inside(observation.root, entry) || tryRealpath(entry) !== entry))
      return;
    // Node searches extensions for a missing CJS main. Accept a real entry file.
    if (!raw.stat(entry, { throwIfNoEntry: false })?.isFile()) return;
  }
  const child: ChildObservation = {
    file: observation.file,
    root: observation.root,
    recordPath: path.join(observation.directory, "children", randomUUID() + ".json"),
    created: [...observation.created],
    entry,
  };
  const input = child.recordPath + ".input";
  raw.mkdir(path.dirname(input), { recursive: true });
  raw.writeFile(input, JSON.stringify(child));
  return {
    // CLI preload runs before the entry even if the caller supplied a minimal env.
    args: ["--import", pathToFileURL(import.meta.filename).href, ...args],
    input,
    collect() {
      try {
        const result = JSON.parse(raw.readFile(child.recordPath, "utf8")) as TestObservation;
        if (result.version !== 2 || result.file !== observation.file)
          throw new Error("Wrong child observation");
        for (const [reason, details] of Object.entries(result.unobservable))
          for (const detail of details) block(observation, reason as Reason, detail);
        for (const read of result.reads) observation.reads.add(read);
        for (const candidate of result.missingModuleCandidates)
          observation.missingModuleCandidates.add(candidate);
        for (const entry of [...result.pathEvidence, ...result.listings]) {
          const { mode, recursive, bufferSize } = entry.evidence;
          const key = JSON.stringify([entry.path, entry.kind, mode, recursive, bufferSize]);
          const previous = observation.snapshots.get(key);
          if (previous && JSON.stringify(previous.evidence) !== JSON.stringify(entry.evidence))
            block(observation, "unstable filesystem input", entry.path);
          observation.snapshots.set(key, entry);
        }
        observation.nativeResolution ||= result.nativeResolution;
      } catch {
        block(observation, "subprocess", "missing or unreadable Node child observation");
      }
    },
  };
}

function hookChildProcess() {
  intercept(childProcess.ChildProcess.prototype, "spawn", {
    apply(original, receiver: childProcess.ChildProcess, args) {
      const observation = current();
      if (!observation) return Reflect.apply(original, receiver, args);
      const options = args[0] as
        | {
            file?: string;
            args?: string[];
            cwd?: string;
            envPairs?: string[];
            stdio?: unknown;
          }
        | undefined;
      let child: ReturnType<typeof childInvocation>;
      if (options?.args && Array.isArray(options.envPairs)) {
        const env = new Map(
          options.envPairs.map((pair) => {
            const i = pair.indexOf("=");
            return [pair.slice(0, i), pair.slice(i + 1)];
          }),
        );
        try {
          child = withinRecorder(() =>
            childInvocation(
              observation,
              options.file,
              options.args!.slice(1),
              options.cwd,
              env,
              options.stdio,
            ),
          );
        } catch {
          // Qualification is optional. Let Node handle the caller's original invocation.
        }
      }
      if (!child || !options?.args || !options.envPairs) {
        subprocess(observation, options?.file);
        return Reflect.apply(original, receiver, args);
      }
      const normalized = {
        ...options,
        args: [options.args[0], ...child.args],
        envPairs: [
          ...options.envPairs.filter((pair) => !pair.startsWith(childObservationEnv + "=")),
          childObservationEnv + "=" + child.input,
        ],
      };
      const collect = child.collect;
      observation.pendingChildren++;
      const completed = (code: number | null) => {
        observation.pendingChildren--;
        if (code === 0) withinRecorder(collect);
        else subprocess(observation, options.file);
      };
      receiver.prependOnceListener("close", completed);
      try {
        return Reflect.apply(original, receiver, [normalized]);
      } catch (error) {
        receiver.removeListener("close", completed);
        completed(null);
        throw error;
      }
    },
  });
}

function loopback(host: string) {
  const name = host.toLowerCase().replace(/^\[|\]$|\.$/gu, "");
  if (name === "localhost" || name === "::1") return true;
  if (net.isIPv4(name)) return name.startsWith("127.");
  if (!net.isIPv6(name)) return false;
  const normalized = new URL("http://[" + name + "]").hostname;
  return normalized === "[::1]" || /^\[::ffff:7f[\da-f]{2}:/u.test(normalized);
}

function connect(observation: Observation, host: unknown) {
  if (observation.child || typeof host !== "string" || !loopback(host))
    block(observation, "network", typeof host === "string" ? host : "<unknown host>");
}

function urlHost(value: unknown) {
  const url = typeof value === "object" && value && "url" in value ? value.url : value;
  if (typeof url !== "string" && !(url && typeof url === "object" && "href" in url)) return;
  try {
    return new URL(typeof url === "string" ? url : String(url.href)).hostname;
  } catch {
    return;
  }
}

function inspectDestination(observation: Observation, args: unknown[]) {
  const first = Array.isArray(args[0]) ? (args[0][0] as unknown) : args[0];
  if (typeof first === "number")
    return connect(
      observation,
      typeof args[1] === "string"
        ? args[1]
        : ((args[1] as ConnectionOptions | undefined)?.host ?? "localhost"),
    );
  if (first && typeof first === "object") {
    const options = first as net.TcpNetConnectOpts & net.IpcNetConnectOpts & ConnectionOptions;
    if (options.path || options.socket) {
      if (observation.child) block(observation, "network", "Node child socket");
      return;
    }
    return connect(observation, options.host ?? options.servername ?? "localhost");
  }
  if (typeof first !== "string") return connect(observation, undefined);
  // net.connect accepts numeric strings as ports and other strings as local IPC paths.
  if (observation.child || /^\d+$/u.test(first))
    connect(
      observation,
      typeof args[1] === "string"
        ? args[1]
        : ((args[1] as ConnectionOptions | undefined)?.host ?? "localhost"),
    );
}

function onCall(
  owner: object,
  method: string,
  call: (observation: Observation, args: unknown[]) => void,
) {
  observe(owner, method, "sync", (observation, args) => call(observation, args));
}

function hookSyncChild(method: "spawnSync" | "execFileSync") {
  intercept(childProcess, method, {
    apply(original, receiver, args) {
      const observation = current();
      if (!observation) return Reflect.apply(original, receiver, args);
      const [file, argv, opts] = args;
      const options = (Array.isArray(argv) ? opts : argv) as
        | {
            shell?: string | boolean;
            cwd?: string | URL;
            env?: NodeJS.ProcessEnv;
            stdio?: unknown;
          }
        | undefined;
      let child: ReturnType<typeof childInvocation>;
      const originalEnv = options?.env ?? process.env;
      if (!options?.shell && Array.isArray(argv)) {
        try {
          const env = new Map<string, string>();
          // Node accepts inherited enumerable environment keys as well.
          for (const name in originalEnv) {
            if (originalEnv[name] !== undefined) env.set(name, String(originalEnv[name]));
          }
          child = withinRecorder(() =>
            childInvocation(observation, file, argv, options?.cwd, env, options?.stdio),
          );
          if (child) {
            const nextOptions = {
              ...options,
              env: { ...Object.fromEntries(env), [childObservationEnv]: child.input },
            };
            const result: unknown = Reflect.apply(original, receiver, [
              file,
              child.args,
              nextOptions,
            ]);
            if (method === "execFileSync" || (result as { status?: number })?.status === 0)
              withinRecorder(child.collect);
            else subprocess(observation, file);
            return result;
          }
        } catch (error) {
          if (child) {
            subprocess(observation, file);
            throw error;
          }
          // Let the original function validate options that we cannot inspect.
        }
      }
      subprocess(observation, options?.shell ? shellExecutable(options.shell) : file);
      return Reflect.apply(original, receiver, args);
    },
  });
}

const shellExecutable = (shell: unknown) =>
  typeof shell === "string"
    ? shell
    : process.platform === "win32"
      ? (process.env.ComSpec ?? "cmd.exe")
      : "/bin/sh";

function hookExecution() {
  hookChildProcess();
  onCall(process, "execve", (observation, [file]) => subprocess(observation, file));
  hookSyncChild("spawnSync");
  hookSyncChild("execFileSync");
  onCall(childProcess, "execSync", (observation, [, options]) =>
    subprocess(observation, shellExecutable((options as { shell?: string } | undefined)?.shell)),
  );
  intercept(workers, "Worker", {
    construct(original, args, target) {
      const observation = current();
      if (observation)
        block(
          observation,
          "worker",
          (args[1] as workers.WorkerOptions | undefined)?.eval
            ? "<eval>"
            : (processPath(args[0]) ?? "<unknown>"),
        );
      return Reflect.construct(original, args, target);
    },
  });
  onCall(process, "dlopen", (observation, [, file]) => {
    const filename = processPath(file);
    block(observation, "native addon", filename ?? "<unknown>");
  });
}

function hookNetwork() {
  // Node's HTTP ESM facade reads lazy exports and initializes Undici even for
  // filesystem-only children. Patch the underlying builtin exports directly.
  const http = process.getBuiltinModule("node:http");
  const https = process.getBuiltinModule("node:https");
  const http2 = process.getBuiltinModule("node:http2");
  const tls = process.getBuiltinModule("node:tls");
  onCall(net.Socket.prototype, "connect", inspectDestination);
  intercept(net.Socket.prototype, "emit", {
    apply(original, receiver, args) {
      if (args[0] === "lookup" && typeof args[2] === "string") {
        const observation = current();
        if (observation) connect(observation, args[2]);
      }
      return Reflect.apply(original, receiver, args);
    },
  });
  onCall(tls, "connect", inspectDestination);
  for (const protocol of [http, https])
    for (const method of ["request", "get"]) {
      onCall(protocol, method, (observation, args) => {
        const [first, second] = args;
        const options = (second && typeof second === "object" ? second : first) as
          | RequestOptions
          | undefined;
        if (!options?.socketPath)
          connect(observation, options?.hostname ?? options?.host ?? urlHost(first) ?? "localhost");
      });
    }
  onCall(http2, "connect", (observation, [authority]) => connect(observation, urlHost(authority)));
  onCall(dgram.Socket.prototype, "connect", (observation, [, address]) =>
    connect(observation, typeof address === "string" ? address : "localhost"),
  );
  for (const method of ["send", "sendto"]) {
    onCall(
      dgram.Socket.prototype,
      method,
      (observation, [, offsetOrPort, lengthOrAddress, port, address]) => {
        if (typeof address === "string") connect(observation, address);
        else if (
          typeof port !== "number" &&
          typeof lengthOrAddress === "string" &&
          typeof offsetOrPort === "number"
        )
          connect(observation, lengthOrAddress);
      },
    );
  }
  // Also sees Undici's requests after redirects and requests from its direct clients.
  channel("undici:request:create").subscribe((message) => {
    const observation = current();
    if (observation)
      connect(observation, urlHost((message as { request?: { origin?: string } }).request?.origin));
  });
}

function hookNativeFilesystem() {
  const sqlite = process.getBuiltinModule("node:sqlite");
  if (!sqlite) return;
  // SQLite can open database and journal files below the JavaScript filesystem API.
  intercept(sqlite, "DatabaseSync", {
    construct(original, args, target) {
      const observation = current();
      const [location] = args;
      if (observation && location !== ":memory:") {
        const filename = processPath(location);
        if (!filename || withinRecorder(() => classify(observation, filename)))
          block(observation, "native filesystem", "SQLite database");
      }
      return Reflect.construct(original, args, target);
    },
  });
  onCall(sqlite.DatabaseSync.prototype, "loadExtension", (observation) =>
    block(observation, "native addon", "SQLite extension"),
  );
}

// Node's CJS resolve hook does not expose require.resolve({ paths }) or the
// global lookup directories. The pinned loader passes the actual search list
// here, after trying package self-resolution. If the seam changes, the public
// resolve hook still treats the failed lookup as opaque.
const cjs = Module as typeof Module & { _extensions: Record<string, unknown> };
let cjsLookup: { specifier: string; missing?: readonly string[] } | undefined;
const barePackage = /^(?:@[\w.-]+\/)?[\w][\w.-]*$/u;

export function missingModuleCandidate(filename: string) {
  try {
    raw.lstat(filename);
    return false;
  } catch (error) {
    return missing(error);
  }
}

function cjsMissingCandidates(request: string, directories: unknown) {
  const absolute = path.isAbsolute(request);
  const direct = absolute || /^\.\.?\//u.test(request);
  if ((!direct && !barePackage.test(request)) || /[\\%?#]|\/$/u.test(request)) return;
  if (!absolute && (!Array.isArray(directories) || !directories.length)) return;
  const extensions = Object.keys(cjs._extensions);
  if (extensions.some((extension) => !/^\.[\w.]+$/u.test(extension))) return;
  const candidates: string[] = [];
  for (const directory of absolute ? [""] : (directories as unknown[])) {
    if (typeof directory !== "string" || (!absolute && !path.isAbsolute(directory))) return;
    const base = path.resolve(directory, request);
    // A present package or directory can redirect through exports or its main
    // field. Only the wholly absent branch is closed by this candidate set.
    candidates.push(base, ...extensions.map((extension) => base + extension));
  }
  if (candidates.every(missingModuleCandidate)) return candidates;
}

function esmMissingCandidates(request: string, importer: string) {
  if (!barePackage.test(request)) return;
  // ESM searches node_modules up the importing file's ancestry, with no CJS
  // global folders. A present package is allowed to redirect via exports.
  const candidates: string[] = [];
  for (let directory = path.dirname(importer); ; directory = path.dirname(directory)) {
    candidates.push(path.join(directory, "node_modules", request));
    if (directory === path.dirname(directory)) break;
  }
  if (candidates.every(missingModuleCandidate)) return candidates;
}

function recordPackageScope(observation: Observation, importer: string) {
  if (inside(virtualStore, importer)) return true;
  if (!inside(observation.root, importer) || tryRealpath(importer) !== importer) return false;
  for (
    let directory = path.dirname(importer);
    inside(observation.root, directory);
    directory = path.dirname(directory)
  ) {
    const manifest = path.join(directory, "package.json");
    const evidence = recordRead(observation, manifest, "content", undefined);
    if (evidence?.state === "file") return true;
    if (evidence?.state !== "absent" || directory === observation.root) return false;
  }
  return false;
}

function recordFailedResolution(
  observation: Observation,
  specifier: string,
  context: { parentURL?: string; conditions?: readonly string[] },
  cjsCandidates: readonly string[] | undefined,
  error: unknown,
) {
  const failure = error as (NodeJS.ErrnoException & { url?: string }) | null;
  const parent = processPath({ href: context.parentURL });
  const commonJS = context.conditions?.includes("require");
  const explicitPath = /^(?:\.\.?\/|\/|file:)/u.test(specifier);
  if (!commonJS && failure?.code === "ERR_MODULE_NOT_FOUND" && failure.url && explicitPath) {
    const filename = processPath({ href: failure.url });
    if (!filename || !inside(observation.root, filename)) return false;
    return recordRead(observation, filename, "content", undefined)?.state === "absent";
  }
  if (!parent) return false;
  const candidates =
    commonJS && failure?.code === "MODULE_NOT_FOUND"
      ? cjsCandidates
      : !commonJS && failure?.code === "ERR_MODULE_NOT_FOUND" && !failure.url
        ? esmMissingCandidates(specifier, parent)
        : undefined;
  if (!candidates || !recordPackageScope(observation, parent)) return false;
  for (const candidate of candidates) observation.missingModuleCandidates.add(candidate);
  return true;
}

function hookNativeResolution() {
  intercept(cjs, "_findPath", {
    apply(original, receiver, args) {
      const result: unknown = Reflect.apply(original, receiver, args);
      const lookup = cjsLookup;
      if (lookup && result === false && args[0] === lookup.specifier)
        lookup.missing = withinRecorder(() => cjsMissingCandidates(lookup.specifier, args[1]));
      return result;
    },
  });
  registerHooks({
    resolve(specifier, context, next) {
      const observation = current();
      if (!observation) return next(specifier, context);
      const previousLookup = cjsLookup;
      const lookup = { specifier, missing: undefined as readonly string[] | undefined };
      cjsLookup = context.conditions?.includes("require") ? lookup : undefined;
      try {
        const result = next(specifier, context);
        if (result.url.startsWith("node:") || result.url.startsWith(virtualStoreUrl)) return result;
        const filename = processPath({ href: result.url });
        if (filename === import.meta.filename) return result;
        if (filename) {
          if (withinRecorder(() => recordRead(observation, filename, "content", undefined)))
            observation.nativeResolution = true;
        } else {
          const scheme = /^[\w+.-]+:/u.exec(result.url)?.[0] ?? "<unknown>";
          block(observation, "module resolution", "untracked native module URL " + scheme);
        }
        return result;
      } catch (error) {
        withinRecorder(() => {
          try {
            if (recordFailedResolution(observation, specifier, context, lookup.missing, error))
              return;
          } catch {
            // Keep the original loader error when it cannot be fingerprinted.
          }
          const request = barePackage.test(specifier) ? " " + specifier : "";
          const code = (error as NodeJS.ErrnoException | null)?.code ?? "failed native lookup";
          block(observation, "module resolution", code + request);
        });
        throw error;
      } finally {
        cjsLookup = previousLookup;
      }
    },
  });
}

// Node preloads the hooks before Vitest's VM loader snapshots named builtin exports.
if (process.env.NODEX_TEST_OBSERVATIONS || process.env[childObservationEnv]) {
  hookFilesystem();
  hookExecution();
  hookNetwork();
  syncBuiltinESMExports();
}

/** The first setup file starts recording after Vitest creates the worker environment. */
export function beginTestObservation(
  file: string,
  pool: string,
  directory: string,
  realm: typeof globalThis,
) {
  if (active?.child) {
    block(active, "file attribution", "nested test runner");
    return;
  }
  if (active) {
    block(active, "file attribution", "overlapping setup");
    endTestObservation(path.resolve(active.root, active.file));
  }
  if (!nativeHooksInstalled) {
    hookNativeResolution();
    hookNativeFilesystem();
    syncBuiltinESMExports();
    nativeHooksInstalled = true;
  }
  // Fresh isolated workers have no previous file whose async resources need attribution.
  if (!tracing && (pool === "vmForks" || pool === "vmThreads")) {
    createHook({
      init(id, _type, trigger) {
        if (internal) return;
        const origin = origins.get(trigger);
        const owner = origin?.finished ? origin : active;
        if (owner) origins.set(id, owner);
      },
      destroy(id) {
        origins.delete(id);
      },
    }).enable();
    tracing = true;
  }
  const root = process.env.NODEX_TEST_OBSERVATION_ROOT ?? repositoryRoot;
  const name = relative(root, file);
  active = newObservation(
    name,
    pool,
    root,
    path.join(directory, digest(name) + "-" + randomUUID() + ".json"),
  );
  onCall(realm, "fetch", (observation, [request]) => {
    const host = urlHost(request);
    if (host) connect(observation, host);
  });
}

function newObservation(file: string, pool: string, root: string, recordPath: string): Observation {
  return {
    file,
    recordPath,
    pool,
    root,
    directory: path.dirname(recordPath),
    temporary: [...new Set([os.tmpdir(), "/tmp"].map((value) => tryRealpath(path.resolve(value))))],
    created: new Set(),
    descriptors: new Map(),
    reads: new Set(),
    ignored: [
      virtualStore,
      path.join(root, "node_modules", ".vite"),
      path.join(root, "node_modules", ".vite-temp"),
      path.join(root, "node_modules", ".vitest-cache"),
      ...(JSON.parse(process.env.NODEX_TEST_TRANSFORM_CACHES ?? "[]") as string[]).flatMap(
        (directory) => [directory, tryRealpath(directory)],
      ),
    ],
    snapshots: new Map(),
    nativeResolution: false,
    missingModuleCandidates: new Set(),
    reasons: new Map(),
    pending: 0,
    pendingChildren: 0,
    finished: false,
  };
}

function beginChildObservation(input: string) {
  const child = JSON.parse(raw.readFile(input, "utf8")) as ChildObservation;
  delete process.env[childObservationEnv];
  // A descendant must prove its own work. Until there is a transitive merge
  // protocol, a child that launches anything reports an opaque operation.
  const observation = {
    ...newObservation(child.file, "child", child.root, child.recordPath),
    child: true,
  };
  for (const filename of child.created) observation.created.add(filename);
  hookNativeResolution();
  hookNativeFilesystem();
  onCall(Module, "register", (owner) => block(owner, "module resolution", "custom loader"));
  onCall(Module, "registerHooks", (owner) => block(owner, "module resolution", "custom loader"));
  onCall(process, "binding", (owner) =>
    block(owner, "native filesystem", "Node child process binding"),
  );
  onCall(net.Server.prototype, "listen", (owner) => block(owner, "network", "Node child listener"));
  onCall(dgram.Socket.prototype, "bind", (owner) => block(owner, "network", "Node child listener"));
  onCall(process, "loadEnvFile", (owner) =>
    block(owner, "native filesystem", "Node child environment file"),
  );
  onCall(globalThis, "fetch", (owner, [request]) => {
    const host = urlHost(request);
    if (host) connect(owner, host);
  });
  syncBuiltinESMExports();
  active = observation;
  if (child.entry) recordRead(observation, child.entry, "content", undefined);

  // Observe exit handlers too. Abrupt termination, or a child that never
  // completes, cannot publish a usable observation.
  intercept(process, "emit", {
    apply(original, receiver, args) {
      if (args[0] !== "exit" || !(process as NodeJS.Process & { _exiting?: boolean })._exiting)
        return Reflect.apply(original, receiver, args);
      const result: unknown = Reflect.apply(original, receiver, args);
      if (args[1] === 0) endTestObservation(path.resolve(child.root, child.file));
      return result;
    },
  });
}

const childObservation = process.env[childObservationEnv];
if (childObservation) beginChildObservation(childObservation);

/** Runs after Vitest has awaited file hooks and snapshot writes. */
export function endTestObservation(file: string) {
  if (!active) return;
  const observation = active;
  active = undefined;
  if (observation.file !== relative(observation.root, file))
    block(observation, "file attribution", "unexpected file end");
  if (observation.pendingChildren)
    block(observation, "subprocess", "Node child was still running at file end");
  if (observation.pending)
    block(observation, "unfinished filesystem operation", String(observation.pending));
  observation.finished = true;
  publish(observation);
}
