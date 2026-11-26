import {
  guestShortcutUsesNativeIngress,
  isBrowserEditingChord,
  type BrowserGuestShortcutBindings,
} from "../shared/browser/browser-workbench-shortcuts";
import {
  captureBrowserAnnotationAnchor,
  resolveBrowserAnnotationAnchor,
  hitTestBrowserAnnotation,
  resolveBrowserAnnotationFrame,
  resolveBrowserAnnotationSelector,
} from "./browser-annotation-anchors";
import { browserImageDragType } from "../shared/browser/browser-image-drag";
import { browserAnnotationAvailability } from "../shared/browser-annotation-interaction";
import { matchesKeyboardEventToAccelerator } from "../shared/command-keybindings";
import type { RuntimePlatform } from "../shared/runtime-platform";
import { ipcRenderer } from "electron";
import { installBrowserWebMcp } from "./browser-webmcp";
import type {
  BrowserSavedAnnotation,
  BrowserAnnotationAnchor,
  BrowserAnnotationDesignChange,
  BrowserAnnotationSelectionEvent,
} from "../shared/browser-annotation";

const ANNOTATION_OVERLAY_ATTRIBUTE = "data-nodex-browser-annotation-overlay";
installBrowserWebMcp();
let annotationSessionId: string | null = null;
let annotationSelectionMode: "inspect" | "region" = "inspect";
let hoveredElement: Element | null = null;
let overlay: HTMLDivElement | null = null;
let regionStart: { x: number; y: number; pointerId: number; document: Document } | null = null;
let annotationSuspended = false;
let annotationAgentControlled = false;
let annotationPinsVisible = true;
let annotationShortcuts: { bindings: string[]; platform: RuntimePlatform } = {
  bindings: ["CmdOrCtrl+Shift+."],
  platform: navigator.platform.toUpperCase().includes("MAC") ? "macOS" : "linux",
};
const annotationActive = () =>
  browserAnnotationAvailability({
    enabled: annotationSessionId !== null,
    suspended: annotationSuspended,
    agentControlled: annotationAgentControlled,
  });
let savedAnnotations: BrowserSavedAnnotation[] = [];
const liveAnchors = new Map<string, BrowserAnnotationAnchor>();
let markerRoot: HTMLDivElement | null = null;
let evidenceToken: string | null = null;
const selectedElementsByAnchorId = new Map<string, Element>();
let anchorUpdateFrame: number | null = null;
let designPreview: {
  element: HTMLElement;
  property: BrowserAnnotationDesignChange["property"];
  originalPriority: string;
  originalValue: string;
} | null = null;

