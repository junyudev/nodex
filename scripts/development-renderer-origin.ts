import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

export const requireDevelopmentRendererPort = (value: unknown): number => {
  const port = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535)
    return port;
  throw new Error("Renderer port must be an integer from 1024 to 65535");
};

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const available = (port: number): Promise<boolean> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    server.listen(port, "localhost", () =>
      server.close((error) => (error ? reject(error) : resolve(true))),
    );
  });

/** A persisted origin keeps this Profile's IndexedDB reachable across HMR launches. */
export const resolveDevelopmentRendererPort = async (input: {
  readonly root: string;
  readonly nodexHome: string;
  readonly requestedPort?: string;
}): Promise<number> => {
  const filename = path.join(input.root, "renderer-origin.json");
  if (input.requestedPort !== undefined) {
    const port = requireDevelopmentRendererPort(input.requestedPort);
    await writeFile(filename, `${JSON.stringify({ version: 1, hostname: "localhost", port })}\n`, {
      mode: 0o600,
    });
    return port;
  }
  try {
    const saved: unknown = JSON.parse(await readFile(filename, "utf8"));
    if (
      typeof saved !== "object" ||
      saved === null ||
      !("version" in saved) ||
      saved.version !== 1 ||
      !("hostname" in saved) ||
      saved.hostname !== "localhost" ||
      !("port" in saved)
    )
      throw new Error("Invalid renderer-origin.json; choose --renderer-port explicitly");
    return requireDevelopmentRendererPort(saved.port);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  let directories: string[] = [];
  try {
    directories = await readdir(path.join(input.nodexHome, "electron-session-data", "IndexedDB"));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const existingPorts = [
    ...new Set(
      directories.flatMap((name) => {
        const match = /^http_localhost_(\d+)\.indexeddb\.(?:leveldb|blob)$/.exec(name);
        return match ? [requireDevelopmentRendererPort(match[1])] : [];
      }),
    ),
  ];
  if (existingPorts.length > 1)
    throw new Error(
      `This development home has recovery caches at ports ${existingPorts.join(", ")}. Choose --renderer-port <port> to reopen that cache; no cache has been removed.`,
    );
  let port = existingPorts[0];
  if (port === undefined) {
    const start =
      40000 + (createHash("sha256").update(input.root).digest().readUInt32BE(0) % 20000);
    for (let offset = 0; offset < 20000; offset += 1) {
      const candidate = 40000 + ((start - 40000 + offset) % 20000);
      if (await available(candidate)) {
        port = candidate;
        break;
      }
    }
  }
  if (port === undefined) throw new Error("No renderer port is available");
  try {
    await writeFile(filename, `${JSON.stringify({ version: 1, hostname: "localhost", port })}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    return resolveDevelopmentRendererPort(input);
  }
  return port;
};
