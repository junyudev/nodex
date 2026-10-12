import { VISUALIZATION_ANNOTATION_TOOL } from "../../../shared/codex-visualization-annotations";
import type {
  VisualizationAnnotationControl,
  VisualizationAnnotationCommand,
  VisualizationAnnotationValue,
} from "../../../shared/codex-visualization-annotations";

/** Authored object bindings stay in the guest; accepted control metadata and editing UI stay with the host. */
function installAnnotations(tool: string) {
  type Definition<T = VisualizationAnnotationControl> = T extends VisualizationAnnotationControl
    ? Omit<T, "callback">
    : never;
  type ObjectBinding = { [property: string]: unknown };
  type Binding = {
    panel: Panel;
    object: ObjectBinding;
    property: string;
    control: VisualizationAnnotationControl;
  };
  type Target = {
    id: string;
    label: string;
    selector: string;
    tagName: string;
    visible: boolean;
    rect: { x: number; y: number; width: number; height: number };
  };
  type Panel = {
    id: string;
    targetId: string;
    target: WeakRef<Element>;
    onChange?: () => void;
    bindings: Map<string, Binding>;
    controls: VisualizationAnnotationControl[];
    accepted: VisualizationAnnotationControl[] | null;
    pending: Promise<void>;
    nextControl: number;
    visible: boolean;
    inFlight: boolean;
    disposed: boolean;
  };
  type Api = {
    callTool?: (name: string, input: unknown) => Promise<unknown>;
    visualizationAnnotation?: VisualizationAnnotationCommand | null;
  };
  const widget = window as Window & { openai?: Api; Tweak?: typeof Tweak };
  const callTool = widget.openai?.callTool?.bind(widget.openai);
  const panels = new Map<string, Panel>();
  const targets = new WeakMap<Element, string>();
  let panelSequence = 0;
  let targetSequence = 0;
  let stopped = false;
  let command: VisualizationAnnotationCommand | null = null;
  let previews = new Map<Binding, VisualizationAnnotationValue>();
  const send = async (message: unknown) => {
    try {
      return (await callTool?.(tool, message)) as
        | { annotationControls?: { controls: VisualizationAnnotationControl[] } }
        | undefined;
    } catch {
      return undefined;
    }
  };
  const liveTarget = (panel: Panel) => {
    const target = panel.target.deref();
    return target?.isConnected && target.ownerDocument === document ? target : null;
  };
  const owners = () =>
    new Map(
      [...panels.values()].flatMap((panel) => {
        const target = liveTarget(panel);
        return target && panel.accepted ? [[target, panel] as const] : [];
      }),
    );
  const validValue = (
    control: VisualizationAnnotationControl,
    value: unknown,
  ): value is VisualizationAnnotationValue => {
    if (control.type === "range")
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= control.min &&
        value <= control.max
      );
    if (control.type === "color")
      return (
        typeof value === "string" &&
        /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)
      );
    if (control.type === "toggle") return typeof value === "boolean";
    return typeof value === "string" && control.options.some((option) => option.value === value);
  };
  const setValue = (binding: Binding, value: unknown) => {
    if (!liveTarget(binding.panel) || binding.object[binding.property] === value) return;
    try {
      binding.object[binding.property] = value;
      binding.panel.onChange?.();
    } catch (error) {
      window.reportError(error);
    }
  };
  const syncPreviews = () => {
    const desired = new Map<Binding, VisualizationAnnotationValue>();
    const map = owners();
    for (const change of command?.changes ?? []) {
      const panel = panels.get(change.registrationId);
      const target = panel && liveTarget(panel);
      if (!panel || !target || panel.targetId !== change.targetId || map.get(target) !== panel)
        continue;
      if (panel.inFlight) {
        for (const [binding, value] of previews)
          if (binding.panel === panel) desired.set(binding, value);
        continue;
      }
      for (const edit of change.annotationControlChanges) {
        const binding = panel.bindings.get(edit.callback);
        const control = panel.accepted?.find((control) => control.callback === edit.callback);
        if (
          binding &&
          control &&
          edit.previousValue === control.currentValue &&
          edit.value !== control.currentValue &&
          validValue(control, edit.value)
        )
          desired.set(binding, edit.value);
      }
    }
    const previous = previews;
    previews = desired;
    for (const [binding] of previous) {
      if (previews !== desired) return;
      if (!desired.has(binding)) setValue(binding, binding.control.currentValue);
    }
    for (const [binding, value] of desired) {
      if (previews !== desired) return;
      if (previous.get(binding) !== value) setValue(binding, value);
    }
  };
  const targetSnapshot = (panel: Panel): Target => {
    const target = liveTarget(panel);
    if (!target) throw new TypeError("Tweak container is unavailable");
    const parts: string[] = [];
    for (
      let element: Element | null = target;
      element && parts.length < 12;
      element = element.parentElement
    ) {
      const id = element.id && window.CSS?.escape?.(element.id);
      if (id && id.length < 256) {
        parts.unshift(`#${id}`);
        break;
      }
      let index = 1;
      for (
        let sibling = element.previousElementSibling;
        sibling;
        sibling = sibling.previousElementSibling
      )
        if (sibling.localName === element.localName) index++;
      parts.unshift(`${element.localName}:nth-of-type(${index})`);
    }
    const label = [
      target.getAttribute("aria-label"),
      target.getAttribute("title"),
      target.id,
      target.localName,
    ]
      .map((value) =>
        value
          ?.replace(
            /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
            " ",
          )
          .replace(/\s+/g, " ")
          .trim(),
      )
      .find(Boolean)!;
    const { x, y, width, height } = target.getBoundingClientRect();
    return {
      id: panel.targetId,
      label: label.slice(0, 80),
      selector: parts.join(" > ").slice(0, 1024),
      tagName: target.localName.toLowerCase(),
      visible: panel.visible,
      rect: { x, y, width, height },
    };
  };
  const dispose = (panel: Panel) => {
    if (panel.disposed) return;
    panel.disposed = true;
    if (panels.delete(panel.id)) {
      syncPreviews();
      void panel.pending.then(() => send({ type: "dispose", registrationId: panel.id }));
    }
    panel.bindings.clear();
    panel.controls = [];
    panel.accepted = null;
  };
  const queue = (panel: Panel, control: VisualizationAnnotationControl, target: Target) => {
    panel.pending = panel.pending.then(async () => {
      if (panel.disposed || stopped) return;
      if (!liveTarget(panel)) {
        dispose(panel);
        return;
      }
      const type = panel.accepted ? "update" : "register";
      panel.inFlight = true;
      const result = await send({
        type,
        registrationId: panel.id,
        annotationControls: {
          controlsMode: "replace",
          controls: [...(panel.accepted ?? []), control],
        },
        targets: [{ ...target, visible: panel.visible }],
      });
      panel.inFlight = false;
      if (panel.disposed) return;
      if (Array.isArray(result?.annotationControls?.controls))
        panel.accepted = result.annotationControls.controls;
      else {
        panel.controls = panel.controls.filter(
          (candidate) => candidate.callback !== control.callback,
        );
        panel.bindings.delete(control.callback);
        if (type === "register") {
          dispose(panel);
          return;
        }
      }
      syncPreviews();
    });
  };
  class Tweak {
    #panel?: Panel;
    #disposed = false;
    constructor({ container, onChange }: { container: Element; onChange?: () => void }) {
      if (!this.supported) return;
      if (!(container instanceof Element) || container.ownerDocument !== document)
        throw new TypeError("Tweak needs a component element as its container");
      let targetId = targets.get(container);
      if (!targetId) {
        targetId = String(++targetSequence);
        targets.set(container, targetId);
      }
      this.#panel = {
        id: `tweak-${++panelSequence}`,
        targetId,
        target: new WeakRef(container),
        onChange,
        bindings: new Map(),
        controls: [],
        accepted: null,
        pending: Promise.resolve(),
        nextControl: 0,
        visible: !container.closest(".viz-carousel > [data-variant][hidden]"),
        inFlight: false,
        disposed: false,
      };
    }
    get supported() {
      return Boolean(callTool) && !stopped;
    }
    addSlider(
      object: ObjectBinding,
      property: string,
      options: {
        min?: number;
        max?: number;
        step?: number;
        unit?: string;
        label?: string;
        reference?: string;
      } = {},
    ) {
      return this.#bind(object, property, {
        type: "range",
        label: options.unit
          ? `${options.label ?? property} (${options.unit})`
          : (options.label ?? property),
        reference: options.reference,
        currentValue: object[property] as number,
        min: options.min ?? Number.NaN,
        max: options.max ?? Number.NaN,
        step: options.step ?? 1,
      });
    }
    addColorPicker(
      object: ObjectBinding,
      property: string,
      options: { label?: string; reference?: string } = {},
    ) {
      return this.#bind(object, property, {
        type: "color",
        label: options.label ?? property,
        reference: options.reference,
        currentValue: object[property] as string,
      });
    }
    addToggle(
      object: ObjectBinding,
      property: string,
      options: { label?: string; reference?: string } = {},
    ) {
      return this.#bind(object, property, {
        type: "toggle",
        label: options.label ?? property,
        reference: options.reference,
        currentValue: object[property] as boolean,
      });
    }
    addSelect(
      object: ObjectBinding,
      property: string,
      options: {
        options: readonly (string | { label: string; value: string })[];
        label?: string;
        reference?: string;
      },
    ) {
      return this.#bind(object, property, {
        type: "select",
        label: options.label ?? property,
        reference: options.reference,
        currentValue: object[property] as string,
        options: options.options.map((option) =>
          typeof option === "string"
            ? { label: option, value: option }
            : { label: option.label, value: option.value },
        ),
      });
    }
    dispose() {
      this.#disposed = true;
      if (this.#panel) dispose(this.#panel);
    }
    #bind(object: ObjectBinding, property: string, definition: Definition) {
      const panel = this.#panel;
      if (this.#disposed || panel?.disposed) throw new Error("Tweak has been disposed");
      if (!this.supported || !panel) return this;
      const control = {
        ...definition,
        callback: `${panel.id}-${panel.nextControl + 1}`,
      } as VisualizationAnnotationControl;
      if (!validValue(control, control.currentValue))
        throw new TypeError("Tweak bindings require a valid current value");
      if (panel.controls.length >= 12 || (!panels.has(panel.id) && panels.size >= 64))
        throw new RangeError("Too many Tweak controls");
      panel.nextControl++;
      const payload = JSON.stringify({
        controlsMode: "replace",
        controls: [...panel.controls, control],
      });
      if (payload.length > 16_384) throw new RangeError("Tweak controls exceed the maximum size");
      const controls = (JSON.parse(payload) as { controls: VisualizationAnnotationControl[] })
        .controls;
      const accepted = controls.at(-1)!;
      const target = targetSnapshot(panel);
      panel.controls = controls;
      panel.bindings.set(control.callback, { panel, object, property, control: accepted });
      panels.set(panel.id, panel);
      queue(panel, accepted, target);
      return this;
    }
  }
  widget.Tweak = Tweak;
  const onGlobals = (event: Event) => {
    const globals = (event as CustomEvent<{ globals?: Api }>).detail?.globals;
    if (!globals || !Object.hasOwn(globals, "visualizationAnnotation")) return;
    const next = globals.visualizationAnnotation;
    if (
      next &&
      (typeof next.active !== "boolean" ||
        !Array.isArray(next.changes) ||
        next.changes.length > 1024 ||
        next.changes.some(
          (change) =>
            !change ||
            typeof change.registrationId !== "string" ||
            typeof change.targetId !== "string" ||
            !Array.isArray(change.annotationControlChanges) ||
            change.annotationControlChanges.length > 12 ||
            change.annotationControlChanges.some(
              (edit: { callback?: unknown } | null) => !edit || typeof edit.callback !== "string",
            ),
        ))
    )
      return;
    command = next ?? null;
    syncPreviews();
  };
  const close = () => {
    command = command ? { ...command, active: false } : null;
    void send({ type: "escape" });
  };
  const onPointer = (event: MouseEvent) => {
    if (!command?.active || event.button !== 0 || event.defaultPrevented) return;
    if (
      event.target instanceof Element &&
      event.target.closest(".viz-carousel > .viz-carousel-controls")
    )
      return;
    const map = owners();
    for (const target of event.composedPath()) {
      const panel = target instanceof Element ? map.get(target) : undefined;
      if (!panel) continue;
      if (event.type === "click")
        void send({ type: "select", registrationId: panel.id, targetId: panel.targetId });
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.type === "click") close();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!command?.active || event.key !== "Escape" || event.defaultPrevented || event.isComposing)
      return;
    event.preventDefault();
    close();
  };
  const observer = new MutationObserver(() => {
    for (const panel of panels.values()) {
      const target = liveTarget(panel);
      if (!target) {
        if (command?.active && command.selection?.registrationId === panel.id) close();
        dispose(panel);
        continue;
      }
      const visible = !target.closest(".viz-carousel > [data-variant][hidden]");
      if (visible === panel.visible) continue;
      panel.visible = visible;
      panel.pending = panel.pending.then(async () => {
        if (panel.disposed || stopped || !panel.accepted) return;
        if (!liveTarget(panel)) {
          dispose(panel);
          return;
        }
        await send({
          type: "update",
          registrationId: panel.id,
          annotationControls: { controlsMode: "replace", controls: panel.accepted },
          targets: [targetSnapshot(panel)],
        });
      });
    }
  });
  const onPageHide = (event: PageTransitionEvent) => {
    if (!event.isTrusted) return;
    stopped = true;
    command = null;
    syncPreviews();
    for (const panel of panels.values()) dispose(panel);
    observer.disconnect();
    window.removeEventListener("openai:set_globals", onGlobals);
    window.removeEventListener("pointerdown", onPointer, true);
    window.removeEventListener("mousedown", onPointer, true);
    window.removeEventListener("click", onPointer, true);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("pagehide", onPageHide);
  };
  if (!callTool) return;
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden"],
  });
  window.addEventListener("openai:set_globals", onGlobals);
  window.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("mousedown", onPointer, true);
  window.addEventListener("click", onPointer, true);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("pagehide", onPageHide);
  onGlobals(new CustomEvent("openai:set_globals", { detail: { globals: widget.openai } }));
}

