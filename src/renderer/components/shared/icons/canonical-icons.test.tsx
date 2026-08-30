import { describe, expect, test } from "vite-plus/test";
import { render } from "@/test/dom";
import { TERMINAL_ICON_GEOMETRY } from "../../../../shared/icon-geometry";
import {
  ConversationIcon,
  CopyIcon,
  DatabaseLabelIcon,
  FilterIcon,
  FullWidthIcon,
  ImageIcon,
  InfoIcon,
  ListLayoutIcon,
  LoadingIcon,
  MoveDownIcon,
  MoveUpIcon,
  PageHistoryIcon,
  PauseIcon,
  PlayIcon,
  ResetIcon,
  RetryIcon,
  SortAscendingIcon,
  SortDescendingIcon,
  TerminalIcon,
  VisibilityIcon,
  VisibilityOffIcon,
} from "./canonical-icons";

function pathSignature(container: HTMLElement) {
  return [...container.querySelectorAll("path")].map((path) => path.getAttribute("d"));
}

describe("canonical shared icons", () => {
  test("keeps intrinsic sizing, currentColor geometry, and caller classes", () => {
    const view = render(<CopyIcon className="size-4" />);
    const icon = view.container.querySelector("svg");
    const path = icon?.querySelector("path");

    expect(icon?.getAttribute("width")).toBe("20");
    expect(icon?.getAttribute("height")).toBe("20");
    expect(icon?.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(icon?.getAttribute("class")).toBe("size-4");
    expect(path?.getAttribute("fill")).toBe("currentColor");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  test("keeps the full-width affordance distinct from the 20px glyph defaults", () => {
    const view = render(<FullWidthIcon />);
    const icon = view.container.querySelector("svg");
    const path = icon?.querySelector("path");

    expect(icon?.getAttribute("width")).toBe("16");
    expect(icon?.getAttribute("height")).toBe("16");
    expect(icon?.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(path?.getAttribute("stroke")).toBe("currentColor");
    expect(path?.getAttribute("stroke-width")).toBe("1.5");
  });

  test("preserves the Page Stage history affordance", () => {
    const view = render(<PageHistoryIcon />);
    const icon = view.container.querySelector("svg");
    const path = icon?.querySelector("path");

    expect(icon?.getAttribute("width")).toBe("16");
    expect(icon?.getAttribute("height")).toBe("16");
    expect(icon?.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(path?.getAttribute("fill")).toBe("none");
    expect(path?.getAttribute("stroke")).toBe("currentColor");
    expect(path?.getAttribute("stroke-width")).toBe("1.5");
  });

  test.each([
    ["conversation", ConversationIcon, 1],
    ["database label", DatabaseLabelIcon, 2],
  ])("preserves the app-owned 16px %s identity", (_label, Icon, pathCount) => {
    const view = render(<Icon />);
    const icon = view.container.querySelector("svg");

    expect(icon?.getAttribute("width")).toBe("16");
    expect(icon?.getAttribute("height")).toBe("16");
    expect(icon?.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(icon?.querySelectorAll("path")).toHaveLength(pathCount);
    expect(icon?.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
  });

  test("uses the transport-neutral terminal geometry as its render source", () => {
    const view = render(<TerminalIcon />);
    const paths = [...view.container.querySelectorAll("path")].map((path) =>
      path.getAttribute("d"),
    );

    expect(paths).toEqual(TERMINAL_ICON_GEOMETRY.paths.map((path) => path.d));
  });

  test("keeps directional actions as semantic wrappers over one glyph", () => {
    const ascending = render(<SortAscendingIcon />).container.querySelector("path");
    const descending = render(<SortDescendingIcon />).container.querySelector("path");
    const moveUp = render(<MoveUpIcon />).container.querySelector("path");
    const moveDown = render(<MoveDownIcon />).container.querySelector("path");

    expect(moveUp?.getAttribute("d")).toBe(ascending?.getAttribute("d"));
    expect(moveDown?.getAttribute("d")).toBe(descending?.getAttribute("d"));
    expect(descending?.getAttribute("transform")).toBe("rotate(180 10 10)");
  });

  test.each([
    ["filter", FilterIcon, "0 0 20 20", 3, "M12.5 14.0049", "fill"],
    ["list layout", ListLayoutIcon, "0 0 24 24", 6, "M3 5h.01", "stroke"],
    ["image", ImageIcon, "0 0 24 24", 3, "M5 3h14", "stroke"],
    ["loading", LoadingIcon, "0 0 24 24", 2, "M18 12C18", "fill"],
  ])(
    "preserves the reviewed %s geometry",
    (_label, Icon, viewBox, pathCount, firstPathPrefix, paintAttribute) => {
      const view = render(<Icon />);
      const svg = view.container.querySelector("svg");
      const firstPath = svg?.querySelector("path");

      expect(svg?.getAttribute("viewBox")).toBe(viewBox);
      expect(svg?.querySelectorAll("path")).toHaveLength(pathCount);
      expect(firstPath?.getAttribute("d")?.startsWith(firstPathPrefix)).toBe(true);
      expect(firstPath?.getAttribute(paintAttribute)).toBe("currentColor");
    },
  );

  test("keeps reset and retry as semantic names for the reviewed retry glyph", () => {
    const reset = render(<ResetIcon />);
    const retry = render(<RetryIcon />);

    expect(pathSignature(reset.container)).toEqual(pathSignature(retry.container));
  });

  test("keeps multi-state controls visually distinct", () => {
    const visibility = render(<VisibilityIcon />);
    const visibilityOff = render(<VisibilityOffIcon />);
    const play = render(<PlayIcon />);
    const pause = render(<PauseIcon />);

    expect(pathSignature(visibility.container)).not.toEqual(pathSignature(visibilityOff.container));
    expect(pathSignature(play.container)).not.toEqual(pathSignature(pause.container));
  });

  test("preserves the faded loading track", () => {
    const view = render(<LoadingIcon />);

    expect(view.container.querySelector("path")?.getAttribute("opacity")).toBe("0.3");
  });

  test("does not hide an icon that has an accessible name", () => {
    const labelled = render(<InfoIcon aria-label="Information" />).container.querySelector("svg");
    const labelledBy = render(<InfoIcon aria-labelledby="info-label" />).container.querySelector(
      "svg",
    );
    const decorative = render(<InfoIcon />).container.querySelector("svg");
    const explicit = render(<InfoIcon ariaHidden={false} />).container.querySelector("svg");

    expect(labelled?.hasAttribute("aria-hidden")).toBe(false);
    expect(labelledBy?.hasAttribute("aria-hidden")).toBe(false);
    expect(decorative?.getAttribute("aria-hidden")).toBe("true");
    expect(explicit?.getAttribute("aria-hidden")).toBe("false");
  });
});
