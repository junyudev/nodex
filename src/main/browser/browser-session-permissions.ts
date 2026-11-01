import { randomUUID } from "node:crypto";
import type { Session } from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  BROWSER_SITE_PERMISSION_NAMES,
  type BrowserPermissionDescriptor,
  type BrowserPermissionPrompt,
  type BrowserSitePermissionName,
  type BrowserSitePermissionState,
} from "../../shared/browser/browser-permissions";
import {
  makeBrowserSidebarTabKey,
  type BrowserSidebarCommand,
  type BrowserSidebarCommandResult,
  type BrowserSidebarTabIdentity,
  type BrowserSidebarHostRouteIdentity,
} from "../../shared/browser-sidebar";
import {
  permissionOrigin,
  type BrowserPermissionStore,
  type BrowserPermissionStoreError,
} from "./browser-permission-store";

type RequestHandler = NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>;
type CheckHandler = NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>;
type ElectronPermission = Parameters<RequestHandler>[1];
type RequestDetails = Parameters<RequestHandler>[3];
type Policy = "allow" | "prompt" | "deny";

/**
 * Electron 45 permission policy. Chromium still enforces secure contexts, Permissions
 * Policy and API activation requirements before reaching these handlers.
 *
 * No consent UI: fullscreen, pointer/keyboard lock (Chrome's proposed permission
 * launch was withdrawn), EME, wake lock, sensors, background fetch/sync and payment
 * handlers. Sanitized clipboard writes require native input activation; otherwise
 * they use the clipboard permission prompt, never a top-frame exemption.
 *
 * Consent: camera/microphone, location, notifications, clipboard read/write, MIDI
 * (including SysEx), window management, idle detection, storage access, external
 * protocols, fonts, local network, automatic fullscreen,
 * captured-surface control and immersive XR/hand tracking.
 *
 * No device/file/install/print/display chooser exists here: deny HID, serial, USB,
 * smart cards, speaker selection, fileSystem, web-app-installation, web-printing
 * and display capture.
 * NFC is unavailable on desktop. Chromium grants persistent storage and periodic
 * background sync from engagement/installed-app policy, not a consent prompt; Nodex
 * has no such eligibility signal, so those remain ungranted. System wake lock is
 * not available to ordinary web pages. Unknown/future permissions fail closed.
 *
 * Browser Use shares this policy: its native prompt path has no agent-specific
 * denial rule. Agent control never substitutes for a current owner response.
 */
export const BROWSER_PERMISSION_POLICY = {
  ar: "prompt",
  "automatic-fullscreen": "prompt",
  "background-fetch": "allow",
  "background-sync": "allow",
  "captured-surface-control": "prompt",
  "clipboard-read": "prompt",
  "clipboard-sanitized-write": "prompt",
  "deprecated-sync-clipboard-read": "prompt",
  "display-capture": "deny",
  fileSystem: "deny",
  fullscreen: "allow",
  geolocation: "prompt",
  "geolocation-approximate": "prompt",
  "hand-tracking": "prompt",
  hid: "deny",
  "idle-detection": "prompt",
  keyboardLock: "allow",
  "local-fonts": "prompt",
  "local-network": "prompt",
  "local-network-access": "prompt",
  "loopback-network": "prompt",
  media: "prompt",
  mediaKeySystem: "allow",
  midi: "prompt",
  midiSysex: "prompt",
  nfc: "deny",
  notifications: "prompt",
  openExternal: "prompt",
  "payment-handler": "allow",
  "periodic-background-sync": "deny",
  "persistent-storage": "deny",
  pointerLock: "allow",
  "screen-wake-lock": "allow",
  sensors: "allow",
  serial: "deny",
  "smart-card": "deny",
  "speaker-selection": "deny",
  "storage-access": "prompt",
  "system-wake-lock": "deny",
  "top-level-storage-access": "prompt",
  usb: "deny",
  vr: "prompt",
  "web-app-installation": "deny",
  "web-printing": "deny",
  "window-management": "prompt",
  unknown: "deny",
} as const satisfies Record<ElectronPermission, Policy>;

export interface BrowserPermissionPage extends BrowserSidebarHostRouteIdentity {
  readonly ownerWebContentsId: number;
  readonly webContentsId: number;
  readonly url: string;
  readonly navigationVersion: number;
  readonly presented: boolean;
  readonly hasUserGesture: boolean;
}

