import { describe, expect, test } from "vite-plus/test";
import { render } from "@/test/dom";
import {
  AutomationMoreIcon,
  BoardIcon,
  CalendarIcon,
  CalendarOverdueIcon,
  CanvasIcon,
  CheckmarkIcon,
  ClockIcon,
  CodeIcon,
  ComposerResumeIcon,
  DatabaseIcon,
  DeleteIcon,
  DownloadIcon,
  EditIcon,
  ExpandPanelIcon,
  FileIcon,
  FileTabIconSvg,
  FolderIcon,
  FolderOpenIcon,
  NfmLinkToolbarOpenIcon,
  NewChatIcon,
  OpenInIcon,
  PageIcon,
  PanelRightHiddenIcon,
  PanelRightVisibleIcon,
  QueueFailureIcon,
  QueuePauseIcon,
  QueuePendingInfoIcon,
  QueueSteerIcon,
  QueuedFollowUpIcon,
  RepeatIcon,
  ReplaceIcon,
  RestorePanelIcon,
  SettingsBrowserIcon,
  SettingsComputerUseIcon,
  SettingsGitIcon,
  SettingsImportIcon,
  SettingsPasswordsIcon,
  SidePanelSideChatIcon,
  SidebarManualOrderIcon,
  WorktreeSetupStatusIcon,
} from "./app-icons";

function pathSignature(container: HTMLElement) {
  return [...container.querySelectorAll("path")].map((path) => path.getAttribute("d"));
}

describe("shared icon intrinsic geometry", () => {
  test.each([
    ["new chat", NewChatIcon, "16"],
    ["folder", FolderIcon, "16"],
    ["open folder", FolderOpenIcon, "16"],
    ["database", DatabaseIcon, "16"],
    ["board", BoardIcon, "16"],
    ["canvas", CanvasIcon, "16"],
    ["code", CodeIcon, "20"],
    ["calendar", CalendarIcon, "16"],
    ["calendar overdue", CalendarOverdueIcon, "16"],
    ["clock", ClockIcon, "16"],
    ["worktree setup", WorktreeSetupStatusIcon, "10"],
  ])("provides a CSS-independent fallback for %s", (_label, Icon, size) => {
    const view = render(<Icon />);
    const svg = view.container.querySelector("svg");

    expect(svg?.getAttribute("width")).toBe(size);
    expect(svg?.getAttribute("height")).toBe(size);
  });
});

