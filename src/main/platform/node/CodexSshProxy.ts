import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Duplex } from "node:stream";

export interface CodexSshConnection {
  readonly alias?: string;
  readonly host: string;
  readonly port?: number | null;
  readonly identity?: string;
}
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Run inside the user's real login shell, then hand the payload to POSIX sh. */
export function codexRemoteLoginCommand(command: string, sentinel?: Uint8Array): string {
  const payload = `PATH="\${CODEX_INSTALL_DIR:-$HOME/.local/bin}:$PATH"; export PATH; ${command}`;
  const marked = sentinel
    ? `printf '%b' ${quote(Array.from(sentinel, (byte) => `\\${byte.toString(8).padStart(3, "0")}`).join(""))}; ${payload}`
    : payload;
  const execute = 'exec /bin/sh -c "$CODEX_REMOTE_PAYLOAD"';
  const csh = [
    "set loginsh=1",
    "if ( -r /etc/csh.login ) source /etc/csh.login",
    "if ( -r ~/.login ) source ~/.login",
    execute,
  ].join("; ");
  const normal = `CODEX_HOME="\${CODEX_HOME:-$HOME/.codex}"; export CODEX_HOME; ${execute}`;
  const wrapper = [
    'if [ -z "$SHELL" ] || [ ! -x "$SHELL" ]; then echo "Codex remote SSH requires SHELL to point to an executable login shell" >&2; exit 127; fi;',
    'CODEX_REMOTE_PAYLOAD="$1"; export CODEX_REMOTE_PAYLOAD;',
    'case "${SHELL##*/}" in',
    `csh|tcsh) exec "$SHELL" -i -c ${quote(csh)} ;;`,
    `nu) exec "$SHELL" -l -i -c ${quote("exec /bin/sh -c $env.CODEX_REMOTE_PAYLOAD")} ;;`,
    `fish|xonsh) exec "$SHELL" -l -i -c ${quote(execute)} ;;`,
    `*) exec "$SHELL" -l -i -c ${quote(normal)} ;;`,
    "esac",
  ].join(" ");
  return `sh -c ${quote(wrapper)} sh ${quote(marked)}`;
}

export function codexSshConnectionArguments(
  connection: CodexSshConnection,
  connectTimeoutSeconds?: number,
): string[] {
  const options = [
    "-v",
    "-o",
    "BatchMode=yes",
    ...(connectTimeoutSeconds === undefined
      ? []
      : ["-o", `ConnectTimeout=${connectTimeoutSeconds}`]),
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=12",
  ];
  if (connection.alias?.trim()) return [...options, connection.alias.trim()];
  return [
    ...options,
    ...(connection.identity?.trim() ? ["-i", connection.identity.trim()] : []),
    ...(connection.port == null ? [] : ["-p", String(connection.port)]),
    connection.host,
  ];
}

export const forwardedAgentCommand =
  'if [ -S "${SSH_AUTH_SOCK:-}" ]; then ln -sfn -- "$SSH_AUTH_SOCK" "${CODEX_HOME:-$HOME/.codex}/app-server-control/forwarded-ssh-agent.sock"; elif [ ! -S "${CODEX_HOME:-$HOME/.codex}/app-server-control/forwarded-ssh-agent.sock" ]; then rm -f -- "${CODEX_HOME:-$HOME/.codex}/app-server-control/forwarded-ssh-agent.sock"; fi';

/** Strip arbitrary login output while preserving every byte after the random handshake marker. */
export function createCodexSshProxy(options: {
  readonly connection: CodexSshConnection;
  readonly env?: NodeJS.ProcessEnv;
  readonly binary?: string;
  readonly codexBinary?: string;
  readonly codexHome?: string | null;
  readonly connectTimeoutSeconds?: number;
  readonly sentinel?: Buffer;
  readonly spawnProcess?: (command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }) => ChildProcessWithoutNullStreams;
}): Duplex {
  const sentinel = options.sentinel ?? randomBytes(8);
  const home = options.codexHome
    ? `CODEX_HOME=${quote(options.codexHome)}; export CODEX_HOME; `
    : "";
  const command = `${home}${forwardedAgentCommand} && exec ${quote(options.codexBinary ?? "codex")} app-server proxy`;
  const child = (options.spawnProcess ?? spawn)(
    options.binary ?? "ssh",
    [
      "-T",
      ...codexSshConnectionArguments(options.connection, options.connectTimeoutSeconds),
      codexRemoteLoginCommand(command, sentinel),
    ],
    { env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] },
  ) as ChildProcessWithoutNullStreams;
  const { stdin, stdout, stderr } = child;
  let diagnostic = "";
  stderr.on("data", (data: Buffer) => {
    diagnostic = `${diagnostic}${data.toString("utf8")}`.slice(-4000);
  });
  const proxy = new Duplex({
    read() {
      stdout.resume();
    },
    write(chunk, encoding, callback) {
      stdin.write(chunk, encoding, callback);
    },
    final(callback) {
      stdin.end();
      callback();
    },
    destroy(error, callback) {
      child.kill();
      callback(error);
    },
  });
  Object.assign(proxy, {
    setKeepAlive: () => proxy,
    setNoDelay: () => proxy,
    setTimeout: () => proxy,
  });
  const fail = (error: Error) => {
    proxy.destroy(error);
  };
  stdin.on("error", fail);
  let matched = false;
  let pending = Buffer.alloc(0);
  stdout.on("data", (chunk: Buffer) => {
    let output = chunk;
    if (!matched) {
      const combined = Buffer.concat([pending, chunk]);
      const index = combined.indexOf(sentinel);
      if (index === -1) {
        pending = combined.subarray(Math.max(0, combined.length - (sentinel.length - 1)));
        return;
      }
      matched = true;
      output = combined.subarray(index + sentinel.length);
      pending = Buffer.alloc(0);
    }
    if (output.length && !proxy.push(output)) stdout.pause();
  });
  stdout.on("end", () => {
    proxy.push(null);
  });
  child.on("error", fail);
  child.on("close", (code, signal) => {
    stdin.off("error", fail);
    if (code === 0) {
      proxy.push(null);
      return;
    }
    const details = diagnostic
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !/^debug\d+:/u.test(line))
      .join("\n")
      .trim();
    proxy.destroy(
      new Error(`ssh app-server proxy exited with code ${code}, signal ${signal}: ${details}`),
    );
  });
  queueMicrotask(() => {
    proxy.emit("connect");
  });
  return proxy;
}