interface PendingPermission {
  readonly page: BrowserPermissionPage;
  readonly prompt: BrowserPermissionPrompt;
  readonly callback: (allowed: boolean) => void;
  resolving: boolean;
}

export class BrowserPermissionRuntimeError extends Schema.TaggedError<BrowserPermissionRuntimeError>()(
  "BrowserPermissionRuntimeError",
  { cause: Schema.Defect() },
) {}

type PromptCommand = Extract<
  BrowserSidebarCommand,
  { type: "respond-permission" | "open-permission-system-settings" }
>;

export interface BrowserPermissionHost {
  readonly findPage: (webContentsId: number) => BrowserPermissionPage | null;
  readonly publish: (
    identity: BrowserSidebarTabIdentity,
    prompts: BrowserPermissionPrompt[],
  ) => void;
  readonly systemStatus: (
    permission: BrowserSitePermissionName,
  ) => "granted" | "denied" | "restricted" | "unknown" | "not-determined";
  readonly openSystemSettings: (permission: BrowserSitePermissionName) => Promise<void>;
}

/** Electron callback adapter. BrowserState owns its lifetime and identity evidence. */
export class BrowserSessionPermissions {
  private readonly pending = new Map<string, PendingPermission>();
  private readonly temporary = new Map<
    number,
    { pageOrigin: string | null; origins: Map<string, Set<BrowserSitePermissionName>> }
  >();

  constructor(
    private readonly host: BrowserPermissionHost,
    private readonly store?: BrowserPermissionStore,
  ) {}

  readonly request: RequestHandler = (contents, permission, callback, details) => {
    const page = this.host.findPage(contents.id);
    const policy = policyFor(permission);
    if (!page || policy === "deny") return callback(false);
    if (policy === "allow") return callback(true);
    const origin = requestOrigin(details);
    if (!origin) return callback(false);
    const permissions = descriptors(permission, details);
    if (permissions.length === 0) return callback(false);
    const states = permissions.map(({ name }) => this.state(page.webContentsId, origin, name));
    if (states.includes("block")) return callback(false);
    const osBlocked = permissions.some(({ name }) => this.isSystemBlocked(name));
    if (!osBlocked && states.every((state) => state === "allow")) return callback(true);
    if (!osBlocked && permission === "clipboard-sanitized-write" && page.hasUserGesture)
      return callback(true);
    const prompt: BrowserPermissionPrompt = {
      id: randomUUID(),
      origin,
      embeddingOrigin: permissionOrigin(page.url) ?? undefined,
      permissions,
      actions: osBlocked ? ["dismiss"] : ["allow", "allow-this-time", "deny", "dismiss"],
      variant: osBlocked ? "os-system-settings" : "permission",
      mountGeneration: page.mountGeneration,
    };
    this.pending.set(prompt.id, { page, prompt, callback, resolving: false });
    this.publish(page);
  };

  readonly check: CheckHandler = (contents, permission, origin, details) => {
    const page = contents ? this.host.findPage(contents.id) : null;
    const policy = policyFor(permission);
    if (policy === "deny") return false;
    // Worker checks have no page lifetime; only durable origin decisions apply.
    if (contents && !page) return false;
    if (policy === "allow")
      return page !== null || (contents === null && permissionOrigin(origin) !== null);
    const requestingOrigin = permissionOrigin(details.securityOrigin ?? origin);
    if (!requestingOrigin) return false;
    const permissions = descriptors(permission, {
      ...details,
      requestingUrl: details.requestingUrl ?? requestingOrigin,
      ...("mediaType" in details && details.mediaType !== undefined
        ? { mediaTypes: details.mediaType === "unknown" ? [] : [details.mediaType] }
        : {}),
    });
    if (permissions.length === 0) return false;
    if (permissions.some(({ name }) => this.isSystemBlocked(name))) return false;
    if (
      permissions.every(
        ({ name }) => this.state(page?.webContentsId, requestingOrigin, name) === "allow",
      )
    )
      return true;
    return (
      permission === "clipboard-sanitized-write" &&
      page?.hasUserGesture === true &&
      this.store?.get(requestingOrigin, "clipboard-write") !== "block"
    );
  };

