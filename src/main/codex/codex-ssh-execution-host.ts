import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { CodexSshExecutionHostConfig } from "../../shared/types";
import type { CodexAppServerClientOptions } from "../platform/node/CodexProcessExecutionHost";
import { codexCliAppServerArgs } from "../../shared/codex-app-server-launch";
import {
  describeCodexTransferFile,
  sanitizeCodexTransferToken,
  type CodexExecutionHostFileDescriptor,
  type CodexExecutionHostFileTransferPort,
} from "./codex-execution-host-file-transfer";

const MAX_CONTROL_OUTPUT_BYTES = 1024 * 1024;
const MAX_HANDOFF_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const SSH_CONNECT_TIMEOUT_SECONDS = 10;

export interface CodexSshExecutionHostHealth {
  readonly hostId: string;
  readonly home: string;
  readonly codexHome: string;
  readonly platform: "darwin" | "linux";
  readonly architecture: string;
  readonly nodeVersion: string;
  readonly gitVersion: string;
  readonly codexVersion: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeCommand(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("-") || /[\r\n\0]/u.test(trimmed)) {
    throw new Error(`Invalid ${label}`);
  }
  if (path.posix.isAbsolute(trimmed)) return trimmed;
  if (!/^[A-Za-z0-9._+-]{1,256}$/u.test(trimmed)) throw new Error(`Invalid ${label}`);
  return trimmed;
}

function absoluteRemotePath(value: string, label: string): string {
  const trimmed = value.trim();
  if (
    !path.posix.isAbsolute(trimmed) ||
    trimmed.includes("\0") ||
    trimmed.includes("\r") ||
    trimmed.includes("\n")
  ) {
    throw new Error(`${label} must be an absolute POSIX path`);
  }
  return path.posix.normalize(trimmed);
}

export function normalizeCodexSshExecutionHostConfig(
  input: CodexSshExecutionHostConfig,
): CodexSshExecutionHostConfig {
  const id = input.id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id) || id === "local") {
    throw new Error("SSH execution host id is invalid or reserved");
  }
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 200)
    throw new Error("SSH execution host display name is required");
  const sshAlias = input.sshAlias.trim();
  if (
    !sshAlias ||
    sshAlias.startsWith("-") ||
    sshAlias.length > 512 ||
    !/^[A-Za-z0-9_.:@\[\]-]+$/u.test(sshAlias)
  ) {
    throw new Error("SSH alias is invalid");
  }
  if (
    input.port !== null &&
    (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535)
  ) {
    throw new Error("SSH port must be between 1 and 65535");
  }
  const repositoryRoots = input.repositoryRoots.map((root) =>
    absoluteRemotePath(root, "Repository root"),
  );
  if (repositoryRoots.length === 0)
    throw new Error("SSH execution host requires at least one repository root");
  if (new Set(repositoryRoots).size !== repositoryRoots.length) {
    throw new Error("SSH execution host repository roots must be unique");
  }
  return {
    id,
    displayName,
    kind: "ssh",
    sshAlias,
    port: input.port,
    managedRoot: absoluteRemotePath(input.managedRoot, "Managed worktree root"),
    repositoryRoots: [...repositoryRoots],
    codexBinary: input.codexBinary === null ? null : safeCommand(input.codexBinary, "Codex binary"),
    codexHome: input.codexHome === null ? null : absoluteRemotePath(input.codexHome, "Codex home"),
    enabled: input.enabled,
  };
}

