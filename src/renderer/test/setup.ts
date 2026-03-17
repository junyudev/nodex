import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup } from "@testing-library/react";

const nativeRequest = Request;
const nativeResponse = Response;
const nativeHeaders = Headers;
const nativeFetch = fetch;
const nativeURL = URL;
const nativeCSS = globalThis.CSS ?? {
  escape(value: string) {
    return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  },
};

GlobalRegistrator.register({
  url: "http://localhost:51283/",
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const browserWindow = window;
const browserDocument = document;
const browserLocalStorage = localStorage;

function ensureHtmlDoctype() {
  if (document.doctype?.name.toLowerCase() === "html") return;
  const documentType = document.implementation.createDocumentType("html", "", "");
  document.insertBefore(documentType, document.documentElement);
}

function ensureStandardsMode() {
  if (document.compatMode === "CSS1Compat") return;
  Object.defineProperty(document, "compatMode", {
    configurable: true,
    value: "CSS1Compat",
  });
}

function restoreBrowserGlobals() {
  Object.defineProperty(globalThis, "Request", {
    configurable: true,
    writable: true,
    value: nativeRequest,
  });
  Object.defineProperty(globalThis, "Response", {
    configurable: true,
    writable: true,
    value: nativeResponse,
  });
  Object.defineProperty(globalThis, "Headers", {
    configurable: true,
    writable: true,
    value: nativeHeaders,
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: nativeFetch,
  });
  Object.defineProperty(globalThis, "URL", {
    configurable: true,
    writable: true,
    value: nativeURL,
  });
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    writable: true,
    value: nativeCSS,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: browserWindow,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: browserDocument,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: browserLocalStorage,
  });
}

restoreBrowserGlobals();
ensureHtmlDoctype();
ensureStandardsMode();

afterEach(() => {
  try {
    cleanup();
  } finally {
    restoreBrowserGlobals();
    ensureHtmlDoctype();
    ensureStandardsMode();
    document.body.innerHTML = "";
  }
});