function makeAnnotationId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `annotation-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function ensureOverlay(): HTMLDivElement {
  if (overlay?.isConnected) return overlay;
  overlay = document.createElement("div");
  overlay.setAttribute(ANNOTATION_OVERLAY_ATTRIBUTE, "");
  Object.assign(overlay.style, {
    position: "fixed",
    display: "none",
    pointerEvents: "none",
    border: "2px solid #2f7df4",
    background: "rgba(47, 125, 244, 0.12)",
    zIndex: "2147483647",
    boxSizing: "border-box",
  });
  document.documentElement.append(overlay);
  return overlay;
}

function anchorFromElement(
  element: Element,
  stableId = makeAnnotationId(),
): BrowserAnnotationAnchor {
  return captureBrowserAnnotationAnchor(element, stableId, window);
}
function rememberSelectedElement(anchor: BrowserAnnotationAnchor, element: Element): void {
  liveAnchors.set(anchor.id, anchor);
  selectedElementsByAnchorId.set(anchor.id, element);
}
function sendElementSelection(element: Element, multiSelect: boolean): void {
  if (!annotationSessionId) return;
  const anchor = anchorFromElement(element);
  rememberSelectedElement(anchor, element);
  ipcRenderer.send("browser-annotation-selection", {
    sessionId: annotationSessionId,
    multiSelect,
    anchor,
  } satisfies BrowserAnnotationSelectionEvent);
}

function scheduleAnchorUpdates(): void {
  if (anchorUpdateFrame !== null) return;
  anchorUpdateFrame = window.requestAnimationFrame(() => {
    anchorUpdateFrame = null;
    const sessionId = annotationSessionId;
    renderMarkers();
    if (!sessionId) return;
    for (const live of liveAnchors.values()) {
      const anchor = resolveLiveAnchor(live);
      if (!anchor) continue;
      ipcRenderer.send("browser-annotation-anchor-update", { sessionId, anchor });
    }
  });
}

function updateOverlay(element: Element | null): void {
  const annotationOverlay = ensureOverlay();
  if (!element) {
    annotationOverlay.style.display = "none";
    return;
  }
  const rect = anchorFromElement(element).rect;
  Object.assign(annotationOverlay.style, {
    display: "block",
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
}

function onAnnotationPointerMove(event: PointerEvent): void {
  if (!annotationActive()) {
    updateOverlay(null);
    return;
  }
  if (annotationSelectionMode === "region") {
    onAnnotationPointerDrag(event);
    return;
  }
  const target = event
    .composedPath()
    .find(
      (candidate) =>
        (candidate as Node).nodeType === 1 &&
        !(candidate as Element).hasAttribute(ANNOTATION_OVERLAY_ATTRIBUTE),
    );
  hoveredElement = target && (target as Node).nodeType === 1 ? (target as Element) : null;
  updateOverlay(hoveredElement);
}

function onAnnotationClick(event: MouseEvent): void {
  if (
    event
      .composedPath()
      .some(
        (item) => item instanceof Element && item.closest("[data-nodex-browser-annotation-marker]"),
      )
  )
    return;
  if (!annotationActive() || annotationSelectionMode !== "inspect") return;
  const selected = event.composedPath().find((item) => (item as Node).nodeType === 1) as
    | Element
    | undefined;
  const element = selected ?? hoveredElement;
  if (!element) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  sendElementSelection(element, event.shiftKey);
}

function onAnnotationPointerDown(event: PointerEvent): void {
  if (
    event
      .composedPath()
      .some(
        (item) => item instanceof Element && item.closest("[data-nodex-browser-annotation-marker]"),
      )
  )
    return;
  if (event.button !== 0 || !annotationActive() || annotationSelectionMode !== "region") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  regionStart = {
    x: event.clientX,
    y: event.clientY,
    pointerId: event.pointerId,
    document:
      (event.currentTarget as Document).nodeType === 9
        ? (event.currentTarget as Document)
        : document,
  };
  updateRegionOverlay(event.clientX, event.clientY);
}

function updateRegionOverlay(x: number, y: number): void {
  if (!regionStart) return;
  const left = Math.min(regionStart.x, x);
  const top = Math.min(regionStart.y, y);
  const width = Math.abs(x - regionStart.x);
  const height = Math.abs(y - regionStart.y);
  const annotationOverlay = ensureOverlay();
  Object.assign(annotationOverlay.style, {
    display: "block",
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
  });
}

function onAnnotationPointerDrag(event: PointerEvent): void {
  if (!regionStart || event.pointerId !== regionStart.pointerId) return;
  if ((event.buttons & 1) === 0) {
    cancelRegionSelection();
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  updateRegionOverlay(event.clientX, event.clientY);
}

function onAnnotationPointerUp(event: PointerEvent): void {
  const start = regionStart;
  if (!annotationSessionId || !start || event.pointerId !== start.pointerId) {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  cancelRegionSelection();
  if (event.button !== 0) return;
  const rect = {
    x: Math.min(start.x, event.clientX),
    y: Math.min(start.y, event.clientY),
    width: Math.abs(event.clientX - start.x),
    height: Math.abs(event.clientY - start.y),
  };
  if (rect.width < 4 || rect.height < 4) return;
  const element =
    hitTestBrowserAnnotation(start.document, start.x, start.y) ?? start.document.documentElement;
  const anchor = captureBrowserAnnotationAnchor(element, makeAnnotationId(), window, rect);
  liveAnchors.set(anchor.id, anchor);
  ipcRenderer.send("browser-annotation-selection", {
    sessionId: annotationSessionId,
    multiSelect: event.shiftKey,
    anchor,
  } satisfies BrowserAnnotationSelectionEvent);
}

function onAnnotationPointerCancel(event: PointerEvent): void {
  if (!regionStart || event.pointerId !== regionStart.pointerId) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  cancelRegionSelection();
}

function cancelRegionSelection(): void {
  if (!regionStart) return;
  regionStart = null;
  updateOverlay(null);
}

function disableAnnotationMode(): void {
  restoreDesignPreview();
  annotationSessionId = null;
  annotationSelectionMode = "inspect";
  hoveredElement = null;
  regionStart = null;

  if (anchorUpdateFrame !== null) {
    window.cancelAnimationFrame(anchorUpdateFrame);
    anchorUpdateFrame = null;
  }

  updateOverlay(null);
  window.removeEventListener("pointermove", onAnnotationPointerMove, true);
  window.removeEventListener("click", onAnnotationClick, true);
  window.removeEventListener("pointerdown", onAnnotationPointerDown, true);
  window.removeEventListener("pointerup", onAnnotationPointerUp, true);
  window.removeEventListener("pointercancel", onAnnotationPointerCancel, true);
}

function enableAnnotationMode(sessionId: string, selectionMode: "inspect" | "region"): void {
  if (annotationSessionId === sessionId && annotationSelectionMode === selectionMode) return;
  disableAnnotationMode();
  annotationSessionId = sessionId;
  annotationSelectionMode = selectionMode;
}

ipcRenderer.on(
  "browser-annotation-mode",
  (
    _event,
    payload: {
      enabled?: unknown;
      selectionMode?: unknown;
      sessionId?: unknown;
      shortcuts?: { bindings: string[]; platform: RuntimePlatform };
    },
  ) => {
    if (payload?.shortcuts) annotationShortcuts = payload.shortcuts;
    if (
      payload?.enabled === true &&
      typeof payload.sessionId === "string" &&
      payload.sessionId.length > 0 &&
      payload.sessionId.length <= 512
    ) {
      enableAnnotationMode(
        payload.sessionId,
        payload.selectionMode === "region" ? "region" : "inspect",
      );
      return;
    }
    disableAnnotationMode();
  },
);

ipcRenderer.on(
  "browser-annotation-quick-select",
  (
    _event,
    payload: {
      sessionId?: unknown;
      x?: unknown;
      y?: unknown;
    },
  ) => {
    if (
      typeof payload?.sessionId !== "string" ||
      payload.sessionId !== annotationSessionId ||
      annotationSelectionMode !== "inspect" ||
      typeof payload.x !== "number" ||
      !Number.isFinite(payload.x) ||
      typeof payload.y !== "number" ||
      !Number.isFinite(payload.y)
    ) {
      return;
    }
    const target = hitTestBrowserAnnotation(document, payload.x, payload.y);
    if (!target || target.hasAttribute(ANNOTATION_OVERLAY_ATTRIBUTE)) return;
    sendElementSelection(target, false);
  },
);

const DESIGN_PROPERTY_TO_CSS_NAME = {
  color: "color",
  backgroundColor: "background-color",
  fontSize: "font-size",
  borderRadius: "border-radius",
  opacity: "opacity",
} as const satisfies Record<BrowserAnnotationDesignChange["property"], string>;

function restoreDesignPreview(): void {
  if (!designPreview) return;
  designPreview.element.style.setProperty(
    DESIGN_PROPERTY_TO_CSS_NAME[designPreview.property],
    designPreview.originalValue,
    designPreview.originalPriority,
  );
  designPreview = null;
}

function isSafeDesignValue(
  property: BrowserAnnotationDesignChange["property"],
  value: string,
): boolean {
  if (
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f]/u.test(value) ||
    /(?:url|expression)\s*\(/iu.test(value)
  ) {
    return false;
  }
  if (property !== "opacity") return true;
  const opacity = Number(value);
  return Number.isFinite(opacity) && opacity >= 0 && opacity <= 1;
}

ipcRenderer.on(
  "browser-annotation-design-preview",
  (
    _event,
    payload: {
      after?: unknown;
      anchorId?: unknown;
      originalView?: unknown;
      property?: unknown;
      sessionId?: unknown;
    },
  ) => {
    restoreDesignPreview();
    if (
      payload?.sessionId !== annotationSessionId ||
      typeof payload.anchorId !== "string" ||
      typeof payload.after !== "string" ||
      typeof payload.property !== "string" ||
      !Object.hasOwn(DESIGN_PROPERTY_TO_CSS_NAME, payload.property)
    ) {
      return;
    }
    if (payload.originalView === true) return;
    const property = payload.property as BrowserAnnotationDesignChange["property"];
    if (!isSafeDesignValue(property, payload.after)) return;
    const anchor = liveAnchors.get(payload.anchorId);
    const frame = anchor ? resolveBrowserAnnotationFrame(document, anchor.framePath ?? []) : null;
    const target =
      selectedElementsByAnchorId.get(payload.anchorId) ??
      (frame && anchor?.selector
        ? resolveBrowserAnnotationSelector(frame, anchor.selector, anchor.shadowHosts)
        : null);
    if (!target?.isConnected || !("style" in target)) return;
    const element = target as HTMLElement;
    const cssName = DESIGN_PROPERTY_TO_CSS_NAME[property];
    designPreview = {
      element,
      property,
      originalPriority: element.style.getPropertyPriority(cssName),
      originalValue: element.style.getPropertyValue(cssName),
    };
    element.style.setProperty(cssName, payload.after, "important");
    scheduleAnchorUpdates();
  },
);

window.addEventListener(
  "mouseup",
  (event) => {
    const direction = event.button === 3 ? "back" : event.button === 4 ? "forward" : null;
    if (!direction) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    ipcRenderer.send("browser-navigation-button", direction);
  },
  true,
);

let browserImageDragToken: string | null = null;

function endBrowserImageDrag(): void {
  const dragToken = browserImageDragToken;
  if (!dragToken) return;
  browserImageDragToken = null;
  ipcRenderer.send("browser-image-drag-ended", dragToken);
}

function findDraggedImage(event: DragEvent): HTMLImageElement | null {
  for (const candidate of event.composedPath()) {
    if (candidate instanceof HTMLImageElement) return candidate;
  }
  return event.target instanceof HTMLImageElement ? event.target : null;
}

window.addEventListener(
  "dragstart",
  (event) => {
    if (!event.isTrusted || !event.dataTransfer) return;
    endBrowserImageDrag();
    const image = findDraggedImage(event);
    const sourceUrl = image?.currentSrc || image?.src || "";
    if (!sourceUrl || sourceUrl.length > 16_384) return;
    // getRandomValues is available on HTTP pages as well as secure origins.
    const dragToken = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    event.dataTransfer.setData(browserImageDragType(dragToken), dragToken);
    browserImageDragToken = dragToken;
    // Write the type synchronously but wait for the page's dragstart handlers
    // to finish before publishing the intent.
    setTimeout(() => {
      if (browserImageDragToken !== dragToken) return;
      if (event.defaultPrevented) {
        browserImageDragToken = null;
        return;
      }
      ipcRenderer.send("browser-image-drag-started", { sourceUrl, dragToken });
    }, 0);
  },
  true,
);

window.addEventListener(
  "dragend",
  (event) => {
    if (event.isTrusted) endBrowserImageDrag();
  },
  true,
);

interface BrowserCredentialFillPayload {
  origin: string;
  username: string;
  password: string;
  kind: "generated" | "saved";
}

interface BrowserContactInfoFillPayload {
  origin: string;
  contactInfo: {
    fullName: string;
    email: string;
    phone: string;
    addressLine1: string;
    addressLine2: string;
    city: string;
    region: string;
    postalCode: string;
    country: string;
  };
}

function isUsableFormInput(input: HTMLInputElement): boolean {
  return !input.disabled && !input.readOnly && input.type !== "hidden" && input.isConnected;
}

function readCredentialForm(target: EventTarget | null): {
  username: string;
  password: string;
} | null {
  const form =
    target instanceof HTMLFormElement
      ? target
      : target instanceof Element
        ? target.closest("form")
        : null;
  if (!form) return null;
  const inputs = [...form.querySelectorAll("input")].filter(
    (input): input is HTMLInputElement =>
      input instanceof HTMLInputElement && isUsableFormInput(input),
  );
  const passwordInput = inputs.find((input) => input.type === "password");
  if (!passwordInput?.value || passwordInput.value.length > 1024 * 1024) {
    return null;
  }
  const usernameInput =
    inputs.find((input) => input.autocomplete === "username" || input.autocomplete === "email") ??
    inputs.find((input) => input.type === "email") ??
    inputs.find(
      (input) =>
        input.type === "text" &&
        input.compareDocumentPosition(passwordInput) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  const username = usernameInput?.value ?? "";
  if (username.length > 8_192) return null;
  return {
    username,
    password: passwordInput.value,
  };
}

function onCredentialFormSubmit(event: SubmitEvent): void {
  const credential = readCredentialForm(event.target);
  if (!credential) return;
  ipcRenderer.send("browser-credential-save-candidate", credential);
}

function setFormInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  descriptor?.set?.call(input, value);
  input.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertReplacementText",
      data: value,
    }),
  );
  input.dispatchEvent(
    new Event("change", {
      bubbles: true,
      composed: true,
    }),
  );
}

function fillCredential(payload: BrowserCredentialFillPayload): void {
  let currentOrigin: string;
  try {
    currentOrigin = new URL(window.location.href).origin;
  } catch {
    return;
  }
  if (
    payload.origin !== currentOrigin ||
    typeof payload.username !== "string" ||
    typeof payload.password !== "string" ||
    !payload.password ||
    payload.password.length > 1024 * 1024 ||
    (payload.kind !== "saved" && payload.kind !== "generated")
  ) {
    return;
  }
  const inputs = [...document.querySelectorAll("input")].filter(
    (input): input is HTMLInputElement =>
      input instanceof HTMLInputElement && isUsableFormInput(input),
  );
  const passwordInputs = inputs.filter((input) => input.type === "password");
  const targetPasswords =
    payload.kind === "generated"
      ? passwordInputs.filter((input) => input.autocomplete === "new-password")
      : passwordInputs.filter((input) => input.autocomplete !== "new-password");
  const passwords = targetPasswords.length > 0 ? targetPasswords : passwordInputs.slice(0, 1);
  if (passwords.length === 0) return;

  if (payload.kind === "saved" && payload.username) {
    const usernameInput =
      inputs.find((input) => input.autocomplete === "username" || input.autocomplete === "email") ??
      inputs.find((input) => input.type === "email");
    if (usernameInput) setFormInputValue(usernameInput, payload.username);
  }
  for (const passwordInput of passwords) {
    setFormInputValue(passwordInput, payload.password);
  }
  passwords[0]?.focus();
}

function fillContactInfo(payload: BrowserContactInfoFillPayload): void {
  let currentOrigin: string;
  try {
    currentOrigin = new URL(window.location.href).origin;
  } catch {
    return;
  }
  if (payload.origin !== currentOrigin) return;
  const valuesByAutocomplete: Record<string, string> = {
    name: payload.contactInfo.fullName,
    email: payload.contactInfo.email,
    tel: payload.contactInfo.phone,
    "street-address": [payload.contactInfo.addressLine1, payload.contactInfo.addressLine2]
      .filter(Boolean)
      .join("\n"),
    "address-line1": payload.contactInfo.addressLine1,
    "address-line2": payload.contactInfo.addressLine2,
    "address-level2": payload.contactInfo.city,
    "address-level1": payload.contactInfo.region,
    "postal-code": payload.contactInfo.postalCode,
    country: payload.contactInfo.country,
    "country-name": payload.contactInfo.country,
  };
  let firstFilled: HTMLInputElement | null = null;
  for (const input of document.querySelectorAll("input")) {
    if (!(input instanceof HTMLInputElement) || !isUsableFormInput(input)) continue;
    const autocompleteToken = input.autocomplete.trim().split(/\s+/u).at(-1) ?? "";
    const fallbackToken = input.type === "email" ? "email" : input.type === "tel" ? "tel" : "";
    const value =
      valuesByAutocomplete[autocompleteToken] ?? valuesByAutocomplete[fallbackToken] ?? "";
    if (!value) continue;
    setFormInputValue(input, value);
    firstFilled ??= input;
  }
  firstFilled?.focus();
}

window.addEventListener("submit", onCredentialFormSubmit, true);

ipcRenderer.on("browser-credential-fill", (_event, rawPayload: unknown) => {
  if (typeof rawPayload !== "object" || rawPayload === null || Array.isArray(rawPayload)) {
    return;
  }
  const payload = rawPayload as Partial<BrowserCredentialFillPayload>;
  if (
    typeof payload.origin !== "string" ||
    typeof payload.username !== "string" ||
    typeof payload.password !== "string" ||
    (payload.kind !== "saved" && payload.kind !== "generated")
  ) {
    return;
  }
  fillCredential(payload as BrowserCredentialFillPayload);
});

ipcRenderer.on("browser-contact-info-fill", (_event, rawPayload: unknown) => {
  if (typeof rawPayload !== "object" || rawPayload === null || Array.isArray(rawPayload)) {
    return;
  }
  const payload = rawPayload as Partial<BrowserContactInfoFillPayload>;
  if (
    typeof payload.origin !== "string" ||
    typeof payload.contactInfo !== "object" ||
    payload.contactInfo === null
  ) {
    return;
  }
  const values = Object.values(payload.contactInfo);
  if (
    values.length !== 9 ||
    values.some((value) => typeof value !== "string" || value.length > 4_096)
  ) {
    return;
  }
  fillContactInfo(payload as BrowserContactInfoFillPayload);
});

function resolveLiveAnchor(
  anchor: BrowserAnnotationAnchor | undefined,
): BrowserAnnotationAnchor | null {
  if (!anchor || anchor.pageUrl !== location.href) return null;
  return resolveBrowserAnnotationAnchor(document, anchor);
}
function renderMarkers(): void {
  if (!document.documentElement) return;
  if (!markerRoot) {
    markerRoot = document.createElement("div");
    markerRoot.setAttribute(ANNOTATION_OVERLAY_ATTRIBUTE, "");
    Object.assign(markerRoot.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "2147483647",
    });
    document.documentElement.append(markerRoot);
  }
  const visible = savedAnnotations.filter(
    (annotation) => annotation.pageUrl === location.href && annotation.deliveryState !== "sending",
  );
  for (const child of Array.from(markerRoot.children)) {
    if (
      !visible.some((annotation) => annotation.id === (child as HTMLElement).dataset.annotationId)
    )
      child.remove();
  }
  for (const annotation of visible) {
    const anchor = annotation.anchors[0];
    if (!anchor) continue;
    if (!liveAnchors.has(anchor.id)) liveAnchors.set(anchor.id, anchor);
    const resolved = resolveLiveAnchor(liveAnchors.get(anchor.id));
    let marker = Array.from(markerRoot.children).find(
      (child) => (child as HTMLElement).dataset.annotationId === annotation.id,
    ) as HTMLButtonElement | undefined;
    if (!marker) {
      marker = document.createElement("button");
      marker.type = "button";
      marker.dataset.annotationId = annotation.id;
      marker.setAttribute("data-nodex-browser-annotation-marker", "");
      marker.setAttribute("aria-label", `Annotation ${annotation.number}`);
      marker.textContent = String(annotation.number);
      Object.assign(marker.style, {
        position: "absolute",
        pointerEvents: "auto",
        width: "24px",
        height: "24px",
        border: "0",
        borderRadius: "50%",
        background: "#2f7df4",
        color: "white",
        font: "600 12px system-ui",
        cursor: "pointer",
      });
      marker.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        ipcRenderer.send("browser-annotation-open", {
          annotationId: annotation.id,
          anchor: resolveLiveAnchor(liveAnchors.get(anchor.id)),
        });
      });
      markerRoot.append(marker);
    }
    marker.style.display =
      resolved &&
      !evidenceToken &&
      annotationPinsVisible &&
      resolved.rect.y + resolved.rect.height >= 0 &&
      resolved.rect.y <= innerHeight
        ? "block"
        : "none";
    if (resolved) {
      marker.style.left = `${Math.max(0, Math.min(innerWidth - 24, resolved.rect.x))}px`;
      marker.style.top = `${Math.max(0, resolved.rect.y - 12)}px`;
    }
  }
}
ipcRenderer.on("browser-annotation-saved", (_event, annotations: BrowserSavedAnnotation[]) => {
  savedAnnotations = annotations;
  renderMarkers();
});
ipcRenderer.on(
  "browser-annotation-evidence-prepare",
  (_event, input: { token: string; annotationId: string }) => {
    evidenceToken = input.token;
    updateOverlay(null);
    renderMarkers();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (evidenceToken === input.token)
          ipcRenderer.send("browser-annotation-evidence-ready", {
            token: input.token,
            anchors: (
              savedAnnotations.find((annotation) => annotation.id === input.annotationId)
                ?.anchors ?? []
            )
              .map((anchor) => resolveLiveAnchor(liveAnchors.get(anchor.id) ?? anchor))
              .filter((anchor) => anchor !== null),
          });
      }),
    );
  },
);
ipcRenderer.on("browser-annotation-evidence-clear", (_event, input: { token: string }) => {
  if (evidenceToken !== input.token) return;
  evidenceToken = null;
  renderMarkers();
});
ipcRenderer.on(
  "browser-annotation-presentation",
  (_event, input: { suspended: boolean; pinsVisible: boolean; agentControlled: boolean }) => {
    annotationSuspended = input.suspended;
    annotationPinsVisible = input.pinsVisible;
    annotationAgentControlled = input.agentControlled;
    if (!annotationActive()) {
      regionStart = null;
      restoreDesignPreview();
      updateOverlay(null);
    }
    renderMarkers();
  },
);
function suspendAnnotation(suspended: boolean): void {
  if (annotationSuspended === suspended) return;
  annotationSuspended = suspended;
  if (suspended) {
    regionStart = null;
    restoreDesignPreview();
    updateOverlay(null);
  }
  ipcRenderer.send("browser-annotation-suspend", { suspended });
}
let workbenchShortcuts: BrowserGuestShortcutBindings | undefined;
ipcRenderer.on("browser-workbench-shortcuts", (_event, shortcuts: typeof workbenchShortcuts) => {
  workbenchShortcuts = shortcuts;
});

function isGuestTextInput(event: KeyboardEvent): boolean {
  return event.composedPath().some((target) => {
    const element = target as HTMLElement;
    return (
      typeof element.closest === "function" &&
      (element.isContentEditable || element.matches("input,textarea,select,[role='textbox']"))
    );
  });
}

function onWorkbenchGuestKeyDown(event: KeyboardEvent): void {
  const shortcuts = workbenchShortcuts;
  if (!shortcuts || !event.isTrusted || !mayUseGuestShortcut(event)) return;
  if (!event.metaKey && !event.ctrlKey && isGuestTextInput(event)) return;
  if (isBrowserEditingChord(event)) return;

  const match = (bindings: string[]) =>
    bindings.find((binding) =>
      matchesKeyboardEventToAccelerator(event, binding, shortcuts.platform),
    );

  if (!guestShortcutUsesNativeIngress(event)) {
    for (const item of shortcuts.reserved) {
      const binding = match(item.bindings);
      if (!binding) continue;
      event.preventDefault();
      event.stopImmediatePropagation();
      ipcRenderer.send("browser-workbench-shortcut", item.commandId, binding);
      return;
    }
  }

  for (const item of shortcuts.pageFirst) {
    const binding = match(item.bindings);
    if (!binding) continue;
    // A task boundary lets even later page handlers decide whether to cancel the event.
    setTimeout(() => {
      if (!event.defaultPrevented)
        ipcRenderer.send("browser-workbench-shortcut", item.commandId, binding);
    }, 0);
    return;
  }
}

window.addEventListener("keydown", onWorkbenchGuestKeyDown, true);

function mayUseGuestShortcut(event: KeyboardEvent): boolean {
  return (
    !event.isComposing &&
    !event.repeat &&
    event.keyCode !== 229 &&
    !["Process", "Dead", "AltGraph"].includes(event.key) &&
    !event.getModifierState("AltGraph")
  );
}

function onAnnotationKeyDown(event: KeyboardEvent): void {
  if (!event.isTrusted || event.defaultPrevented || !mayUseGuestShortcut(event)) return;
  if (
    annotationShortcuts.bindings.some((binding) =>
      matchesKeyboardEventToAccelerator(event, binding, annotationShortcuts.platform),
    )
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    ipcRenderer.send("browser-annotation-toggle");
    return;
  }
  if (!annotationActive()) return;
  if (
    event.composedPath().some((target) => {
      const element = target as Element;
      return (
        typeof element.matches === "function" &&
        element.matches('dialog,[role="dialog"],[role="alertdialog"],[role="menu"]')
      );
    })
  )
    return;
  if (
    event.code === "Space" &&
    !isGuestTextInput(event) &&
    !event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey
  ) {
    event.preventDefault();
    suspendAnnotation(true);
    return;
  }
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (regionStart) {
    cancelRegionSelection();
    return;
  }
  ipcRenderer.send("browser-annotation-cancel");
}
const observedDocuments = new WeakSet<Document>();
const observedFrames = new WeakSet<Element>();
const observedRoots = new WeakSet<Node>();
function discoverAnnotationFrames(root: Document | ShadowRoot): void {
  for (const element of root.querySelectorAll("*")) {
    if (element.shadowRoot) {
      observeAnnotationRoot(element.shadowRoot);
      discoverAnnotationFrames(element.shadowRoot);
    }
    if (element.localName !== "iframe") continue;
    const frame = element as HTMLIFrameElement;
    const attach = () => {
      try {
        if (frame.contentDocument) observeAnnotationDocument(frame.contentDocument);
      } catch {
        /* Cross-origin frames are opaque. */
      }
    };
    if (!observedFrames.has(frame)) {
      observedFrames.add(frame);
      frame.addEventListener("load", attach);
    }
    attach();
  }
}
function observeAnnotationRoot(root: Document | ShadowRoot): void {
  if (observedRoots.has(root)) return;
  observedRoots.add(root);
  const observer = new MutationObserver((mutations) => {
    if (
      mutations.every((mutation) =>
        (mutation.target.nodeType === 1
          ? (mutation.target as Element)
          : mutation.target.parentElement
        )?.closest(`[${ANNOTATION_OVERLAY_ATTRIBUTE}]`),
      )
    )
      return;
    if (mutations.some((mutation) => mutation.type === "childList"))
      discoverAnnotationFrames(root.ownerDocument ?? (root as Document));
    scheduleAnchorUpdates();
  });
  observer.observe(root.nodeType === 9 ? (root as Document).documentElement : root, {
    attributes: true,
    childList: true,
    subtree: true,
    characterData: true,
  });
}
function observeAnnotationDocument(doc: Document): void {
  if (observedDocuments.has(doc) || !doc.documentElement) return;
  observedDocuments.add(doc);
  doc.addEventListener("pointerover", () => discoverAnnotationFrames(doc), true);
  doc.addEventListener("pointermove", onAnnotationPointerMove, true);
  doc.addEventListener("click", onAnnotationClick, true);
  doc.addEventListener("pointerdown", onAnnotationPointerDown, true);
  doc.addEventListener("pointerup", onAnnotationPointerUp, true);
  doc.addEventListener("pointercancel", onAnnotationPointerCancel, true);
  doc.addEventListener("keydown", onAnnotationKeyDown, true);
  if (doc !== document) doc.defaultView?.addEventListener("keydown", onWorkbenchGuestKeyDown, true);
  doc.addEventListener(
    "keyup",
    (event) => {
      if (event.code === "Space" && annotationSuspended) {
        event.preventDefault();
        suspendAnnotation(false);
      }
    },
    true,
  );
  doc.addEventListener("scroll", scheduleAnchorUpdates, true);
  doc.defaultView?.addEventListener("resize", scheduleAnchorUpdates);
  const cancelDocumentRegion = () => {
    if (doc === document || doc === regionStart?.document) cancelRegionSelection();
  };
  doc.defaultView?.addEventListener("blur", () => {
    cancelDocumentRegion();
    suspendAnnotation(false);
  });
  doc.defaultView?.addEventListener("pagehide", cancelDocumentRegion);
  observeAnnotationRoot(doc);
  discoverAnnotationFrames(doc);
}
if (document.documentElement) observeAnnotationDocument(document);
else
  window.addEventListener("DOMContentLoaded", () => observeAnnotationDocument(document), {
    once: true,
  });
window.addEventListener("hashchange", scheduleAnchorUpdates);
window.addEventListener("popstate", scheduleAnchorUpdates);
