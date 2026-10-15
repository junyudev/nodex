import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  WORKBENCH_SIDEBAR_PEEK_AIM_TIMEOUT_MS,
  WORKBENCH_SIDEBAR_PEEK_CLOSE_DELAY_MS,
  WORKBENCH_SIDEBAR_PEEK_OPEN_DELAY_MS,
  buildSafeTriangle,
  createWorkbenchSidebarPeekController,
  isPointInSafeTriangle,
  type WorkbenchSidebarPeekArea,
  type WorkbenchSidebarPeekController,
} from "./workbench-sidebar-peek";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

// Rail x0..52 with Home (8,52) and Space (8,96) buttons; peek surface x56..340, y48..812.
function mountShell() {
  document.body.innerHTML = `
    <nav data-app-navigation-rail>
      <button data-workbench-sidebar-peek-area="home">Home</button>
      <button data-workbench-sidebar-peek-area="space">Space</button>
      <button data-testid="other-rail-action">Settings</button>
    </nav>
    <main data-testid="content"><span data-testid="content-text">Content</span></main>
    <aside data-workbench-sidebar-peek-surface><button data-testid="row">Row</button></aside>
  `;
  const home = document.querySelector<HTMLElement>('[data-workbench-sidebar-peek-area="home"]')!;
  const space = document.querySelector<HTMLElement>('[data-workbench-sidebar-peek-area="space"]')!;
  const surface = document.querySelector<HTMLElement>("[data-workbench-sidebar-peek-surface]")!;
  home.getBoundingClientRect = () => rect(8, 52, 36, 36);
  space.getBoundingClientRect = () => rect(8, 96, 36, 36);
  surface.getBoundingClientRect = () => rect(56, 48, 284, 764);
  return {
    home,
    space,
    surface,
    row: document.querySelector<HTMLElement>('[data-testid="row"]')!,
    content: document.querySelector<HTMLElement>('[data-testid="content-text"]')!,
    otherRailAction: document.querySelector<HTMLElement>('[data-testid="other-rail-action"]')!,
  };
}

function pointer(type: string, target: Element, x: number, y: number, init: PointerEventInit = {}) {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX: x,
    clientY: y,
    relatedTarget: (init.relatedTarget as EventTarget | null) ?? null,
  });
  Object.defineProperty(event, "pointerType", { value: init.pointerType ?? "mouse" });
  Object.defineProperty(event, "buttons", { value: init.buttons ?? 0 });
  target.dispatchEvent(event);
}