export function quotePosixShellArgument(value: string): string {
  if (value.includes("\0")) throw new Error("Remote command argument contains NUL");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildCodexSshArguments(
  config: CodexSshExecutionHostConfig,
  remoteArguments: readonly string[],
): string[] {
  const normalized = normalizeCodexSshExecutionHostConfig(config);
  const command = remoteArguments.map(quotePosixShellArgument).join(" ");
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${String(SSH_CONNECT_TIMEOUT_SECONDS)}`,
    "-o",
    "ClearAllForwardings=yes",
    ...(normalized.port === null ? [] : ["-p", String(normalized.port)]),
    normalized.sshAlias,
    command,
  ];
}

const HEALTH_SCRIPT = String.raw`
const cp=require("node:child_process"),os=require("node:os"),path=require("node:path");
const codex=process.argv[1],configuredHome=process.argv[2]||"";
const run=(bin,args)=>{const r=cp.spawnSync(bin,args,{encoding:"utf8",timeout:8000});if(r.error||r.status!==0)throw new Error((r.stderr||r.error?.message||bin+" unavailable").trim());return (r.stdout||r.stderr).trim()};
const platform=process.platform;if(platform!=="darwin"&&platform!=="linux")throw new Error("unsupported remote platform: "+platform);
process.stdout.write(JSON.stringify({home:os.homedir(),codexHome:configuredHome||path.join(os.homedir(),".codex"),platform,architecture:process.arch,nodeVersion:process.version,gitVersion:run("git",["--version"]),codexVersion:run(codex,["--version"])}));
`;

const INSTALL_SCRIPT = String.raw`
const crypto=require("node:crypto"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const expected=process.argv[1],limit=Number(process.argv[2]);const data=fs.readFileSync(0);if(data.length>limit)throw new Error("worker bundle exceeds bound");
if(crypto.createHash("sha256").update(data).digest("hex")!==expected)throw new Error("worker bundle hash mismatch");
const root=path.join(os.homedir(),".nodex","remote-workers");fs.mkdirSync(root,{recursive:true,mode:0o700});const target=path.join(root,expected+".cjs");
if(!fs.existsSync(target)){const temp=target+"."+process.pid+".tmp";fs.writeFileSync(temp,data,{flag:"wx",mode:0o600});fs.renameSync(temp,target)}
fs.chmodSync(target,0o600);process.stdout.write(JSON.stringify({path:target}));
`;

const UPLOAD_SCRIPT = String.raw`
const crypto=require("node:crypto"),fs=require("node:fs"),path=require("node:path");
const root=process.argv[1],operation=process.argv[2],name=process.argv[3],expected=process.argv[4],size=Number(process.argv[5]),limit=Number(process.argv[6]);
const data=fs.readFileSync(0);if(data.length!==size||data.length>limit)throw new Error("handoff upload size mismatch");if(crypto.createHash("sha256").update(data).digest("hex")!==expected)throw new Error("handoff upload hash mismatch");
const dir=path.join(root,"nodex-handoffs",operation);fs.mkdirSync(dir,{recursive:true,mode:0o700});const target=path.join(dir,name),temp=target+"."+process.pid+".tmp";fs.writeFileSync(temp,data,{flag:"wx",mode:0o600});fs.renameSync(temp,target);process.stdout.write(JSON.stringify({path:target}));
`;

const DOWNLOAD_SCRIPT = String.raw`
const fs=require("node:fs"),path=require("node:path");const candidate=path.resolve(process.argv[1]);const roots=JSON.parse(process.argv[2]);if(!roots.some(root=>{const rel=path.relative(path.resolve(root),candidate);return rel===""||(!rel.startsWith("..")&&!path.isAbsolute(rel))}))throw new Error("handoff download path is unauthorized");const stat=fs.lstatSync(candidate);if(!stat.isFile()||stat.isSymbolicLink())throw new Error("handoff download source is not a regular file");fs.createReadStream(candidate).pipe(process.stdout);
`;

const DESCRIBE_SCRIPT = String.raw`
const crypto=require("node:crypto"),fs=require("node:fs"),path=require("node:path");const candidate=path.resolve(process.argv[1]),roots=JSON.parse(process.argv[2]),limit=Number(process.argv[3]);if(!roots.some(root=>{const rel=path.relative(path.resolve(root),candidate);return rel===""||(!rel.startsWith("..")&&!path.isAbsolute(rel))}))throw new Error("handoff describe path is unauthorized");const stat=fs.lstatSync(candidate);if(!stat.isFile()||stat.isSymbolicLink())throw new Error("handoff describe source is not a regular file");if(stat.size>limit)throw new Error("handoff describe exceeds safety bound");const hash=crypto.createHash("sha256"),stream=fs.createReadStream(candidate);stream.on("data",chunk=>hash.update(chunk));stream.on("error",error=>{throw error});stream.on("end",()=>process.stdout.write(JSON.stringify({path:candidate,sha256:hash.digest("hex"),size:stat.size})));
`;

const CLEANUP_SCRIPT = String.raw`
const fs=require("node:fs"),path=require("node:path");const root=process.argv[1],operation=process.argv[2];fs.rmSync(path.join(root,"nodex-handoffs",operation),{recursive:true,force:true});
`;

interface BoundedCommandResult {
  readonly stdout: Buffer;
  readonly stderr: string;
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
}

export class CodexSshExecutionHostTransport implements CodexExecutionHostFileTransferPort {
  readonly hostId: string;
  readonly config: CodexSshExecutionHostConfig;
  readonly #sshBinary: string;
  readonly #workerBundlePath: string;
  #health: CodexSshExecutionHostHealth | null = null;
  #remoteWorkerPath: string | null = null;

  constructor(options: {
    readonly config: CodexSshExecutionHostConfig;
    readonly workerBundlePath: string;
    readonly sshBinary?: string;
  }) {
    this.config = normalizeCodexSshExecutionHostConfig(options.config);
    this.hostId = this.config.id;
    this.#workerBundlePath = path.resolve(options.workerBundlePath);
    this.#sshBinary = options.sshBinary?.trim() || "ssh";
  }

  async probe(signal?: AbortSignal): Promise<CodexSshExecutionHostHealth> {
    const codexBinary = this.config.codexBinary ?? "codex";
    const result = await this.#runRemote(
      ["node", "-e", HEALTH_SCRIPT, codexBinary, this.config.codexHome ?? ""],
      { signal, timeoutMs: 25_000 },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.toString("utf8")) as unknown;
    } catch {
      throw new Error("SSH execution host returned an invalid health response");
    }
    if (
      !isRecord(parsed) ||
      (parsed.platform !== "darwin" && parsed.platform !== "linux") ||
      typeof parsed.home !== "string" ||
      typeof parsed.codexHome !== "string" ||
      typeof parsed.architecture !== "string" ||
      typeof parsed.nodeVersion !== "string" ||
      typeof parsed.gitVersion !== "string" ||
      typeof parsed.codexVersion !== "string"
    ) {
      throw new Error("SSH execution host health response does not match its contract");
    }
    const health: CodexSshExecutionHostHealth = {
      hostId: this.hostId,
      home: absoluteRemotePath(parsed.home, "Remote home"),
      codexHome: absoluteRemotePath(parsed.codexHome, "Remote Codex home"),
      platform: parsed.platform,
      architecture: parsed.architecture,
      nodeVersion: parsed.nodeVersion,
      gitVersion: parsed.gitVersion,
      codexVersion: parsed.codexVersion,
    };
    this.#health = health;
    return health;
  }

  async openWorktreeWorker(signal?: AbortSignal): Promise<ChildProcessWithoutNullStreams> {
    const workerPath = await this.#ensureWorkerInstalled(signal);
    return this.spawnRemote(["node", workerPath, this.hostId]);
  }

  async ensureReady(signal?: AbortSignal): Promise<CodexSshExecutionHostHealth> {
    const health = await this.probe(signal);
    await this.#ensureWorkerInstalled(signal);
    return health;
  }

  spawnRemote(remoteArguments: readonly string[]): ChildProcessWithoutNullStreams {
    return spawn(this.#sshBinary, buildCodexSshArguments(this.config, remoteArguments), {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  appServerClientOptions(): CodexAppServerClientOptions {
    const codexBinary = this.config.codexBinary ?? "codex";
    return {
      binaryPath: this.#sshBinary,
      args: buildCodexSshArguments(this.config, [codexBinary, ...codexCliAppServerArgs()]),
      expectedCodexHome: undefined,
      initializeTimeoutMs: 30_000,
      requestTimeoutMs: 180_000,
      missingBinaryMessage: `SSH execution host ${this.config.displayName} is unavailable.`,
      clientInfo: { name: "nodex", title: "Nodex", version: "0.5.0" },
    };
  }

  async describe(
    sourcePath: string,
    signal?: AbortSignal,
  ): Promise<CodexExecutionHostFileDescriptor> {
    const health = this.#health ?? (await this.probe(signal));
    const result = await this.#runRemote(
      [
        "node",
        "-e",
        DESCRIBE_SCRIPT,
        absoluteRemotePath(sourcePath, "Remote transfer source"),
        JSON.stringify(this.#authorizedTransferRoots(health)),
        String(MAX_HANDOFF_FILE_BYTES),
      ],
      { signal, timeoutMs: 10 * 60_000 },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.toString("utf8")) as unknown;
    } catch {
      throw new Error("SSH execution host returned an invalid file descriptor");
    }
    if (
      !isRecord(parsed) ||
      typeof parsed.path !== "string" ||
      typeof parsed.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(parsed.sha256) ||
      typeof parsed.size !== "number" ||
      !Number.isSafeInteger(parsed.size) ||
      parsed.size < 0 ||
      parsed.size > MAX_HANDOFF_FILE_BYTES
    ) {
      throw new Error("SSH execution host file descriptor does not match its contract");
    }
    return {
      path: absoluteRemotePath(parsed.path, "Remote transfer source"),
      sha256: parsed.sha256,
      size: parsed.size,
    };
  }

  async download(input: {
    readonly source: CodexExecutionHostFileDescriptor;
    readonly destinationPath: string;
    readonly signal?: AbortSignal;
  }): Promise<CodexExecutionHostFileDescriptor> {
    if (input.source.size > MAX_HANDOFF_FILE_BYTES)
      throw new Error("Handoff download exceeds the 2 GiB safety bound");
    const health = this.#health ?? (await this.probe(input.signal));
    const authorizedRoots = this.#authorizedTransferRoots(health);
    await mkdir(path.dirname(input.destinationPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${input.destinationPath}.${randomUUID()}.tmp`;
    const child = this.spawnRemote([
      "node",
      "-e",
      DOWNLOAD_SCRIPT,
      input.source.path,
      JSON.stringify(authorizedRoots),
    ]);
    const hash = createHash("sha256");
    let size = 0;
    let stderr = "";
    const abort = () => terminate(child);
    input.signal?.addEventListener("abort", abort, { once: true });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_CONTROL_OUTPUT_BYTES) stderr += chunk;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      hash.update(chunk);
      if (size > MAX_HANDOFF_FILE_BYTES) terminate(child);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
        child.stdout.pipe(output);
        child.on("error", reject);
        child.on("close", (code) => {
          output.end();
          if (input.signal?.aborted) reject(new Error("Request canceled"));
          else if (code !== 0)
            reject(new Error(stderr.trim() || `SSH download exited with code ${String(code)}`));
          else resolve();
        });
      });
      const sha256 = hash.digest("hex");
      if (size !== input.source.size || sha256 !== input.source.sha256) {
        throw new Error("SSH handoff download failed integrity verification");
      }
      await rename(temporaryPath, input.destinationPath);
      return { path: input.destinationPath, sha256, size };
    } finally {
      input.signal?.removeEventListener("abort", abort);
      await rm(temporaryPath, { force: true });
    }
  }

  async upload(input: {
    readonly localPath: string;
    readonly operationId: string;
    readonly fileName: string;
    readonly sha256: string;
    readonly size: number;
    readonly signal?: AbortSignal;
  }): Promise<CodexExecutionHostFileDescriptor> {
    const operationId = sanitizeCodexTransferToken(input.operationId, "handoff operation id");
    const fileName = sanitizeCodexTransferToken(input.fileName, "handoff file name");
    const local = await describeCodexTransferFile(input.localPath, input.signal);
    if (local.sha256 !== input.sha256 || local.size !== input.size) {
      throw new Error("Handoff upload source changed before transfer");
    }
    const health = this.#health ?? (await this.probe(input.signal));
    const result = await this.#runRemote(
      [
        "node",
        "-e",
        UPLOAD_SCRIPT,
        health.codexHome,
        operationId,
        fileName,
        input.sha256,
        String(input.size),
        String(MAX_HANDOFF_FILE_BYTES),
      ],
      {
        signal: input.signal,
        timeoutMs: 10 * 60_000,
        stdinPath: input.localPath,
      },
    );
    const parsed = JSON.parse(result.stdout.toString("utf8")) as { readonly path?: unknown };
    if (typeof parsed.path !== "string")
      throw new Error("SSH upload returned an invalid destination");
    return {
      path: absoluteRemotePath(parsed.path, "Remote upload path"),
      sha256: input.sha256,
      size: input.size,
    };
  }

  async cleanup(operationId: string): Promise<void> {
    const token = sanitizeCodexTransferToken(operationId, "handoff operation id");
    const health = this.#health ?? (await this.probe());
    await this.#runRemote(["node", "-e", CLEANUP_SCRIPT, health.codexHome, token], {
      timeoutMs: 30_000,
    });
  }

  #authorizedTransferRoots(health: CodexSshExecutionHostHealth): readonly string[] {
    return [this.config.managedRoot, health.codexHome, ...this.config.repositoryRoots];
  }

  async #ensureWorkerInstalled(signal?: AbortSignal): Promise<string> {
    if (this.#remoteWorkerPath) return this.#remoteWorkerPath;
    const bundle = await readFile(this.#workerBundlePath);
    const hash = createHash("sha256").update(bundle).digest("hex");
    const result = await this.#runRemote(
      ["node", "-e", INSTALL_SCRIPT, hash, String(128 * 1024 * 1024)],
      { signal, timeoutMs: 120_000, stdinPath: this.#workerBundlePath },
    );
    const parsed = JSON.parse(result.stdout.toString("utf8")) as { readonly path?: unknown };
    if (typeof parsed.path !== "string")
      throw new Error("SSH worker installer returned an invalid path");
    this.#remoteWorkerPath = absoluteRemotePath(parsed.path, "Remote worker path");
    return this.#remoteWorkerPath;
  }

  async #runRemote(
    remoteArguments: readonly string[],
    options: {
      readonly signal?: AbortSignal;
      readonly timeoutMs: number;
      readonly stdinPath?: string;
    },
  ): Promise<BoundedCommandResult> {
    options.signal?.throwIfAborted();
    const child = this.spawnRemote(remoteArguments);
    let stdout = Buffer.alloc(0);
    let stderr = "";
    let timeout: ReturnType<typeof setTimeout> | null = setTimeout(
      () => terminate(child),
      options.timeoutMs,
    );
    timeout.unref();
    const abort = () => terminate(child);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.byteLength + chunk.byteLength > MAX_CONTROL_OUTPUT_BYTES) {
        terminate(child);
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_CONTROL_OUTPUT_BYTES) stderr += chunk;
    });
    if (options.stdinPath) createReadStream(options.stdinPath).pipe(child.stdin);
    else child.stdin.end();
    try {
      return await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => {
          if (options.signal?.aborted) {
            reject(new Error("Request canceled"));
            return;
          }
          if (code !== 0) {
            reject(new Error(stderr.trim() || `SSH command exited with code ${String(code)}`));
            return;
          }
          resolve({ stdout, stderr });
        });
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      options.signal?.removeEventListener("abort", abort);
    }
  }
}
