import { isDeepStrictEqual } from "node:util";
import type { AppComponentDefinition } from "../../src/main/app-components/AppComponentCatalog";
import type { WindowsArchitecture } from "../desktop-build-target";
import { assertPackagedPtyReceipt } from "../packaged-pty-probe.mjs";

/** Installed runtime execution is mandatory before any installer enters a bundle. */
export function assertWindowsInstalledProbe(
  value: unknown,
  architecture: WindowsArchitecture,
  pins: readonly AppComponentDefinition[],
): void {
  const probe = value as {
    failures?: unknown[];
    evidence?: { componentPayloadsAbsent?: unknown };
    components?: {
      receipts?: { pin: unknown; root: string; installedBytes: number; activated: boolean }[];
      codex?: { executable: string; version: string; images: number };
      claudeCode?: { executable: string; version: string };
      desktopTools?: {
        status: string;
        rootPath: string;
        signedImages: number;
        processesClosed: number;
      };
    };
    upgrade?: unknown;
    uninstall?: unknown;
    normalQuit?: unknown;
    packagedPty?: unknown;
  } | null;
  if (
    !probe ||
    !Array.isArray(probe.failures) ||
    probe.failures.length ||
    probe.evidence?.componentPayloadsAbsent !== true ||
    !probe.upgrade ||
    !probe.uninstall ||
    !probe.normalQuit
  )
    throw new Error(
      "Windows installed-app probe did not complete all maintenance and absence checks.",
    );

  const { receipts, codex, claudeCode, desktopTools } = probe.components ?? {};
  const absolutePath = (path: unknown): path is string =>
    typeof path === "string" && /^(?:[A-Z]:[\\/]|\\\\)/iu.test(path);
  const normalized = (path: string) => path.replaceAll("\\", "/").toLowerCase();
  if (pins.length !== 3 || !Array.isArray(receipts) || receipts.length !== pins.length)
    throw new Error("Windows installed-app probe is missing the published Component receipts.");
  const profileRoots = pins.map((pin, index) => {
    const receipt = receipts[index];
    const suffix = `/components/${pin.id}/${pin.archive.sha256}`;
    if (
      !receipt ||
      receipt.activated !== true ||
      !Number.isSafeInteger(receipt.installedBytes) ||
      receipt.installedBytes <= 0 ||
      !isDeepStrictEqual(receipt.pin, pin) ||
      !absolutePath(receipt.root) ||
      !normalized(receipt.root).endsWith(suffix)
    )
      throw new Error(
        `Windows installed-app probe has a different Component receipt for ${pin.id}.`,
      );
    return normalized(receipt.root).slice(0, -suffix.length);
  });
  if (new Set(profileRoots).size !== 1)
    throw new Error("Windows installed-app Component receipts must share one disposable Profile.");
  const desktopRoot = receipts[pins.findIndex(({ id }) => id === "desktop-tools")]?.root;
  const codexRoot = receipts[pins.findIndex(({ id }) => id === "codex")]?.root;
  const claudeIndex = pins.findIndex(({ id }) => id === "claude-code");
  const claudeRoot = receipts[claudeIndex]?.root;
  const claudePayload = pins[claudeIndex]?.payload;
  if (
    typeof codex?.version !== "string" ||
    !codex.version ||
    !Number.isSafeInteger(codex.images) ||
    codex.images <= 0 ||
    !codexRoot ||
    !absolutePath(codex.executable) ||
    normalized(codex.executable) !== `${normalized(codexRoot)}/bin/codex.exe` ||
    typeof claudeCode?.version !== "string" ||
    !claudeCode.version ||
    !claudeRoot ||
    !absolutePath(claudeCode.executable) ||
    claudePayload?.kind !== "claude-code" ||
    normalized(claudeCode.executable) !==
      `${normalized(claudeRoot)}/${claudePayload.executable.path.toLowerCase()}` ||
    desktopTools?.status !== "passed" ||
    !desktopRoot ||
    !absolutePath(desktopTools.rootPath) ||
    normalized(desktopTools.rootPath) !== `${normalized(desktopRoot)}/browser-runtime` ||
    !Number.isSafeInteger(desktopTools.signedImages) ||
    desktopTools.signedImages <= 0 ||
    !Number.isSafeInteger(desktopTools.processesClosed) ||
    desktopTools.processesClosed < 2
  )
    throw new Error("Windows installed-app probe did not certify Component conformance.");

  const pty = assertPackagedPtyReceipt(probe.packagedPty);
  const addon = pty.addonPath.replaceAll("\\", "/");
  const node = pty.nodeExecutable.replaceAll("\\", "/");
  if (
    addon.slice(0, -"/agent-runtime/node_modules/node-pty".length).toLowerCase() !==
      node.slice(0, -"/node-runtime/node.exe".length).toLowerCase() ||
    pty.platform !== "win32" ||
    pty.architecture !== architecture ||
    !pty.addonPath
      .replaceAll("\\", "/")
      .endsWith("/resources/agent-runtime/node_modules/node-pty") ||
    !pty.nodeExecutable.replaceAll("\\", "/").endsWith("/resources/node-runtime/node.exe")
  )
    throw new Error("Windows PTY probe did not execute the installed runtime closure.");
}