  respond(
    command: Extract<PromptCommand, { type: "respond-permission" }>,
    ownerWebContentsId: number | undefined,
  ): Effect.Effect<BrowserSidebarCommandResult, BrowserPermissionStoreError> {
    return Effect.gen(
      function* (
        this: BrowserSessionPermissions,
      ): Effect.fn.Return<BrowserSidebarCommandResult, BrowserPermissionStoreError> {
        const pending = this.current(command, ownerWebContentsId);
        if (!pending || pending.resolving) return rejected();
        if (!pending.prompt.actions.includes(command.action)) return rejected();
        // Stock Electron has no accuracy selection API. Do not claim to enforce it.
        if (
          command.geolocationAccuracy !== undefined &&
          !pending.prompt.geolocationAccuracies?.includes(command.geolocationAccuracy)
        )
          return rejected();
        pending.resolving = true;
        const names = pending.prompt.permissions.map(({ name }) => name);
        if (command.action === "allow" || command.action === "deny") {
          if (!this.store) {
            this.finish(pending, false);
            return { ok: false, message: "Browser permission storage is unavailable" };
          }
          yield* this.store
            .set(pending.prompt.origin, names, command.action === "allow" ? "allow" : "block")
            .pipe(Effect.onError(() => Effect.sync(() => this.finish(pending, false))));
        }
        if (!this.current(command, ownerWebContentsId)) return rejected();
        if (command.action === "allow-this-time") {
          const temporary = this.temporary.get(pending.page.webContentsId) ?? {
            pageOrigin: permissionOrigin(pending.page.url),
            origins: new Map<string, Set<BrowserSitePermissionName>>(),
          };
          const permissions =
            temporary.origins.get(pending.prompt.origin) ?? new Set<BrowserSitePermissionName>();
          for (const name of names) permissions.add(name);
          temporary.origins.set(pending.prompt.origin, permissions);
          this.temporary.set(pending.page.webContentsId, temporary);
        }
        const allowed = command.action === "allow" || command.action === "allow-this-time";
        const osBlocked = pending.prompt.permissions.some(({ name }) => this.isSystemBlocked(name));
        this.finish(pending, allowed && !osBlocked);
        return { ok: true };
      }.bind(this),
    );
  }

  openSystemSettings(
    command: Extract<PromptCommand, { type: "open-permission-system-settings" }>,
    ownerWebContentsId: number | undefined,
  ): Effect.Effect<BrowserSidebarCommandResult, BrowserPermissionRuntimeError> {
    return Effect.gen(
      function* (
        this: BrowserSessionPermissions,
      ): Effect.fn.Return<BrowserSidebarCommandResult, BrowserPermissionRuntimeError> {
        const pending = this.current(command, ownerWebContentsId);
        if (!pending || pending.prompt.variant !== "os-system-settings") return rejected();
        const permission = pending.prompt.permissions.find(({ name }) =>
          this.isSystemBlocked(name),
        );
        if (!permission) return rejected();
        yield* Effect.tryPromise({
          try: () => this.host.openSystemSettings(permission.name),
          catch: (cause) => new BrowserPermissionRuntimeError({ cause }),
        });
        return { ok: true };
      }.bind(this),
    );
  }

  sitePermissions(
    webContentsId: number | undefined,
    origin: string,
  ): Array<{ permission: BrowserSitePermissionName; state: BrowserSitePermissionState }> {
    return BROWSER_SITE_PERMISSION_NAMES.map((permission) => ({
      permission,
      state:
        permission === "display-capture" ||
        permission === "speaker-selection" ||
        this.isSystemBlocked(permission)
          ? "block"
          : this.state(webContentsId, origin, permission),
    }));
  }

  reset(
    origin: string,
    permission?: BrowserSitePermissionName,
  ): Effect.Effect<void, BrowserPermissionStoreError> {
    return Effect.gen(
      function* (this: BrowserSessionPermissions) {
        if (this.store) yield* this.store.reset(origin, permission);
        for (const temporary of this.temporary.values()) {
          if (permission) temporary.origins.get(origin)?.delete(permission);
          else temporary.origins.delete(origin);
        }
        for (const pending of [...this.pending.values()]) {
          if (
            pending.prompt.origin === origin &&
            (!permission || pending.prompt.permissions.some(({ name }) => name === permission))
          )
            this.finish(pending, false);
        }
      }.bind(this),
    );
  }

  /** Every navigation invalidates prompts; temporary grants end on origin change. */
  navigation(webContentsId: number, url: string): void {
    this.dismiss(webContentsId);
    const temporary = this.temporary.get(webContentsId);
    if (temporary && temporary.pageOrigin !== permissionOrigin(url))
      this.temporary.delete(webContentsId);
  }

