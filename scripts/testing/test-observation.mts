import { executionAsyncId, createHook } from "node:async_hooks";
import childProcess from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import dgram from "node:dgram";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import workers from "node:worker_threads";

type PathState = "absent" | "file" | "directory";
type ReadKind =
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
  | "file attribution";

interface PathEvidence {
  readonly state: PathState;
  readonly error?: string;
  readonly digest?: string;
  readonly target?: string;
  readonly mode?: number;
  readonly recursive?: boolean;
}

interface Observation {
  readonly file: string;
  readonly recordPath: string;
  readonly pool: string;
  readonly root: string;
  readonly directory: string;
  readonly temporary: readonly string[];
  readonly created: Set<string>;
  readonly descriptors: Map<number, { path: string; identity: string }>;
  readonly reads: Map<string, string>;
  readonly nativeAddons: Set<string>;
  readonly snapshots: Map<string, { path: string; kind: ReadKind; evidence: PathEvidence }>;
  readonly reasons: Map<Reason, Set<string>>;
  pending: number;
  finished: boolean;
}

// Native, host-realm originals. The recorder and its output must never become inputs.
const raw = {
  stat: fs.statSync,
  lstat: fs.lstatSync,
  fstat: fs.fstatSync,
  access: fs.accessSync,
  realpath: fs.realpathSync.native,
  readFile: fs.readFileSync,
  readlink: fs.readlinkSync,
  readdir: fs.readdirSync,
  opendir: fs.opendirSync,
  mkdir: fs.mkdirSync,
  writeFile: fs.writeFileSync,
  rename: fs.renameSync,
};
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
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
  const install = path.join(root, "node_modules");
  if (!inside(install, canonical)) return false;
  const first = relative(install, canonical).split("/")[0];
  // Tests and tools also put independent outputs under node_modules/.cache.
  return !first.startsWith(".") || first === ".pnpm";
}
const isListing = (kind: ReadKind): kind is "readdir" | "opendir" =>
  kind === "readdir" || kind === "opendir";
const identity = (stat: fs.BigIntStats) => `${stat.dev}:${stat.ino}`;
// Normalizing an unresolved parent segment can change the meaning of a path through a symlink.
const resolvePath = (name: string) =>
  name && !name.split(process.platform === "win32" ? /[\\/]/u : /\//u).includes("..")
    ? path.resolve(name)
    : undefined;
const processPath = (value: unknown) => {
  try {
    if (Buffer.isBuffer(value)) {
      const decoded = value.toString();
      return Buffer.from(decoded).equals(value) ? resolvePath(decoded) : undefined;
    }
    if (typeof value === "string")
      return value.length && !value.split(path.sep).includes("..")
        ? path.resolve(value)
        : undefined;
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
    version: 1,
    file,
    pool,
    worker: { pid: process.pid, threadId: workers.threadId },
    reads: Object.fromEntries(reads),
    nativeAddons: [...observation.nativeAddons].sort(),
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
  const origin = origins.get(executionAsyncId());
  if (!origin?.finished) return active;
  block(origin, "file attribution", "operation after the file finished");
  return undefined;
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

function classify(observation: Observation, filename: string) {
  const canonical = tryRealpath(filename);
  const { root, temporary, created } = observation;
  if (created.has(filename) && filename === canonical) return;
  if (coveredByInstall(root, filename, canonical)) return;
  if (
    !inside(root, filename) &&
    !inside(root, canonical) &&
    temporary.some((directory) => inside(directory, canonical))
  )
    return;
  if (inside(root, filename) && inside(root, canonical)) return canonical;
  block(observation, "external filesystem", filename);
}

function listDirectory(filename: string, kind: "readdir" | "opendir", recursive: boolean) {
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
  const directory = raw.opendir(filename, { recursive });
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync())
      entries.push(encode(entry));
  } finally {
    directory.closeSync();
  }
  return entries;
}

function pathSnapshot(filename: string, kind: ReadKind, options: unknown): PathEvidence {
  const flags = options && typeof options === "object" ? options : {};
  const recursive = isListing(kind) && "recursive" in flags && flags.recursive === true;
  const mode = kind === "access" && typeof options === "number" ? options : undefined;
  const replay = { ...(recursive ? { recursive } : {}), ...(mode === undefined ? {} : { mode }) };
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
    if (kind === "content")
      return state === "file" ? { state, digest: digest(raw.readFile(filename)) } : { state };
    if (!isListing(kind)) throw new Error("Unsupported read operation");
    const entries = state === "directory" ? listDirectory(filename, kind, recursive) : [];
    return { state, digest: digest(JSON.stringify(entries)), ...replay };
  } catch (error) {
    if (!missing(error)) throw error;
    return { state: "absent", error: (error as NodeJS.ErrnoException).code, ...replay };
  }
}

