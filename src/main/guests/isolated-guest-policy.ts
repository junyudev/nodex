import type { Session, WebContents, WebPreferences } from "electron";

interface GuestParams {
  nodeintegration?: string;
  preload?: string;
  webpreferences?: string;
}

/** Overwrite renderer claims at Electron's last synchronous attachment boundary. */
export function forceIsolatedGuestPreferences(
  preferences: WebPreferences,
  params: GuestParams,
  session: Session,
  preload?: string,
): void {
  delete preferences.preload;
  delete (preferences as WebPreferences & { preloadURL?: string }).preloadURL;
  delete params.nodeintegration;
  delete params.preload;
  delete params.webpreferences;
  Object.assign(preferences, {
    allowRunningInsecureContent: false,
    contextIsolation: true,
    devTools: true,
    disableDialogs: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    plugins: false,
    sandbox: true,
    session,
    webSecurity: true,
    webviewTag: false,
    ...(preload ? { preload } : {}),
  });
}

export function denyGuestPermissionsAndDownloads(session: Session) {
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const onDownload = (event: Electron.Event, item: Electron.DownloadItem): void => {
    event.preventDefault();
    item.cancel();
  };
  session.on("will-download", onDownload);
  return onDownload;
}

export function isSameGuestDocument(expected: string, candidate: string): boolean {
  try {
    const left = new URL(expected);
    const right = new URL(candidate);
    left.hash = "";
    right.hash = "";
    return left.href === right.href;
  } catch {
    return false;
  }
}

/** A guest can never create a native popup; an owner may separately open a validated link. */
export function lockGuestNavigation(options: {
  readonly guest: WebContents;
  readonly documentUrl: string;
  readonly allowSubframe: (url: string) => boolean;
  readonly onExternalAttempt?: (url: string) => void;
}): void {
  const { guest, documentUrl, allowSubframe, onExternalAttempt } = options;
  guest.setWindowOpenHandler(({ url }) => {
    onExternalAttempt?.(url);
    return { action: "deny" };
  });
  guest.on("will-navigate", (event, url) => {
    const candidate = (event as Electron.Event & { url?: string }).url ?? url;
    if (isSameGuestDocument(documentUrl, candidate)) return;
    event.preventDefault();
    onExternalAttempt?.(candidate);
  });
  guest.on("will-frame-navigate", (event) => {
    if (event.isMainFrame ? isSameGuestDocument(documentUrl, event.url) : allowSubframe(event.url))
      return;
    event.preventDefault();
    if (event.isMainFrame) onExternalAttempt?.(event.url);
  });
  guest.on("will-redirect", (event, url, _inPlace, isMainFrame) => {
    const redirect = event as Electron.Event & { isMainFrame?: boolean; url?: string };
    const candidate = redirect.url ?? url;
    const mainFrame = redirect.isMainFrame ?? isMainFrame;
    if (mainFrame ? isSameGuestDocument(documentUrl, candidate) : allowSubframe(candidate)) return;
    event.preventDefault();
  });
}

/** Single-use native input evidence, confined to this exact WebContents and active owner. */
export function trackGuestUserGesture(guest: WebContents, isActive: () => boolean) {
  let lastGesture: number | undefined;
  const onMouse = (_event: Electron.Event, input: Electron.MouseInputEvent): void => {
    if (!isActive() || input.type !== "mouseDown") return;
    lastGesture = performance.now();
    guest.focus();
  };
  const onKey = (_event: Electron.Event, input: Electron.Input): void => {
    if (
      !isActive() ||
      input.type !== "keyDown" ||
      input.isAutoRepeat ||
      !["Enter", " "].includes(input.key)
    )
      return;
    lastGesture = performance.now();
  };
  guest.on("before-mouse-event", onMouse);
  guest.on("before-input-event", onKey);
  return {
    clear: () => {
      lastGesture = undefined;
    },
    consume: () => {
      const timestamp = lastGesture;
      lastGesture = undefined;
      return isActive() && timestamp !== undefined && performance.now() - timestamp <= 5_000;
    },
    release: () => {
      lastGesture = undefined;
      guest.removeListener("before-mouse-event", onMouse);
      guest.removeListener("before-input-event", onKey);
    },
  };
}