describe("sidebar peek controller", () => {
  let enabled = true;
  let peek: WorkbenchSidebarPeekArea | null = null;
  let controller: WorkbenchSidebarPeekController;
  let shell: ReturnType<typeof mountShell>;

  beforeEach(() => {
    vi.useFakeTimers();
    enabled = true;
    peek = null;
    shell = mountShell();
    controller = createWorkbenchSidebarPeekController({
      document,
      isEnabled: () => enabled,
      onPeekChange: (area) => {
        peek = area;
      },
    });
  });

  afterEach(() => {
    controller.dispose();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const openHome = () => {
    pointer("pointerover", shell.home, 26, 70);
    vi.advanceTimersByTime(WORKBENCH_SIDEBAR_PEEK_OPEN_DELAY_MS);
    expect(peek).toBe("home");
  };

  test("opens a destination after a short dwell and only while collapsed", () => {
    pointer("pointerover", shell.home, 26, 70);
    vi.advanceTimersByTime(WORKBENCH_SIDEBAR_PEEK_OPEN_DELAY_MS - 1);
    expect(peek).toBe(null);
    vi.advanceTimersByTime(1);
    expect(peek).toBe("home");

    enabled = false;
    controller.reconcile();
    expect(peek).toBe(null);
    pointer("pointermove", shell.home, 26, 72);
    vi.advanceTimersByTime(WORKBENCH_SIDEBAR_PEEK_OPEN_DELAY_MS);
    expect(peek).toBe(null);
  });

  test("crossing the gap from the rail into the surface keeps the peek", () => {
    openHome();
    // The pointer leaves the button toward the surface and lingers in the gap
    // longer than the close grace period.
    pointer("pointerout", shell.home, 44, 70, { relatedTarget: document.body });
    pointer("pointermove", document.body, 48, 70);
    vi.advanceTimersByTime(WORKBENCH_SIDEBAR_PEEK_CLOSE_DELAY_MS * 3);
    pointer("pointermove", document.body, 52, 71);
    vi.advanceTimersByTime(WORKBENCH_SIDEBAR_PEEK_CLOSE_DELAY_MS * 3);
    expect(peek).toBe("home");

    pointer("pointermove", shell.row, 120, 80);
    vi.advanceTimersByTime(WORKBENCH_SIDEBAR_PEEK_AIM_TIMEOUT_MS * 2);
    expect(peek).toBe("home");
  });

  test("leaving the aimed path or stalling in the gap closes after the grace period", () => {
    openHome();
    pointer("pointerout", shell.home, 44, 70, { relatedTarget: document.body });
    // Moving back toward the content area leaves the triangle.
    pointer("pointermove", document.body, 30, 600);
    vi.advanceTimersByTime(WORKBENCH_SIDEBAR_PEEK_CLOSE_DELAY_MS);
    expect(peek).toBe(null);

    openHome();
    pointer("pointerout", shell.home, 44, 70, { relatedTarget: document.body });
    pointer("pointermove", document.body, 48, 70);
    vi.advanceTimersByTime(
      WORKBENCH_SIDEBAR_PEEK_AIM_TIMEOUT_MS + WORKBENCH_SIDEBAR_PEEK_CLOSE_DELAY_MS,
    );
    expect(peek).toBe(null);
  });

  test("leaving the surface closes after the grace period unless the pointer returns", () => {
    openHome();
    pointer("pointermove", shell.row, 120, 80);
    pointer("pointermove", shell.content, 600, 80);
    vi.advanceTimersByTime(WORKBENCH_SIDEBAR_PEEK_CLOSE_DELAY_MS - 1);
    pointer("pointermove", shell.row, 300, 80);
    vi.advanceTimersByTime(WORKBENCH_SIDEBAR_PEEK_CLOSE_DELAY_MS * 2);
    expect(peek).toBe("home");

    pointer("pointermove", shell.content, 600, 80);
    vi.advanceTimersByTime(WORKBENCH_SIDEBAR_PEEK_CLOSE_DELAY_MS);
    expect(peek).toBe(null);
  });

  test("an open sidebar menu keeps the peek through pointer exits", () => {
    openHome();
    pointer("pointermove", shell.row, 120, 80);
    controller.setMenuOpen(true);
    pointer("pointermove", shell.content, 600, 300);
    document.documentElement.dispatchEvent(new MouseEvent("pointerleave"));
    vi.advanceTimersByTime(WORKBENCH_SIDEBAR_PEEK_AIM_TIMEOUT_MS * 3);
    expect(peek).toBe("home");

    controller.setMenuOpen(false);
    pointer("pointermove", shell.content, 640, 320);
    vi.advanceTimersByTime(WORKBENCH_SIDEBAR_PEEK_CLOSE_DELAY_MS);
    expect(peek).toBe(null);
  });

  test("switches destinations immediately once a peek is showing", () => {
    openHome();
    pointer("pointerover", shell.space, 26, 114);
    expect(peek).toBe("space");
  });

  test("Escape and other rail actions dismiss until the pointer leaves the destinations", () => {
    openHome();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(peek).toBe(null);
    pointer("pointermove", shell.home, 26, 72);
    vi.advanceTimersByTime(WORKBENCH_SIDEBAR_PEEK_OPEN_DELAY_MS * 2);
    expect(peek).toBe(null);
    pointer("pointermove", shell.content, 600, 72);
    pointer("pointerover", shell.home, 26, 70);
    vi.advanceTimersByTime(WORKBENCH_SIDEBAR_PEEK_OPEN_DELAY_MS);
    expect(peek).toBe("home");

    pointer("pointerover", shell.otherRailAction, 26, 200);
    expect(peek).toBe(null);
  });

  test("safe triangle covers the path to the surface's near edge", () => {
    const triangle = buildSafeTriangle({ x: 44, y: 70 }, rect(56, 48, 284, 764));
    if (!triangle) throw new Error("Expected a triangle");
    expect(isPointInSafeTriangle({ x: 50, y: 70 }, triangle)).toBe(true);
    expect(isPointInSafeTriangle({ x: 55, y: 600 }, triangle)).toBe(true);
    expect(isPointInSafeTriangle({ x: 30, y: 70 }, triangle)).toBe(false);
    expect(isPointInSafeTriangle({ x: 50, y: 700 }, triangle)).toBe(false);
    expect(buildSafeTriangle({ x: 44, y: 70 }, rect(56, 48, 0, 0))).toBe(null);
  });
});