function installVariants(tool: string) {
  let previous = "[]";
  let roots: HTMLElement[] = [];
  const report = () => {
    roots = Array.from(
      document.querySelectorAll<HTMLElement>(".viz-carousel[data-active-variant]"),
    ).slice(0, 32);
    const selectedVariants = roots.flatMap((root, carousel) => {
      const variant = root.dataset.activeVariant;
      const label = root.getAttribute("aria-label")?.slice(0, 256);
      return variant
        ? [{ carousel, ...(label === undefined ? {} : { label }), variant: variant.slice(0, 256) }]
        : [];
    });
    const snapshot = JSON.stringify(selectedVariants);
    if (previous === snapshot) return;
    previous = snapshot;
    const api = (
      window as Window & { openai?: { callTool(name: string, input: unknown): Promise<unknown> } }
    ).openai;
    void api?.callTool(tool, { type: "variants", selectedVariants }).catch(() => undefined);
  };
  const observer = new MutationObserver((records) => {
    if (
      records.some((record) => record.type === "attributes") ||
      roots.some((root) => !root.isConnected)
    )
      report();
  });
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-active-variant"],
  });
  report();
  window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
}

export function buildInlineVisualizationAnnotationScript(allowed: boolean): string {
  return allowed
    ? `<script>(${installAnnotations.toString()})(${JSON.stringify(VISUALIZATION_ANNOTATION_TOOL)});</script>`
    : "";
}
export function buildInlineVisualizationVariantsScript(): string {
  return `<script>(${installVariants.toString()})(${JSON.stringify(VISUALIZATION_ANNOTATION_TOOL)});</script>`;
}
