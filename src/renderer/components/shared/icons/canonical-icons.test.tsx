import { describe, expect, test } from "vite-plus/test";
import { render } from "@/test/dom";
import { TerminalActivityIcon } from "./activity-icons";
import {
  ChatIcon,
  CopyIcon,
  DatabaseLabelIcon,
  DispatchIcon,
  FilterIcon,
  ImageIcon,
  InfoIcon,
  ListLayoutIcon,
  LoadingIcon,
  MoveDownIcon,
  MoveUpIcon,
  PauseIcon,
  PlayIcon,
  ResetIcon,
  RetryIcon,
  ImportantIcon,
  NoteIcon,
  QuestionIcon,
  SendToChatIcon,
  TodoIcon,
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
    expect(icon?.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(icon?.classList.contains("size-4")).toBe(true);
    expect(path?.getAttribute("fill")).toBe("currentColor");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  test.each([
    ["chat", ChatIcon, 1],
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

  test("uses the same terminal glyph in activities and navigation", () => {
    const terminal = render(<TerminalIcon />);
    const activity = render(<TerminalActivityIcon />);
    expect(pathSignature(terminal.container)).toEqual(pathSignature(activity.container));
  });

  test("keeps directional actions as semantic wrappers over one glyph", () => {
    const ascending = render(<SortAscendingIcon />).container.querySelector("path");
    const descending = render(<SortDescendingIcon />).container.querySelector("path");
    const moveUp = render(<MoveUpIcon />).container.querySelector("path");
    const moveDown = render(<MoveDownIcon />).container.querySelector("path");

    expect(moveUp?.getAttribute("d")).toBe(ascending?.getAttribute("d"));
    expect(moveDown?.getAttribute("d")).toBe(descending?.getAttribute("d"));
    expect(ascending?.getAttribute("d")).not.toBe(descending?.getAttribute("d"));
  });

  test.each([
    ["filter", FilterIcon, "0 0 16 16", "20"],
    ["list layout", ListLayoutIcon, "0 0 16 16", "16"],
    ["image", ImageIcon, "0 0 16 16", "24"],
    ["loading", LoadingIcon, "0 0 24 24", "24"],
  ])("preserves the %s box and currentColor paint", (_label, Icon, viewBox, boxSize) => {
    const view = render(<Icon />);
    const svg = view.container.querySelector("svg");
    const firstPath = svg?.querySelector("path");

    expect(svg?.getAttribute("viewBox")).toBe(viewBox);
    expect(svg?.getAttribute("width")).toBe(boxSize);
    expect(svg?.getAttribute("height")).toBe(boxSize);
    expect(firstPath?.getAttribute("fill")).toBe("currentColor");
  });

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

  test("keeps work-kind icons visually distinct", () => {
    const glyphs = [NoteIcon, TodoIcon, QuestionIcon, SendToChatIcon, DispatchIcon, ImportantIcon];
    const signatures = glyphs.map((Icon) => {
      const view = render(<Icon />);
      return pathSignature(view.container).join(" ");
    });

    expect(signatures.every(Boolean)).toBe(true);
    expect(new Set(signatures).size).toBe(glyphs.length);
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
