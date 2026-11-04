import type { Terminal } from "@xterm/xterm";

type MouseCoordinates = Pick<MouseEvent, "clientX" | "clientY">;

interface XtermMouseCore {
  _mouseService?: {
    getCoords: (event: MouseCoordinates, element: HTMLElement, ...args: unknown[]) => unknown;
    getMouseReportCoords: (event: MouseCoordinates, element: HTMLElement) => unknown;
  };
  _selectionService?: {
    _getMouseEventScrollAmount: (event: MouseCoordinates) => unknown;
    _screenElement: HTMLElement;
  };
}

function readWindowZoom(document: Document): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--codex-window-zoom");
  const zoom = Number.parseFloat(value);
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

export function patchXtermWindowZoomMouseCoordinates(term: Terminal): () => void {
  // xterm 6 already registers its DPR monitor. Its mouse and selection services need CSS zoom coordinates.
  const core = (term as Terminal & { _core?: XtermMouseCore })._core;
  const mouse = core?._mouseService;
  if (!mouse) return () => {};

  const scale = (event: MouseCoordinates, element: HTMLElement): MouseCoordinates => {
    const zoom = readWindowZoom(element.ownerDocument);
    if (zoom === 1) return event;
    const rect = element.getBoundingClientRect();
    return {
      clientX: rect.left + (event.clientX - rect.left) / zoom,
      clientY: rect.top + (event.clientY - rect.top) / zoom,
    };
  };

  const { getCoords, getMouseReportCoords } = mouse;
  mouse.getCoords = (event, element, ...args) =>
    getCoords.call(mouse, scale(event, element), element, ...args);
  mouse.getMouseReportCoords = (event, element) =>
    getMouseReportCoords.call(mouse, scale(event, element), element);

  const selection = core?._selectionService;
  const scrollAmount = selection?._getMouseEventScrollAmount;
  if (selection && scrollAmount && selection._screenElement) {
    selection._getMouseEventScrollAmount = (event) =>
      scrollAmount.call(selection, scale(event, selection._screenElement));
  }

  return () => {
    mouse.getCoords = getCoords;
    mouse.getMouseReportCoords = getMouseReportCoords;
    if (selection && scrollAmount) selection._getMouseEventScrollAmount = scrollAmount;
  };
}
