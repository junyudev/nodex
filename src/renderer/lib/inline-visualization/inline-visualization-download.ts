/** Executes in the isolated document; authorization is independently enforced by its host. */
function installDownloadRuntime(capability: string) {
  const api = (
    window as Window & { openai?: { callTool(name: string, input: unknown): Promise<unknown> } }
  ).openai;
  if (!api) return;
  const callTool = api.callTool.bind(api);
  const originalClick = HTMLAnchorElement.prototype.click;
  document.currentScript?.remove();
  let isHandlingTrustedClick = false;
  let didDownload = false;
  const handleDownload = (
    anchor: HTMLAnchorElement,
    event: MouseEvent,
    waitForPropagation: boolean,
  ) => {
    const isUserActivated =
      event.isTrusted || isHandlingTrustedClick || navigator.userActivation?.isActive === true;
    const startDownload = () => {
      if (
        event.defaultPrevented ||
        !isUserActivated ||
        didDownload ||
        !anchor.hasAttribute("download")
      )
        return;
      let url: URL;
      try {
        url = new URL(anchor.href, location.href);
      } catch {
        return;
      }
      if (url.protocol !== "blob:" && url.protocol !== "data:") return;
      const name = anchor.download.trim() || "download";
      didDownload = true;
      void fetch(url.href)
        .then((response) => response.blob())
        .then((blob) =>
          callTool("__codex_inline_visualization_download__", { blob, capability, name }),
        )
        .catch(() => {});
    };
    if (waitForPropagation) queueMicrotask(startDownload);
    else startDownload();
  };
  const onClick = (event: MouseEvent) => {
    if (event.isTrusted) {
      isHandlingTrustedClick = true;
      didDownload = false;
      queueMicrotask(() => {
        isHandlingTrustedClick = false;
      });
    }
    const anchor = event
      .composedPath()
      .find((target): target is HTMLAnchorElement => target instanceof HTMLAnchorElement);
    if (anchor) handleDownload(anchor, event, true);
  };
  const click = function (this: HTMLAnchorElement) {
    const observed: { event: MouseEvent | null } = { event: null };
    const observeClick = (event: MouseEvent) => {
      observed.event = event;
    };
    this.addEventListener("click", observeClick, { capture: true, once: true });
    try {
      originalClick.call(this);
    } finally {
      this.removeEventListener("click", observeClick, true);
      if (observed.event) handleDownload(this, observed.event, false);
    }
  };
  HTMLAnchorElement.prototype.click = click;
  window.addEventListener("click", onClick, { capture: true });
  window.addEventListener(
    "pagehide",
    () => {
      window.removeEventListener("click", onClick, true);
      if (HTMLAnchorElement.prototype.click === click)
        HTMLAnchorElement.prototype.click = originalClick;
    },
    { once: true },
  );
}

export function buildInlineVisualizationDownloadScript(capability?: string): string {
  if (!capability) return "";
  const encoded = JSON.stringify(capability).replaceAll("<", "\\u003c");
  return `<script>(${installDownloadRuntime.toString()})(${encoded});</script>`;
}

export function saveVisualizationDownload(blob: Blob, name: string): void {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = name;
  anchor.style.display = "none";
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
  }
}

/** The attempt capability and native gesture are required together; document claims never suffice. */
export function createVisualizationDownloadHandler(input: {
  readonly capability: string;
  readonly signal: AbortSignal;
  readonly consumeGesture: () => Promise<boolean>;
  readonly save?: (blob: Blob, name: string) => void;
}): (value: unknown) => Promise<void> {
  return async (value) => {
    const record =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    if (
      input.signal.aborted ||
      record?.capability !== input.capability ||
      !(record.blob instanceof Blob) ||
      typeof record.name !== "string" ||
      !record.name.trim() ||
      record.name.trim().length > 255
    )
      throw new Error("The download is unavailable");
    if (!(await input.consumeGesture()) || input.signal.aborted)
      throw new Error("The download requires a user gesture");
    (input.save ?? saveVisualizationDownload)(record.blob, record.name.trim());
  };
}
