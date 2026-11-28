import { createIntl } from "@formatjs/intl";
import {
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  nodexMark,
  renderCardPng,
  renderShareCard,
  shareFileName,
  shareMessage,
  svgImageSource,
  type ShareCardKind,
} from "@nodex/insights-cards";
import zhCN from "@nodex/insights-cards/catalogs/zh-CN.json";
import geistMono from "@nodex/insights-cards/fonts/geist-mono.woff2";
import geistSans from "@nodex/insights-cards/fonts/geist-sans.woff2";

import type { Locale } from "../locale";
import { pageCopy } from "./copy";
import { MAX_NAME_LENGTH, type PreviewData } from "./data";

const fonts = { sans: geistSans, mono: geistMono };
// The page speaks in the cards' typeface; the font is already here for them.
document.fonts.add(new FontFace("Geist", `url(${geistSans})`, { weight: "100 900" }));
const kinds = ["skyline", "receipt"] as const;
type Action = "copy" | "save" | "post";
type Theme = "dark" | "light";

function element<T extends Element>(selector: string, root: ParentNode = document): T {
  const match = root.querySelector<T>(selector);
  if (!match) throw new Error(`Missing preview element: ${selector}`);
  return match;
}

function pngBlob(dataUrl: string): Blob {
  // Decoding locally keeps canvas exports compatible with connect-src 'none'.
  const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) =>
    c.charCodeAt(0),
  );
  return new Blob([bytes], { type: "image/png" });
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const data = JSON.parse(element("#preview-data").textContent ?? "") as PreviewData;
const { view, hasCost } = data;
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
let themeOverride: Theme | undefined;
let locale = data.locale;
let copy = pageCopy[locale];
let intl: ReturnType<typeof intlFor>;
let exportTimer: number | undefined;
let toastTimer: number | undefined;
let renderRevision = 0;

const section = element<HTMLElement>("#cards");
const template = element<HTMLTemplateElement>("#card-template");
const name = element<HTMLInputElement>("#name");
const showCost = element<HTMLInputElement>("#show-cost");
const dark = element<HTMLButtonElement>("#dark");
const light = element<HTMLButtonElement>("#light");
const english = element<HTMLButtonElement>("#english");
const chinese = element<HTMLButtonElement>("#chinese");
const toast = element<HTMLElement>("#toast");

element("#mark").innerHTML = nodexMark(0, 0, 800, "currentColor", "currentColor");
name.maxLength = MAX_NAME_LENGTH;
name.value = data.name;
element<HTMLElement>("#cost-control").hidden = !hasCost;

function intlFor(language: Locale) {
  return createIntl({
    locale: language,
    defaultLocale: "en-US",
    messages: language === "zh-CN" ? zhCN : {},
  });
}

const costShown = () => hasCost && showCost.checked;

function announce(text: string) {
  window.clearTimeout(toastTimer);
  toast.textContent = text;
  toastTimer = window.setTimeout(() => {
    toast.textContent = "";
  }, 3200);
}

async function share(kind: ShareCardKind, action: Action, blob: Blob | null) {
  if (!blob) {
    announce(copy.failed);
    return;
  }

  try {
    if (action === "save") {
      download(blob, shareFileName(view, kind));
      announce(copy.saved);
      return;
    }

    const writing = navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    if (action === "post") {
      // Start the write and open the composer before the click's activation expires.
      const text = encodeURIComponent(shareMessage(view, intl, { showCost: costShown() }));
      window.open(`https://x.com/intent/post?text=${text}`, "_blank", "noopener,noreferrer");
    }
    await writing;
    announce(action === "post" ? copy.copiedForPost : copy.copied);
  } catch {
    announce(copy.failed);
  }
}

function makeCard(kind: ShareCardKind) {
  const fragment = template.content.cloneNode(true) as DocumentFragment;
  const image = element<HTMLImageElement>("img", fragment);
  image.width = SHARE_CARD_WIDTH;
  image.height = SHARE_CARD_HEIGHT;
  const toolbar = element<HTMLElement>(".toolbar", fragment);
  const bindings = (["copy", "save", "post"] as const).map((action) => ({
    action,
    button: element<HTMLButtonElement>(`[data-copy="${action}"]`, toolbar),
  }));
  let blob: Blob | null = null;
  let preparing = false;

  for (const { action, button } of bindings) {
    button.addEventListener("click", () => {
      if (!preparing) void share(kind, action, blob);
    });
  }
  section.append(fragment);

  function setPreparing(value: boolean) {
    preparing = value;
    for (const { button } of bindings) button.setAttribute("aria-disabled", String(value));
  }

  return {
    preview(svg: string, summary: string) {
      setPreparing(true);
      blob = null;
      image.src = svgImageSource(svg);
      image.alt = copy.cardAlt(copy[kind], summary);
      toolbar.setAttribute("aria-label", copy[kind]);
      return svg;
    },
    async prepare(svg: string, revision: number) {
      try {
        const result = await renderCardPng(svg);
        if (revision === renderRevision) blob = pngBlob(result);
      } finally {
        if (revision === renderRevision) setPreparing(false);
      }
    },
  };
}

const cards = kinds.map((kind) => ({ kind, ...makeCard(kind) }));

function renderCards() {
  const revision = ++renderRevision;
  const theme = themeOverride ?? (systemTheme.matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  dark.setAttribute("aria-pressed", String(theme === "dark"));
  light.setAttribute("aria-pressed", String(theme === "light"));

  const summary = shareMessage(view, intl, { showCost: costShown() });
  const options = { name: name.value, showCost: costShown(), theme };
  const jobs = cards.map((card) => {
    const svg = card.preview(
      renderShareCard(view, { ...options, kind: card.kind }, intl, fonts),
      summary,
    );
    return () => card.prepare(svg, revision);
  });

  window.clearTimeout(exportTimer);
  exportTimer = window.setTimeout(() => {
    void Promise.all(jobs.map((job) => job())).catch(() => {
      if (revision === renderRevision) announce(copy.failed);
    });
  }, 180);
}

function renderLanguage(nextLocale: Locale) {
  locale = nextLocale;
  copy = pageCopy[locale];
  intl = intlFor(locale);

  document.documentElement.lang = locale;
  document.title = copy.title;
  for (const node of document.querySelectorAll<HTMLElement>("[data-copy]")) {
    const key = node.dataset.copy as keyof typeof copy;
    const label = copy[key];
    if (typeof label === "string") node.textContent = label;
  }
  section.setAttribute("aria-label", copy.cards);
  element("#theme-control").setAttribute("aria-label", copy.theme);
  element("#language-control").setAttribute("aria-label", copy.language);
  name.placeholder = copy.optional;
  english.setAttribute("aria-pressed", String(locale === "en-US"));
  chinese.setAttribute("aria-pressed", String(locale === "zh-CN"));
  renderCards();
}

function setTheme(theme: Theme) {
  themeOverride = theme;
  renderCards();
}

name.addEventListener("input", renderCards);
showCost.addEventListener("change", renderCards);
dark.addEventListener("click", () => setTheme("dark"));
light.addEventListener("click", () => setTheme("light"));
english.addEventListener("click", () => renderLanguage("en-US"));
chinese.addEventListener("click", () => renderLanguage("zh-CN"));
systemTheme.addEventListener("change", () => {
  if (themeOverride === undefined) renderCards();
});

renderLanguage(locale);
