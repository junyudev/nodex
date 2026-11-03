import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { build } from "esbuild";
import type { ElectronApplication } from "playwright";
import { expect, test } from "vite-plus/test";
import { launchTestElectron } from "../../scripts/testing/launch-electron";

// GitHub Release downloads always redirect; Electron must hand each hop back for validation.
test("returns redirects and streams bodies through Electron's network stack", async () => {
  mkdirSync(".generated", { recursive: true });
  const directory = mkdtempSync(path.resolve(".generated/update-fetch-integration-"));
  const server: Server = createServer((request, response) => {
    if (request.url === "/release/download") {
      response.writeHead(302, { location: "/assets/installer.exe" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end("installer bytes");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let application: ElectronApplication | null = null;
  try {
    await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
          import { app } from "electron";
          import { electronUpdateFetch } from "./src/main/electron-update-fetch";
          app.setPath("userData", ${JSON.stringify(path.join(directory, "profile"))});
          globalThis.updateFetchProbe = app.whenReady().then(async () => {
            const redirect = await electronUpdateFetch(${JSON.stringify(`${origin}/release/download`)}, {});
            const download = await electronUpdateFetch(new URL(redirect.headers.get("location"), ${JSON.stringify(origin)}).href, {});
            const aborted = await electronUpdateFetch(${JSON.stringify(`${origin}/assets/installer.exe`)}, { signal: AbortSignal.abort() })
              .then(() => "resolved", (error) => error.name);
            return { redirect: [redirect.status, redirect.headers.get("location")], download: [download.status, await download.text()], aborted };
          });
        `,
      },
      bundle: true,
      packages: "external",
      platform: "node",
      format: "cjs",
      target: "node24",
      outfile: path.join(directory, "main.cjs"),
    });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
      ),
    ) as Record<string, string>;
    application = await launchTestElectron({ args: [path.join(directory, "main.cjs")], env });
    const result = await application.evaluate(
      async () =>
        (globalThis as unknown as { updateFetchProbe: Promise<unknown> }).updateFetchProbe,
    );
    expect(result).toEqual({
      redirect: [302, `${origin}/assets/installer.exe`],
      download: [200, "installer bytes"],
      aborted: "AbortError",
    });
  } finally {
    await application?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
