import { spawn } from "node:child_process";

/** Opens the loopback URL produced by servePreview using the platform's default browser. */
export function openBrowser(url: string, onFailure: () => void): void {
  const options = { detached: true, stdio: "ignore" } as const;
  const child =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", `start "" "${url}"`], {
          ...options,
          windowsVerbatimArguments: true,
        })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], options);

  child.once("error", onFailure);
  child.once("exit", (code) => {
    if (code !== 0) onFailure();
  });
  child.unref();
}
