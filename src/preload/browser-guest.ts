import { ipcRenderer } from "electron";
import { installBrowserWebMcp } from "./browser-webmcp";
import type {
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
let regionStart: { x: number; y: number; pointerId: number } | null = null;
const selectedElementsByAnchorId = new Map<string, Element>();
let anchorUpdateFrame: number | null = null;
let annotationMutationObserver: MutationObserver | null = null;
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

function elementSelector(element: Element): string {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement && parts.length < 8) {
    const tagName = current.tagName.toLowerCase();
    const parentElement: Element | null = current.parentElement;
    if (!parentElement) {
      parts.unshift(tagName);
      break;
    }
    const siblings = [...parentElement.children].filter(
      (candidate) => candidate.tagName === current?.tagName,
    );
    const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
    parts.unshift(`${tagName}${suffix}`);
    current = parentElement;
  }
  return parts.join(" > ");
}

function textExcerpt(element: Element): string | undefined {
  const text = element.textContent?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 2_048) : undefined;
}

function readComputedStyle(element: Element): BrowserAnnotationAnchor["computedStyle"] {
  const styles = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!styles) return undefined;
  return {
    color: styles.color.slice(0, 512),
    backgroundColor: styles.backgroundColor.slice(0, 512),
    fontSize: styles.fontSize.slice(0, 512),
    borderRadius: styles.borderRadius.slice(0, 512),
    opacity: styles.opacity.slice(0, 512),
  };
}

function anchorFromElement(
  element: Element,
  stableId = makeAnnotationId(),
): BrowserAnnotationAnchor {
  const selection = window.getSelection();
  const selectedText = selection?.toString().replace(/\s+/g, " ").trim();
  const rangeRect =
    selectedText && selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
  const rect =
    rangeRect && rangeRect.width > 0 && rangeRect.height > 0
      ? rangeRect
      : element.getBoundingClientRect();
  return {
    id: stableId,
    kind: rangeRect ? "text" : "element",
    pageUrl: window.location.href,
    frameUrl: window.location.href,
    framePath: [],
    elementPath: elementSelector(element),
    selector: elementSelector(element),
    textExcerpt: selectedText?.slice(0, 2_048) || textExcerpt(element),
    nearbyText: textExcerpt(element),
    computedStyle: readComputedStyle(element),
    viewportSize: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    rect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
  };
}

function rememberSelectedElement(anchor: BrowserAnnotationAnchor, element: Element): void {
  if (anchor.kind !== "element") return;
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
  if (!annotationSessionId || anchorUpdateFrame !== null) return;
  anchorUpdateFrame = window.requestAnimationFrame(() => {
    anchorUpdateFrame = null;
    const sessionId = annotationSessionId;
    if (!sessionId) return;
    for (const [anchorId, element] of selectedElementsByAnchorId) {
      if (!element.isConnected) {
        selectedElementsByAnchorId.delete(anchorId);
        continue;
      }
      ipcRenderer.send("browser-annotation-anchor-update", {
        sessionId,
        anchor: anchorFromElement(element, anchorId),
      });
    }
  });
}