describe("file and page identity icons", () => {
  test("share one geometry while preserving semantic component names", () => {
    const fileView = render(<FileIcon />);
    const pageView = render(<PageIcon />);
    const fileSvg = fileView.container.querySelector("svg");
    const pageSvg = pageView.container.querySelector("svg");

    expect(fileSvg?.getAttribute("viewBox")).toBe("0 0 21 21");
    expect(pageSvg?.getAttribute("viewBox")).toBe("0 0 21 21");
    expect(fileSvg?.querySelector("path")?.getAttribute("d")).toBe(
      pageSvg?.querySelector("path")?.getAttribute("d"),
    );
    expect(fileSvg?.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
    expect(fileSvg?.hasAttribute("data-file-page-icon")).toBe(true);
    expect(pageSvg?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("code identity icons", () => {
  test("uses the canonical Code geometry for generic file tabs", () => {
    const codeView = render(<CodeIcon />);
    const fileTabView = render(<FileTabIconSvg icon="code" />);
    const codeSvg = codeView.container.querySelector("svg");
    const fileTabSvg = fileTabView.container.querySelector("svg");

    expect(fileTabSvg?.getAttribute("viewBox")).toBe(codeSvg?.getAttribute("viewBox"));
    expect(fileTabSvg?.querySelector("path")?.getAttribute("d")).toBe(
      codeSvg?.querySelector("path")?.getAttribute("d"),
    );
  });
});

describe("decorative icon accessibility", () => {
  test("hides an unlabelled checkmark without overriding an accessible name", () => {
    const decorative = render(<CheckmarkIcon />).container.querySelector("svg");
    const labelled = render(<CheckmarkIcon aria-label="Selected" />).container.querySelector("svg");
    const explicit = render(<CheckmarkIcon aria-hidden={false} />).container.querySelector("svg");

    expect(decorative?.getAttribute("aria-hidden")).toBe("true");
    expect(labelled?.hasAttribute("aria-hidden")).toBe(false);
    expect(explicit?.getAttribute("aria-hidden")).toBe("false");
  });
});

describe("settings identity icons", () => {
  test.each([
    ["import", SettingsImportIcon, "0 0 20 20"],
    ["browser", SettingsBrowserIcon, "0 0 16 16"],
    ["computer use", SettingsComputerUseIcon, "0 0 21 20"],
    ["git", SettingsGitIcon, "0 0 20 20"],
    ["passwords", SettingsPasswordsIcon, "0 0 20 20"],
  ])("renders an app-owned geometry for %s", (_label, Icon, viewBox) => {
    const view = render(<Icon />);
    const svg = view.container.querySelector("svg");

    expect(svg?.getAttribute("viewBox")).toBe(viewBox);
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.querySelectorAll("path, circle").length).toBeGreaterThan(0);
  });
});

describe("shared action icon geometry", () => {
  test.each([
    ["edit", EditIcon, "0 0 21 21", "M11.7313 4.20472", "fill"],
    ["replace", ReplaceIcon, "0 0 14 14", "M10.5 4.667", "stroke"],
    ["download", DownloadIcon, "0 0 20 20", "M2.66831 12.6664", "fill"],
    ["delete", DeleteIcon, "0 0 20 20", "M10.6299 1.33496", "fill"],
  ])("renders the app-owned %s glyph", (_label, Icon, viewBox, pathPrefix, paintAttribute) => {
    const view = render(<Icon />);
    const svg = view.container.querySelector("svg");
    const firstPath = svg?.querySelector("path");
    const paintOwner = firstPath?.hasAttribute(paintAttribute) ? firstPath : svg;

    expect(svg?.getAttribute("viewBox")).toBe(viewBox);
    expect(firstPath?.getAttribute("d")?.startsWith(pathPrefix)).toBe(true);
    expect(paintOwner?.getAttribute(paintAttribute)).toBe("currentColor");
  });

  test("uses the reviewed link-toolbar geometry for open-in actions", () => {
    const openIn = render(<OpenInIcon />);
    const linkToolbarOpen = render(<NfmLinkToolbarOpenIcon />);

    expect(pathSignature(openIn.container)).toEqual(pathSignature(linkToolbarOpen.container));
  });

  test("preserves the reviewed repeat glyph", () => {
    const view = render(<RepeatIcon />);
    const svg = view.container.querySelector("svg");
    const path = svg?.querySelector("path");

    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(path?.getAttribute("d")?.startsWith("m2 9")).toBe(true);
    expect(path?.getAttribute("stroke")).toBe("currentColor");
  });

  test("keeps panel visibility and expand controls visually distinct", () => {
    const panelVisible = render(<PanelRightVisibleIcon />);
    const panelHidden = render(<PanelRightHiddenIcon />);
    const expand = render(<ExpandPanelIcon />);
    const restore = render(<RestorePanelIcon />);

    expect(pathSignature(panelVisible.container)).not.toEqual(pathSignature(panelHidden.container));
    expect(pathSignature(expand.container)).not.toEqual(pathSignature(restore.container));
  });
});

describe("queued follow-up icon geometry", () => {
  test.each([
    ["follow-up lane", QueuedFollowUpIcon, "0 0 20 20", 1, "M2.66797 11V3.33301"],
    ["steer", QueueSteerIcon, "0 0 21 21", 1, "M13.1293 7.34753"],
    ["pause", QueuePauseIcon, "0 0 20 20", 2, "M6.875 5.83333"],
    ["delivery failure", QueueFailureIcon, "0 0 20 20", 2, "M9.995 12.315"],
    ["pending steer information", QueuePendingInfoIcon, "0 0 21 21", 3, "M10.6 9.70459"],
    ["resume", ComposerResumeIcon, "0 0 20 20", 1, "M6 14.7227"],
    ["more", AutomationMoreIcon, "0 0 21 21", 3, "M15.6981 9.04712"],
    ["side chat", SidePanelSideChatIcon, "0 0 20 20", 2, "M3.165 10"],
  ])("preserves the fill-only %s glyph", (_label, Icon, viewBox, pathCount, firstPathPrefix) => {
    const view = render(<Icon />);
    const svg = view.container.querySelector("svg");
    const paths = svg?.querySelectorAll("path") ?? [];

    expect(svg?.getAttribute("viewBox")).toBe(viewBox);
    expect(paths).toHaveLength(pathCount);
    expect(paths[0]?.getAttribute("d")?.startsWith(firstPathPrefix)).toBe(true);
    expect(svg?.querySelector("[stroke]")).toBeNull();
  });

  test("preserves the six-dot queued-message reorder grip", () => {
    const view = render(<SidebarManualOrderIcon />);
    const svg = view.container.querySelector("svg");

    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg?.querySelectorAll("circle")).toHaveLength(6);
    expect(svg?.querySelector("[stroke]")).toBeNull();
  });
});
