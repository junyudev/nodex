/** Runs in the main world before Electron registers its native webview element. */
export function installStatePreservingWebviewMoves(): void {
  const registry = window.customElements;
  if (registry.get("webview") || typeof Element.prototype.moveBefore !== "function") return;

  const originalDefine = registry.define;
  const ownDescriptor = Object.getOwnPropertyDescriptor(registry, "define");
  const restore = () => {
    if (ownDescriptor) Object.defineProperty(registry, "define", ownDescriptor);
    else Reflect.deleteProperty(registry, "define");
    window.removeEventListener("pagehide", restore);
  };
  const define: typeof registry.define = function (
    this: CustomElementRegistry,
    name,
    constructor,
    options,
  ) {
    if (name !== "webview") return originalDefine.call(this, name, constructor, options);
    const prototype = constructor.prototype as HTMLElement & {
      connectedMoveCallback?: () => void;
    };
    if ("connectedMoveCallback" in prototype) {
      restore();
      return originalDefine.call(this, name, constructor, options);
    }

    // The browser captures this standard callback at definition time. A connected
    // move must not run Electron's disconnect callback and destroy the native guest.
    Object.defineProperty(prototype, "connectedMoveCallback", {
      configurable: true,
      value() {
        // Preserve the existing attachment; true removal still runs disconnect.
      },
    });
    try {
      return originalDefine.call(this, name, constructor, options);
    } finally {
      Reflect.deleteProperty(prototype, "connectedMoveCallback");
      restore();
    }
  };
  Object.defineProperty(registry, "define", {
    configurable: true,
    writable: true,
    value: define,
  });
  window.addEventListener("pagehide", restore, { once: true });
}
