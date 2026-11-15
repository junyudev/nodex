import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  browserAnnotationElementAddress,
  captureBrowserAnnotationAnchor,
  captureBrowserAnnotationTextLocator,
  hitTestBrowserAnnotation,
  resolveBrowserAnnotationAnchor,
  resolveBrowserAnnotationFrame,
  resolveBrowserAnnotationSelector,
  restoreBrowserAnnotationTextLocator,
} from "../../../preload/browser-annotation-anchors";
const box = (x: number, y: number, width = 100, height = 30) => ({
  x,
  y,
  left: x,
  top: y,
  width,
  height,
  right: x + width,
  bottom: y + height,
  toJSON: () => ({}),
});
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
test("text locators restore UTF-16 offsets across nodes after the DOM is recreated, and refuse a changed quote", () => {
  document.body.innerHTML = '<p id="copy">Hello <b>brave</b> world 🌍</p>';
  const element = document.querySelector("p")!;
  const range = document.createRange();
  range.setStart(element.firstChild!, 3);
  range.setEnd(element.lastChild!, 9);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const locator = captureBrowserAnnotationTextLocator(selection)!;
  expect(locator).toMatchObject({
    selector: "#copy",
    direction: "forward",
    startOffset: 3,
    endOffset: 20,
    rangeText: "lo brave world 🌍",
  });
  document.body.innerHTML = '<p id="copy">Hello <b>brave</b> world 🌍</p>';
  expect(restoreBrowserAnnotationTextLocator(document, locator)?.toString()).toBe(
    locator.rangeText,
  );
  document.querySelector("b")!.textContent = "other";
  expect(restoreBrowserAnnotationTextLocator(document, locator)).toBeNull();
});
test("selectors and hit testing descend open shadow roots and same-origin frames", () => {
  document.body.innerHTML = '<div id="host"></div><iframe id="frame"></iframe>';
  const host = document.querySelector("#host")!;
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = '<button id="inside">Inside</button>';
  const inside = shadow.querySelector("button")!;
  expect(browserAnnotationElementAddress(inside)).toEqual({
    selector: "#inside",
    shadowHosts: ["#host"],
  });
  expect(resolveBrowserAnnotationSelector(document, "#inside", ["#host"])).toBe(inside);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => host });
  Object.defineProperty(shadow, "elementFromPoint", { configurable: true, value: () => inside });
  expect(hitTestBrowserAnnotation(document, 10, 10)).toBe(inside);
  const frame = document.querySelector("iframe")!;
  frame.contentDocument!.body.innerHTML = '<button id="child">Child</button>';
  const child = frame.contentDocument!.querySelector("button")!;
  expect(resolveBrowserAnnotationFrame(document, ["#frame"])).toBe(frame.contentDocument);
  vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(box(50, 60));
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => frame });
  Object.defineProperty(frame.contentDocument!, "elementFromPoint", {
    configurable: true,
    value: () => child,
  });
  expect(hitTestBrowserAnnotation(document, 55, 65)).toBe(child);
  vi.spyOn(child, "getBoundingClientRect").mockReturnValue(box(5, 6));
  const anchor = captureBrowserAnnotationAnchor(child, "anchor", window);
  expect(anchor).toMatchObject({
    framePath: ["#frame"],
    selector: "#child",
    rect: { x: 55, y: 66 },
    role: "button",
    name: "Child",
  });
  expect(resolveBrowserAnnotationAnchor(document, anchor)?.rect).toMatchObject({ x: 55, y: 66 });
});
test("region scroll facts survive recapture while fixed targets ignore document scrolling", () => {
  document.body.innerHTML = '<div id="scroller"><button id="target">Target</button></div>';
  const scroller = document.querySelector("#scroller")!;
  const target = document.querySelector("button")!;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 100 });
  scroller.scrollTop = 20;
  const region = captureBrowserAnnotationAnchor(target, "region", window, box(50, 80));
  scroller.scrollTop = 70;
  expect(resolveBrowserAnnotationAnchor(document, region)?.rect.y).toBe(30);
  target.style.position = "fixed";
  const fixed = captureBrowserAnnotationAnchor(target, "fixed", window, box(50, 80));
  scroller.scrollTop = 120;
  expect(fixed.isFixed).toBe(true);
  expect(resolveBrowserAnnotationAnchor(document, fixed)?.rect.y).toBe(80);
});

test("a backward selection across shadow-root children round trips with its host chain", () => {
  document.body.innerHTML = '<div id="host"></div>';
  const root = document.querySelector("#host")!.attachShadow({ mode: "open" });
  root.innerHTML = "<b>first</b> second";
  const range = document.createRange();
  range.setStart(root.querySelector("b")!.firstChild!, 1);
  range.setEnd(root.lastChild!, 4);
  const selection = {
    anchorNode: range.endContainer,
    anchorOffset: range.endOffset,
    direction: "backward",
  } as unknown as Selection;
  const locator = captureBrowserAnnotationTextLocator(selection, range)!;
  expect(locator).toMatchObject({
    selector: "",
    shadowHosts: ["#host"],
    direction: "backward",
    rangeText: "irst sec",
  });
  root.innerHTML = "<b>first</b> second";
  expect(restoreBrowserAnnotationTextLocator(document, locator)?.toString()).toBe("irst sec");
});

test("form text retains its quote and direction while password values are excluded", () => {
  document.body.innerHTML =
    '<input id="text" value="Hello world"><input id="password" type="password" value="private-secret">';
  const input = document.querySelector<HTMLInputElement>("#text")!;
  input.setSelectionRange(6, 11, "backward");
  const anchor = captureBrowserAnnotationAnchor(input, "text", window);
  expect(anchor.textLocator).toMatchObject({
    kind: "form-control",
    selector: "#text",
    direction: "backward",
    rangeText: "world",
    startOffset: 6,
    endOffset: 11,
  });
  expect(resolveBrowserAnnotationAnchor(document, anchor)?.selectedText).toBe("world");
  input.value = "Hello there";
  expect(resolveBrowserAnnotationAnchor(document, anchor)).toBeNull();
  const password = document.querySelector<HTMLInputElement>("#password")!;
  password.setSelectionRange(0, 7);
  expect(captureBrowserAnnotationAnchor(password, "password", window).selectedText).toBeUndefined();
});
test("frame transforms map captured rectangles and hit testing to the same viewport", () => {
  document.body.innerHTML = '<iframe id="scaled"></iframe>';
  const frame = document.querySelector("iframe")!;
  frame.contentDocument!.body.innerHTML = '<button id="target">Target</button>';
  const target = frame.contentDocument!.querySelector("button")!;
  Object.defineProperty(frame, "offsetWidth", { configurable: true, value: 100 });
  Object.defineProperty(frame, "offsetHeight", { configurable: true, value: 50 });
  vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(box(50, 60, 200, 100));
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(box(5, 6, 20, 10));
  const anchor = captureBrowserAnnotationAnchor(target, "target", window);
  expect(anchor.rect).toEqual({ x: 60, y: 72, width: 40, height: 20 });
  let point: number[] = [];
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => frame });
  Object.defineProperty(frame.contentDocument!, "elementFromPoint", {
    configurable: true,
    value: (x: number, y: number) => {
      point = [x, y];
      return target;
    },
  });
  expect(hitTestBrowserAnnotation(document, 60, 72)).toBe(target);
  expect(point).toEqual([5, 6]);
});