  release(webContentsId: number): void {
    this.dismiss(webContentsId);
    this.temporary.delete(webContentsId);
  }

  dispose(): void {
    for (const pending of [...this.pending.values()]) this.finish(pending, false);
    this.temporary.clear();
  }

  private state(
    webContentsId: number | undefined,
    origin: string,
    permission: BrowserSitePermissionName,
  ): BrowserSitePermissionState {
    const persisted = this.store?.get(origin, permission);
    if (persisted) return persisted;
    const temporary = webContentsId === undefined ? undefined : this.temporary.get(webContentsId);
    return temporary?.origins.get(origin)?.has(permission) ? "allow" : "ask";
  }

  private isSystemBlocked(permission: BrowserSitePermissionName): boolean {
    const status = this.host.systemStatus(permission);
    return status === "denied" || status === "restricted";
  }

  private current(
    command: PromptCommand,
    ownerWebContentsId: number | undefined,
  ): PendingPermission | null {
    const pending = this.pending.get(command.promptId);
    if (!pending) return null;
    const page = this.host.findPage(pending.page.webContentsId);
    if (
      !page ||
      !page.presented ||
      page.ownerWebContentsId !== ownerWebContentsId ||
      makeBrowserSidebarTabKey(command) !== makeBrowserSidebarTabKey(page) ||
      makeBrowserSidebarTabKey(page) !== makeBrowserSidebarTabKey(pending.page) ||
      command.mountGeneration !== pending.prompt.mountGeneration ||
      page.mountGeneration !== pending.page.mountGeneration ||
      page.hostGeneration !== pending.page.hostGeneration ||
      page.rendererInstanceId !== pending.page.rendererInstanceId ||
      page.ownerWebContentsId !== pending.page.ownerWebContentsId ||
      page.navigationVersion !== pending.page.navigationVersion
    )
      return null;
    return pending;
  }

  private dismiss(webContentsId: number): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.page.webContentsId === webContentsId) this.finish(pending, false);
    }
  }

  private finish(pending: PendingPermission, allowed: boolean): void {
    if (!this.pending.delete(pending.prompt.id)) return;
    this.publish(pending.page);
    pending.callback(allowed);
  }

  private publish(page: BrowserPermissionPage): void {
    const key = makeBrowserSidebarTabKey(page);
    this.host.publish(
      page,
      [...this.pending.values()]
        .filter((value) => makeBrowserSidebarTabKey(value.page) === key)
        .map(({ prompt }) => prompt),
    );
  }
}

const rejected = (): BrowserSidebarCommandResult => ({
  ok: false,
  message: "Browser permission prompt is no longer current or the response is unavailable",
});
const policyFor = (permission: string): Policy =>
  Object.hasOwn(BROWSER_PERMISSION_POLICY, permission)
    ? BROWSER_PERMISSION_POLICY[permission as ElectronPermission]
    : "deny";
const requestOrigin = (details: RequestDetails): string | null =>
  permissionOrigin(
    "securityOrigin" in details && details.securityOrigin
      ? details.securityOrigin
      : details.requestingUrl,
  );

function descriptors(
  permission: ElectronPermission,
  details: RequestDetails,
): BrowserPermissionDescriptor[] {
  if (permission === "media") {
    const types = "mediaTypes" in details ? details.mediaTypes : undefined;
    return [...new Set(types ?? [])].flatMap<BrowserPermissionDescriptor>((type) =>
      type === "video" ? [{ name: "camera" }] : type === "audio" ? [{ name: "microphone" }] : [],
    );
  }
  if (permission === "openExternal")
    return [
      {
        name: "open-external",
        externalUrl: "externalURL" in details ? details.externalURL : undefined,
      },
    ];
  if (permission === "clipboard-sanitized-write") return [{ name: "clipboard-write" }];
  if (permission === "deprecated-sync-clipboard-read") return [{ name: "clipboard-read" }];
  if (permission === "midiSysex") return [{ name: "midi-sysex" }];
  if (permission === "geolocation-approximate") return [{ name: "geolocation" }];
  if (permission === "local-network-access" || permission === "loopback-network")
    return [{ name: "local-network" }];
  return BROWSER_SITE_PERMISSION_NAMES.flatMap((name) => (name === permission ? [{ name }] : []));
}
