import { afterEach, expect, test } from "vite-plus/test";
import {
  TYPOGRAPHY_STORAGE_KEY,
  DEFAULT_TYPOGRAPHY_PREFERENCES,
  applyTypographyPreferences,
} from "../lib/typography-preferences";

let frame: HTMLIFrameElement | null = null;
afterEach(() => {
  frame?.remove();
  frame = null;
  localStorage.removeItem(TYPOGRAPHY_STORAGE_KEY);
  document.documentElement.removeAttribute("style");
  document.body.removeAttribute("style");
});

async function loadParserBootstrapDocument(): Promise<Document> {
  frame = document.createElement("iframe");
  const loaded = new Promise<void>((resolve) =>
    frame!.addEventListener("load", () => resolve(), { once: true }),
  );
  frame.srcdoc = `<html data-theme="dark"><head><script src="${location.origin}/typography-bootstrap.js"></script><script>
    document.documentElement.dataset.parserBodyPresent = String(document.body !== null);
    document.documentElement.dataset.parserFontSmoothing = getComputedStyle(document.documentElement).getPropertyValue("-webkit-font-smoothing");
  </script><style>
    #ui { font: var(--font-ui-size)/1.5 var(--font-ui-family); }
    #chat { font: var(--codex-chat-font-size)/1.5 var(--font-content); }
    #code { font: var(--codex-chat-code-font-size)/1.5 var(--font-mono); }
    #page { font: var(--text-document)/1.5 var(--font-content); }
  </style></head><body><p id="ui">UI</p><p id="chat">Chat</p><pre id="code">Code</pre><p id="page">Page</p></body></html>`;
  document.body.append(frame);
  await loaded;
  return frame.contentDocument!;
}

test.each(["inherit", "Arial,"])(
  "invalid font family %s retains system and monospace fallbacks",
  (family) => {
    applyTypographyPreferences(
      document.documentElement,
      document.body,
      {
        ...DEFAULT_TYPOGRAPHY_PREFERENCES,
        fonts: {
          ...DEFAULT_TYPOGRAPHY_PREFERENCES.fonts,
          light: { ui: family, content: family, code: family },
        },
      },
      "light",
    );
    const ui = document.createElement("span");
    const code = document.createElement("code");
    ui.style.fontFamily = "var(--font-sans)";
    code.style.fontFamily = "var(--font-code-family)";
    document.body.append(ui, code);
    try {
      expect(getComputedStyle(ui).fontFamily).toContain("-apple-system");
      expect(getComputedStyle(code).fontFamily).toContain("monospace");
    } finally {
      ui.remove();
      code.remove();
    }
  },
);

test("restores saved typography with only the parser bootstrap and no application modules", async () => {
  localStorage.setItem(
    TYPOGRAPHY_STORAGE_KEY,
    JSON.stringify({
      ...DEFAULT_TYPOGRAPHY_PREFERENCES,
      uiFontSize: 16,
      codeFontSize: 20,
      pageFontSize: 18,
      useFontSmoothing: false,
      fonts: {
        ...DEFAULT_TYPOGRAPHY_PREFERENCES.fonts,
        dark: { ui: "Arial", content: "Georgia", code: "Monaco" },
      },
    }),
  );
  const doc = await loadParserBootstrapDocument();
  const view = doc.defaultView!;
  const style = (id: string) => view.getComputedStyle(doc.getElementById(id)!);
  expect(style("ui").fontSize).toBe("16px");
  expect(style("chat").fontSize).toBe("16px");
  expect(style("code").fontSize).toBe("20px");
  expect(style("page").fontSize).toBe("18px");
  expect(style("ui").fontFamily).toContain("Arial");
  expect(style("chat").fontFamily).toContain("Georgia");
  expect(doc.documentElement.style.getPropertyValue("--font-ui-size")).toBe("16px");
  expect(doc.body.style.getPropertyValue("--font-ui-size")).toBe("16px");
  expect(doc.documentElement.dataset.parserBodyPresent).toBe("false");
  expect(doc.documentElement.dataset.parserFontSmoothing).toBe("auto");
  expect(doc.documentElement.style.getPropertyValue("-webkit-font-smoothing")).toBe("auto");
  expect(doc.body.style.getPropertyValue("-webkit-font-smoothing")).toBe("auto");
  expect(style("page").getPropertyValue("-webkit-font-smoothing")).toBe("auto");
});

test.each(["missing", "existing"])(
  "%s typography preferences enable font smoothing before application modules load",
  async (storage) => {
    if (storage === "existing") {
      localStorage.setItem(TYPOGRAPHY_STORAGE_KEY, JSON.stringify({ uiFontSize: 16 }));
    }
    const doc = await loadParserBootstrapDocument();
    expect(doc.documentElement.dataset.parserBodyPresent).toBe("false");
    expect(doc.documentElement.dataset.parserFontSmoothing).toBe("antialiased");
    expect(doc.documentElement.style.getPropertyValue("-webkit-font-smoothing")).toBe(
      "antialiased",
    );
    expect(doc.body.style.getPropertyValue("-webkit-font-smoothing")).toBe("antialiased");
    expect(
      doc
        .defaultView!.getComputedStyle(doc.getElementById("page")!)
        .getPropertyValue("-webkit-font-smoothing"),
    ).toBe("antialiased");
  },
);
