import { terminateWindowsProcessTree } from "../../process-tree";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { clipboard, ClipboardItem, globalShortcut, type Clipboard } from "electron";
import {
  WindowsDictationNativeHelperClient,
  type WindowsDictationClipboardPort,
  type WindowsDictationClipboardFormat,
  type WindowsDictationReleaseWatcher,
} from "../../dictation/windows-dictation-native-helper-client";

const execute = promisify(execFile);

function readClipboardFormat(
  item: ClipboardItem,
  type: string,
): Promise<WindowsDictationClipboardFormat> {
  return item
    .getType(type)
    .then((payload): Promise<WindowsDictationClipboardFormat> | WindowsDictationClipboardFormat => {
      if ("title" in payload) {
        const bookmark = { title: payload.title, url: payload.url };
        return { type, bookmark, bytes: Buffer.from(JSON.stringify(bookmark)) };
      }
      return payload.arrayBuffer().then((bytes) => ({ type, bytes: new Uint8Array(bytes) }));
    });
}

function readClipboardItem(item: ClipboardItem): Promise<WindowsDictationClipboardFormat[]> {
  return Promise.all(item.types.map((type) => readClipboardFormat(item, type)));
}

/** Materialize every format while the clipboard still belongs to the original writer. */
export function createWindowsDictationClipboardPort(
  target: Pick<Clipboard, "read" | "write" | "writeText">,
  Item: typeof ClipboardItem = ClipboardItem,
): WindowsDictationClipboardPort {
  const makeItem = (formats: readonly WindowsDictationClipboardFormat[]): ClipboardItem =>
    new Item(
      Object.fromEntries(
        formats.map((format) => [
          format.type,
          format.bookmark ?? new Blob([new Uint8Array(format.bytes)], { type: format.type }),
        ]),
      ),
    );
  return {
    read: () =>
      target
        .read()
        .then((items) => Promise.all(items.map(readClipboardItem)))
        .then((items) => {
          const plainText = items.flat().find((format) => format.type === "text/plain");
          return { text: plainText ? Buffer.from(plainText.bytes).toString("utf8") : "", items };
        }),
    write: (snapshot) => target.write(snapshot.items.map(makeItem)),
    writeText: (text) => target.writeText(text),
  };
}
const RELEASE_WATCH_SCRIPT = `
$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class NodexKeyboardState {
  [DllImport("user32.dll")]
  private static extern short GetAsyncKeyState(int key);

  public static bool IsDown(int key) {
    return (GetAsyncKeyState(key) & 0x8000) != 0;
  }
}
"@

$keyGroupSpec = __KEY_GROUP_SPEC__
if ([string]::IsNullOrWhiteSpace($keyGroupSpec)) {
  throw "Missing hotkey release key groups."
}

$keyGroups = $keyGroupSpec.Split(";") | ForEach-Object {
  ,($_.Split(",") | ForEach-Object { [int]$_ })
}

$wasDown = $true
while ($true) {
  $isDown = $true
  foreach ($group in $keyGroups) {
    $groupDown = $false
    foreach ($key in $group) {
      if ([NodexKeyboardState]::IsDown($key)) {
        $groupDown = $true
        break
      }
    }
    if (-not $groupDown) {
      $isDown = $false
      break
    }
  }
  if ($wasDown -and -not $isDown) {
    [Console]::WriteLine("up")
  }
  $wasDown = $isDown
  Start-Sleep -Milliseconds 10
}
`;

export function buildWindowsDictationReleaseScript(groups: readonly (readonly number[])[]): string {
  if (
    !groups.length ||
    groups.some(
      (group) =>
        !group.length || group.some((key) => !Number.isInteger(key) || key < 0 || key > 255),
    )
  ) {
    throw new Error("Invalid Windows hotkey release groups");
  }
  return RELEASE_WATCH_SCRIPT.replace(
    "__KEY_GROUP_SPEC__",
    `'${groups.map((group) => group.join(",")).join(";")}'`,
  );
}

/** Releases held state on subprocess failure, and fences every callback after disposal. */
export function observeWindowsDictationRelease(
  child: ChildProcess,
  onReleased: () => void,
): WindowsDictationReleaseWatcher {
  let active = true;
  let exited = child.exitCode !== null || child.signalCode !== null;
  let release: Promise<void> | null = null;
  let pending = "";
  let resolveClosed!: () => void;
  // @effect-diagnostics-next-line newPromise:off -- ChildProcess close is a native callback boundary.
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const stopped = (): void => {
    if (!active) return;
    active = false;
    onReleased();
  };
  const handleExit = (): void => {
    exited = true;
    stopped();
  };
  const handleData = (chunk: Buffer | string): void => {
    if (!active) return;
    pending += chunk.toString();
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      if (active && pending.slice(0, newline).trim() === "up") onReleased();
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  };
  const handleClose = (): void => {
    exited = true;
    stopped();
    child.stdout?.off("data", handleData);
    child.off("error", stopped);
    child.off("exit", handleExit);
    child.off("close", handleClose);
    resolveClosed();
  };
  child.stdout?.on("data", handleData);
  child.on("error", stopped);
  child.once("exit", handleExit);
  child.once("close", handleClose);
  return {
    get isActive() {
      return active;
    },
    dispose: () => {
      if (release) return release;
      active = false;
      // A failed native release remains observable immediately. The fenced data/error/close
      // listeners keep draining and owning the child until its actual close event.
      release = Promise.resolve()
        .then(() => {
          const pid = child.pid;
          if (exited || !Number.isSafeInteger(pid) || !pid || pid <= 0) return;
          return terminateWindowsProcessTree(pid, "SIGKILL");
        })
        .then(() => closed);
      return release;
    },
  };
}

/** Windows uses OS shortcuts, modifier-state polling and foreground Ctrl+V. */
export function createWindowsDictationNativeHelperClient(
  platform: string,
): WindowsDictationNativeHelperClient {
  if (platform !== "win32") throw new Error("Windows dictation requires Windows");
  return new WindowsDictationNativeHelperClient({
    clipboard: createWindowsDictationClipboardPort(clipboard),
    registerShortcut: (accelerator, onPressed) => globalShortcut.register(accelerator, onPressed),
    unregisterShortcut: (accelerator) => globalShortcut.unregister(accelerator),
    watchRelease: (groups, onReleased) =>
      observeWindowsDictationRelease(
        spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            buildWindowsDictationReleaseScript(groups),
          ],
          { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
        ),
        onReleased,
      ),
    sendPaste: (signal) =>
      execute(
        "powershell.exe",
        [
          "-STA",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
        ],
        { signal },
      ).then(() => undefined),
    now: Date.now,
    sleep: (milliseconds) => setTimeout(milliseconds),
  });
}