function recordRead(observation: Observation, filename: string, kind: ReadKind, options: unknown) {
  try {
    const canonical = classify(observation, filename);
    if (!canonical) return;
    const name = relative(observation.root, filename) || ".";
    const snapshot = pathSnapshot(filename, kind, options);
    const evidence =
      canonical === filename
        ? snapshot
        : {
            ...snapshot,
            target: snapshot.target ?? relative(observation.root, canonical),
          };
    const key = JSON.stringify([name, kind, evidence.mode, evidence.recursive]);
    const previous = observation.snapshots.get(key);
    if (previous && JSON.stringify(previous.evidence) !== JSON.stringify(evidence)) {
      block(observation, "unstable filesystem input", name);
      return;
    }
    // Two operations can follow symlinks differently. Preserve both pieces of evidence.
    observation.snapshots.set(key, { path: name, kind, evidence });
    if (kind === "content" && evidence.digest) observation.reads.set(name, evidence.digest);
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

function observe(owner: object, method: string, api: Api, inspect: Inspect) {
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
      if (!complete) return Reflect.apply(original, receiver, args);
      if (api === "sync")
        return withinRecorder(() => {
          const result: unknown = Reflect.apply(original, receiver, args);
          complete(result);
          return result;
        });
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
    return (result) => {
      if (
        (method === "readFile" && Buffer.isBuffer(result) && digest(result) !== before.digest) ||
        (kind === "exists" && typeof result === "boolean" && result !== (before.state !== "absent"))
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
  if (inside(observation.root, filename) && tryRealpath(filename) === filename)
    observation.created.add(filename);
}

function openOperation(observation: Observation, [value, flags]: unknown[]): Completion | void {
  const filename = inputPath(observation, value, "open");
  if (!filename) return;
  const creates = createsFile(flags) && absentPath(filename);
  if (!creates) recordRead(observation, filename, "exists", undefined);
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
    if (!filename || !inside(observation.root, filename)) return;
    if (["rm", "rmdir", "unlink", "rename"].includes(method)) {
      const removed = processPath(args[0]);
      if (removed)
        for (const created of observation.created)
          if (inside(removed, created)) observation.created.delete(created);
    }
    if (
      ["rm", "rmdir", "unlink", "cp", "symlink", "link"].includes(method) ||
      !absentPath(filename)
    )
      return;
    return (firstCreated) => {
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
    observe(fs, method + "Sync", "sync", readOperation(method, kind));
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
    if (!name || !inside(observation.root, name)) return;
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

function loopback(host: string) {
  const name = host.toLowerCase().replace(/^\[|\]$|\.$/gu, "");
  if (name === "localhost" || name === "::1") return true;
  if (net.isIPv4(name)) return name.startsWith("127.");
  if (!net.isIPv6(name)) return false;
  const normalized = new URL("http://[" + name + "]").hostname;
  return normalized === "[::1]" || /^\[::ffff:7f[\da-f]{2}:/u.test(normalized);
}

function connect(observation: Observation, host: unknown) {
  if (typeof host !== "string" || !loopback(host))
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
        : ((args[1] as tls.ConnectionOptions | undefined)?.host ?? "localhost"),
    );
  if (first && typeof first === "object") {
    const options = first as net.TcpNetConnectOpts & net.IpcNetConnectOpts & tls.ConnectionOptions;
    if (options.path || options.socket) return;
    return connect(observation, options.host ?? options.servername ?? "localhost");
  }
  if (typeof first !== "string") return connect(observation, undefined);
  // net.connect accepts numeric strings as ports and other strings as local IPC paths.
  if (/^\d+$/u.test(first))
    connect(
      observation,
      typeof args[1] === "string"
        ? args[1]
        : ((args[1] as tls.ConnectionOptions | undefined)?.host ?? "localhost"),
    );
}

function onCall(
  owner: object,
  method: string,
  call: (observation: Observation, args: unknown[]) => void,
) {
  observe(owner, method, "sync", (observation, args) => call(observation, args));
}

function hookExecution() {
  onCall(childProcess.ChildProcess.prototype, "spawn", (observation, [options]) =>
    subprocess(observation, (options as { file?: unknown } | undefined)?.file),
  );
  const shellExecutable = (shell: unknown) =>
    typeof shell === "string"
      ? shell
      : process.platform === "win32"
        ? (process.env.ComSpec ?? "cmd.exe")
        : "/bin/sh";
  for (const method of ["spawnSync", "execFileSync"]) {
    onCall(childProcess, method, (observation, [file, argsOrOptions, options]) => {
      const { shell } =
        ((Array.isArray(argsOrOptions) ? options : argsOrOptions) as {
          shell?: unknown;
        }) ?? {};
      subprocess(observation, shell ? shellExecutable(shell) : file);
    });
  }
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
    if (filename && coveredByInstall(observation.root, filename, tryRealpath(filename))) {
      observation.nativeAddons.add(relative(observation.root, filename));
      return;
    }
    block(observation, "native addon", filename ?? "<unknown>");
  });
}

function hookNetwork() {
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
          | http.RequestOptions
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

// Node preloads the hooks before Vitest's VM loader snapshots named builtin exports.
if (process.env.NODEX_TEST_OBSERVATIONS) {
  hookFilesystem();
  hookExecution();
  hookNetwork();
  syncBuiltinESMExports();
}

let tracing = false;

/** The first setup file starts recording after Vitest creates the worker environment. */
export function beginTestObservation(
  file: string,
  pool: string,
  directory: string,
  realm: typeof globalThis,
) {
  if (active) {
    block(active, "file attribution", "overlapping setup");
    endTestObservation(path.resolve(active.root, active.file));
  }
  if (!tracing) {
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
  const root = repositoryRoot;
  active = {
    file: relative(root, file),
    recordPath: path.join(directory, digest(relative(root, file)) + "-" + randomUUID() + ".json"),
    pool,
    root,
    directory,
    temporary: [...new Set([os.tmpdir(), "/tmp"].map((value) => tryRealpath(path.resolve(value))))],
    created: new Set(),
    descriptors: new Map(),
    reads: new Map(),
    nativeAddons: new Set(),
    snapshots: new Map(),
    reasons: new Map(),
    pending: 0,
    finished: false,
  };
  onCall(realm, "fetch", (observation, [request]) => {
    const host = urlHost(request);
    if (host) connect(observation, host);
  });
}

/** Runs after Vitest has awaited file hooks and snapshot writes. */
export function endTestObservation(file: string) {
  if (!active) return;
  const observation = active;
  active = undefined;
  if (observation.file !== relative(observation.root, file))
    block(observation, "file attribution", "unexpected file end");
  if (observation.pending)
    block(observation, "unfinished filesystem operation", String(observation.pending));
  observation.finished = true;
  publish(observation);
}