function updateOverlay(element: Element | null): void {
  const annotationOverlay = ensureOverlay();
  if (!element) {
    annotationOverlay.style.display = "none";
    return;
  }
  const rect = element.getBoundingClientRect();
  Object.assign(annotationOverlay.style, {
    display: "block",
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
}

function onAnnotationPointerMove(event: PointerEvent): void {
  const target = event
    .composedPath()
    .find(
      (candidate) =>
        candidate instanceof Element && !candidate.hasAttribute(ANNOTATION_OVERLAY_ATTRIBUTE),
    );
  hoveredElement = target instanceof Element ? target : null;
  updateOverlay(hoveredElement);
}

function onAnnotationClick(event: MouseEvent): void {
  if (!annotationSessionId || annotationSelectionMode !== "inspect" || !hoveredElement) {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  sendElementSelection(hoveredElement, event.shiftKey);
}

function onAnnotationPointerDown(event: PointerEvent): void {
  if (!annotationSessionId || annotationSelectionMode !== "region") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  regionStart = {
    x: event.clientX,
    y: event.clientY,
    pointerId: event.pointerId,
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
  regionStart = null;
  const rect = {
    x: Math.min(start.x, event.clientX),
    y: Math.min(start.y, event.clientY),
    width: Math.abs(event.clientX - start.x),
    height: Math.abs(event.clientY - start.y),
  };
  updateOverlay(null);
  if (rect.width < 4 || rect.height < 4) return;
  ipcRenderer.send("browser-annotation-selection", {
    sessionId: annotationSessionId,
    multiSelect: event.shiftKey,
    anchor: {
      id: makeAnnotationId(),
      kind: "region",
      pageUrl: window.location.href,
      frameUrl: window.location.href,
      framePath: [],
      viewportSize: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      rect,
    },
  } satisfies BrowserAnnotationSelectionEvent);
}

function onAnnotationPointerCancel(event: PointerEvent): void {
  if (!regionStart || event.pointerId !== regionStart.pointerId) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  regionStart = null;
  updateOverlay(null);
}

function disableAnnotationMode(): void {
  restoreDesignPreview();
  annotationSessionId = null;
  annotationSelectionMode = "inspect";
  hoveredElement = null;
  regionStart = null;
  selectedElementsByAnchorId.clear();
  if (anchorUpdateFrame !== null) {
    window.cancelAnimationFrame(anchorUpdateFrame);
    anchorUpdateFrame = null;
  }
  annotationMutationObserver?.disconnect();
  annotationMutationObserver = null;
  updateOverlay(null);
  window.removeEventListener("pointermove", onAnnotationPointerMove, true);
  window.removeEventListener("click", onAnnotationClick, true);
  window.removeEventListener("pointerdown", onAnnotationPointerDown, true);
  window.removeEventListener("pointermove", onAnnotationPointerDrag, true);
  window.removeEventListener("pointerup", onAnnotationPointerUp, true);
  window.removeEventListener("pointercancel", onAnnotationPointerCancel, true);
  window.removeEventListener("scroll", scheduleAnchorUpdates, true);
  window.removeEventListener("resize", scheduleAnchorUpdates, true);
}

function enableAnnotationMode(sessionId: string, selectionMode: "inspect" | "region"): void {
  disableAnnotationMode();
  annotationSessionId = sessionId;
  annotationSelectionMode = selectionMode;
  window.addEventListener("scroll", scheduleAnchorUpdates, true);
  window.addEventListener("resize", scheduleAnchorUpdates, true);
  annotationMutationObserver = new MutationObserver(scheduleAnchorUpdates);
  annotationMutationObserver.observe(document.documentElement, {
    attributes: true,
    childList: true,
    subtree: true,
  });
  if (selectionMode === "region") {
    window.addEventListener("pointerdown", onAnnotationPointerDown, true);
    window.addEventListener("pointermove", onAnnotationPointerDrag, true);
    window.addEventListener("pointerup", onAnnotationPointerUp, true);
    window.addEventListener("pointercancel", onAnnotationPointerCancel, true);
    return;
  }
  window.addEventListener("pointermove", onAnnotationPointerMove, true);
  window.addEventListener("click", onAnnotationClick, true);
}

ipcRenderer.on(
  "browser-annotation-mode",
  (
    _event,
    payload: {
      enabled?: unknown;
      selectionMode?: unknown;
      sessionId?: unknown;
    },
  ) => {
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
    const target = document.elementFromPoint(payload.x, payload.y);
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
    const element = selectedElementsByAnchorId.get(payload.anchorId);
    if (!(element instanceof HTMLElement) || !element.isConnected) return;
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

let browserImageDragActive = false;

function findDraggedImage(event: DragEvent): HTMLImageElement | null {
  for (const candidate of event.composedPath()) {
    if (candidate instanceof HTMLImageElement) return candidate;
  }
  return event.target instanceof HTMLImageElement ? event.target : null;
}

window.addEventListener(
  "dragstart",
  (event) => {
    if (!event.isTrusted) return;
    const image = findDraggedImage(event);
    const sourceUrl = image?.currentSrc || image?.src || "";
    if (!sourceUrl || sourceUrl.length > 16_384) return;
    browserImageDragActive = true;
    ipcRenderer.send("browser-image-drag-started", { sourceUrl });
  },
  true,
);

window.addEventListener(
  "dragend",
  (event) => {
    if (!event.isTrusted || !browserImageDragActive) return;
    browserImageDragActive = false;
    ipcRenderer.send("browser-image-drag-ended");
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
