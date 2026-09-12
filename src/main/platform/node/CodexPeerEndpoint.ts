/* oxlint-disable effecttsgo/async-function, effecttsgo/new-promise -- Node socket election is an adapter boundary; the application Scope owns all listening resources. */
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import { CodexPeerRouter } from "./CodexPeerRouter";

/** Profile-specific paths keep independent desktop Profiles on separate peer networks. */
function primaryEndpoint(profileHome: string): string {
  if (process.platform === "win32")
    return `\\\\.\\pipe\\nodex-${Buffer.from(profileHome).toString("hex")}`;
  const directory = join(profileHome, "ipc");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  const uid = process.getuid?.();
  if (uid === undefined || !stat.isDirectory() || stat.uid !== uid)
    throw new Error("IPC directory is not owned by the current user");
  chmodSync(directory, 0o700);
  return join(directory, "ipc.sock");
}

function legacyEndpoint(profileHome: string): string {
  const profileKey = createHash("sha256").update(profileHome).digest("hex").slice(0, 16);
  const uid = process.getuid?.();
  return join(tmpdir(), "nodex-ipc", profileKey, uid ? `ipc-${uid}.sock` : "ipc.sock");
}

function isOwnedSocket(endpoint: string, uid: number): boolean {
  try {
    const stat = lstatSync(endpoint);
    return stat.isSocket() && stat.uid === uid;
  } catch {
    return false;
  }
}

function isSecureLegacyEndpoint(endpoint: string): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  try {
    const parent = lstatSync(dirname(endpoint));
    return (
      isOwnedSocket(endpoint, uid) &&
      parent.isDirectory() &&
      parent.uid === uid &&
      (parent.mode & 0o022) === 0
    );
  } catch {
    return false;
  }
}

function removeStaleSocket(endpoint: string): void {
  const uid = process.getuid?.();
  if (uid !== undefined && isOwnedSocket(endpoint, uid)) unlinkSync(endpoint);
}

function secureSocket(endpoint: string): void {
  if (process.platform === "win32") return;
  const uid = process.getuid?.();
  if (uid === undefined || !isOwnedSocket(endpoint, uid))
    throw new Error("IPC socket is not owned by the current user");
  chmodSync(endpoint, 0o600);
}

function canConnect(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(endpoint, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

/** Election returns a pathname before listen completes. Socket clients own connection retries. */
export class CodexPeerEndpointManager {
  private routerStarted = false;
  private disposed = false;
  private readonly servers = new Map<Server, CodexPeerRouter | null>();

  constructor(
    private readonly profileHome: string,
    private readonly onError: (error: unknown) => void,
  ) {}

  async getOrStartRouterEndpoint(): Promise<string> {
    if (this.disposed) throw new Error("disposed");
    const endpoint = primaryEndpoint(this.profileHome);
    if (this.routerStarted) return endpoint;
    if (process.platform !== "win32") {
      if (await canConnect(endpoint)) return endpoint;
      const legacy = legacyEndpoint(this.profileHome);
      if (isSecureLegacyEndpoint(legacy) && (await canConnect(legacy))) return legacy;
      try {
        removeStaleSocket(endpoint);
      } catch {
        // Failed stale cleanup is resolved by the bind attempt and its error callback.
      }
    }
    if (this.disposed) throw new Error("disposed");
    const server = createServer();
    this.servers.set(server, null);
    server.on("close", () => {
      this.servers.get(server)?.dispose();
      this.servers.delete(server);
    });
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        server.close();
        return;
      }
      this.onError(error);
    });
    server.listen(endpoint, () => {
      if (this.disposed) {
        server.close();
        return;
      }
      try {
        secureSocket(endpoint);
      } catch (error) {
        this.onError(error);
        server.close();
        return;
      }
      this.routerStarted = true;
      this.servers.set(server, new CodexPeerRouter(server, this.onError));
    });
    return endpoint;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const closing = [...this.servers].map(([server, router]) => {
      router?.dispose();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await Promise.all(closing);
    this.servers.clear();
  }
}

export const acquireCodexPeerEndpointManager = Effect.fn("CodexPeerEndpoint.acquireManager")(
  function* (profileHome: string, onError: (error: unknown) => void) {
    return yield* Effect.acquireRelease(
      Effect.sync(() => new CodexPeerEndpointManager(profileHome, onError)),
      (manager) => Effect.promise(() => manager.dispose()),
    );
  },
);
