import { describe, expect, test } from "vite-plus/test";
import { render } from "@/test/dom";
import { WorkbenchAutomationsIcon } from "./workbench-navigation-icons";
import {
  AskAiIcon,
  AutomationMoreIcon,
  BoardIcon,
  BranchStatusIcon,
  CalendarIcon,
  CalendarOverdueIcon,
  CanvasIcon,
  CheckmarkIcon,
  ClockIcon,
  CodeIcon,
  ComposerResumeIcon,
  DeleteIcon,
  DownloadIcon,
  EditIcon,
  ExpandPanelIcon,
  FileIcon,
  FileTabIconSvg,
  FolderIcon,
  FolderOpenIcon,
  ForkIcon,
  LocalStatusIcon,
  MultiSelectIcon,
  NfmLinkToolbarOpenIcon,
  NewChatIcon,
  NodexLogoMarkIcon,
  OpenInIcon,
  PageIcon,
  PanelRightHiddenIcon,
  PanelRightVisibleIcon,
  PluginsIcon,
  SidebarHiddenIcon,
  SidebarVisibleIcon,
  PendingWorktreeLocalIcon,
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
  TagsIcon,
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
    ["board", BoardIcon, "16"],
    ["canvas", CanvasIcon, "16"],
    ["code", CodeIcon, "20"],
    ["calendar", CalendarIcon, "16"],
    ["calendar overdue", CalendarOverdueIcon, "16"],
    ["clock", ClockIcon, "16"],
    ["plugins", PluginsIcon, "16"],
    ["multi-select", MultiSelectIcon, "20"],
    ["tags", TagsIcon, "20"],
    ["worktree setup", WorktreeSetupStatusIcon, "10"],
  ])("provides a CSS-independent fallback for %s", (_label, Icon, size) => {
    const view = render(<Icon />);
    const svg = view.container.querySelector("svg");

    expect(svg?.getAttribute("width")).toBe(size);
    expect(svg?.getAttribute("height")).toBe(size);
  });
});

describe("Database Property type icons", () => {
  test("keeps the canonical three-row Multi-select geometry", () => {
    const svg = render(<MultiSelectIcon />).container.querySelector("svg");

    expect(svg?.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(svg?.getAttribute("fill")).toBe("currentColor");
    expect(svg?.querySelector("path")?.getAttribute("d")).toBe(
      "M17.5 4.063v1.875H6.875V4.063zM6.875 10.938H17.5V9.062H6.875zm0 5H17.5v-1.876H6.875zM3.75 3.75a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5m0 5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5m0 5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5",
    );
  });
});

describe("one glyph behind each semantic wrapper", () => {
  test.each([
    ["clock", ClockIcon, WorkbenchAutomationsIcon],
    ["branch", BranchStatusIcon, ForkIcon],
    ["laptop", LocalStatusIcon, PendingWorktreeLocalIcon],
  ])("draws the %s from one geometry on the 20-unit grid", (_label, First, Second) => {
    const first = render(<First />).container;
    const second = render(<Second />).container;

    expect(first.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(second.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(pathSignature(first)).toEqual(pathSignature(second));
  });
});

describe("file and page identity icons", () => {
  test("share one geometry while preserving semantic component names", () => {
    const fileView = render(<FileIcon />);
    const pageView = render(<PageIcon />);
    const fileSvg = fileView.container.querySelector("svg");
    const pageSvg = pageView.container.querySelector("svg");

    expect(fileSvg?.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(pageSvg?.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(fileSvg?.querySelector("path")?.getAttribute("d")).toBe(
      pageSvg?.querySelector("path")?.getAttribute("d"),
    );
    expect(fileSvg?.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
    expect(fileSvg?.hasAttribute("data-file-page-icon")).toBe(true);
    expect(pageSvg?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("code identity icons", () => {
  test("preserves code file artwork alongside the editor code glyph", () => {
    const codeView = render(<CodeIcon />);
    const fileTabView = render(<FileTabIconSvg icon="code" />);
    const codeSvg = codeView.container.querySelector("svg");
    const fileTabSvg = fileTabView.container.querySelector("svg");

    expect(fileTabSvg?.getAttribute("viewBox")).toBe(codeSvg?.getAttribute("viewBox"));
    expect(fileTabSvg?.getAttribute("data-file-tab-icon")).toBe("code");
    expect(pathSignature(fileTabView.container)).not.toEqual(pathSignature(codeView.container));
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

describe("Nodex mark identity", () => {
  test("renders the compact monochrome mark from currentColor", () => {
    const view = render(<NodexLogoMarkIcon monochrome className="icon-xxs" />);
    const svg = view.container.querySelector("svg");
    const paths = svg?.querySelectorAll("path");

    expect(svg?.getAttribute("width")).toBe("20");
    expect(svg?.getAttribute("height")).toBe("20");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 800 800");
    expect(svg?.getAttribute("data-nodex-logo-mark")).toBe("monochrome");
    expect(paths?.[0]?.getAttribute("fill")).toBe("none");
    expect(paths?.[1]?.getAttribute("stroke")).toBe("currentColor");
    expect(paths?.[3]?.getAttribute("fill")).toBe("currentColor");
  });

  test("stands for the AI wherever an action asks it for something", () => {
    const ask = render(<AskAiIcon />).container.querySelector("svg");
    const mark = render(<NodexLogoMarkIcon monochrome />).container.querySelector("svg");
    const geometry = (svg: SVGSVGElement | null) =>
      [...(svg?.querySelectorAll("path") ?? [])].map((path) => path.getAttribute("d"));

    expect(ask?.getAttribute("data-nodex-logo-mark")).toBe("monochrome");
    expect(geometry(ask)).toEqual(geometry(mark));
    expect(ask?.getAttribute("class")).toBe("icon-xs shrink-0");
  });
});

describe("settings identity icons", () => {
  test.each([
    ["import", SettingsImportIcon, "0 0 16 16"],
    ["browser", SettingsBrowserIcon, "0 0 16 16"],
    ["computer use", SettingsComputerUseIcon, "0 0 21 20"],
    ["git", SettingsGitIcon, "0 0 16 16"],
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
    ["edit", EditIcon, "0 0 16 16", "21", "fill"],
    ["replace", ReplaceIcon, "0 0 24 24", "16", "stroke"],
    ["download", DownloadIcon, "0 0 16 16", "20", "fill"],
    ["delete", DeleteIcon, "0 0 16 16", "20", "fill"],
  ])("renders the app-owned %s glyph", (_label, Icon, viewBox, boxSize, paintAttribute) => {
    const view = render(<Icon />);
    const svg = view.container.querySelector("svg");
    const firstPath = svg?.querySelector("path");
    const paintOwner = firstPath?.hasAttribute(paintAttribute) ? firstPath : svg;

    expect(svg?.getAttribute("viewBox")).toBe(viewBox);
    expect(svg?.getAttribute("width")).toBe(boxSize);
    expect(svg?.getAttribute("height")).toBe(boxSize);
    expect(paintOwner?.getAttribute(paintAttribute)).toBe("currentColor");
  });

  test("uses the compact and large masters for open-in actions", () => {
    const openIn = render(<OpenInIcon />);
    const linkToolbarOpen = render(<NfmLinkToolbarOpenIcon />);

    expect(openIn.container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(linkToolbarOpen.container.querySelector("svg")?.getAttribute("viewBox")).toBe(
      "0 0 20 20",
    );
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

    const showSidebar = render(<SidebarVisibleIcon />);
    const hideSidebar = render(<SidebarHiddenIcon />);
    expect(pathSignature(panelVisible.container)).toEqual(pathSignature(hideSidebar.container));
    expect(pathSignature(panelHidden.container)).toEqual(pathSignature(showSidebar.container));
    expect(pathSignature(showSidebar.container)).not.toEqual(pathSignature(hideSidebar.container));
    expect(pathSignature(expand.container)).not.toEqual(pathSignature(restore.container));
  });

  test("renders the woven-ellipse outline and organic swirl filled plugins states", () => {
    const resting = render(<PluginsIcon />).container.querySelector("svg");
    const active = render(<PluginsIcon filled />).container.querySelector("svg");
    const restingPath = resting?.querySelector("path");
    const activePath = active?.querySelector("path");

    expect(resting?.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(active?.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(resting?.getAttribute("aria-hidden")).toBe("true");
    expect(restingPath?.getAttribute("stroke")).toBe("currentColor");
    expect(restingPath?.getAttribute("fill")).toBeNull();
    expect(activePath?.getAttribute("fill")).toBe("currentColor");
    expect(activePath?.getAttribute("stroke")).toBeNull();
    expect(activePath?.getAttribute("d")).not.toBe(restingPath?.getAttribute("d"));
  });
});

describe("queued follow-up icon geometry", () => {
  test.each([
    ["follow-up lane", QueuedFollowUpIcon, "0 0 16 16", 3, "M2.33325 2.18164"],
    ["steer", QueueSteerIcon, "0 0 21 21", 1, "M13.1293 7.34753"],
    ["pause", QueuePauseIcon, "0 0 16 16", 2, "M5.89966 4.14111"],
    ["delivery failure", QueueFailureIcon, "0 0 20 20", 2, "M9.995 12.315"],
    ["pending steer information", QueuePendingInfoIcon, "0 0 21 21", 3, "M10.6 9.70459"],
    ["resume", ComposerResumeIcon, "0 0 16 16", 1, "M5.05811 4.68954"],
    ["more", AutomationMoreIcon, "0 0 16 16", 3, "M3.33362 6.80811"],
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

    expect(svg?.getAttribute("width")).toBe("24");
    expect(svg?.querySelectorAll("path")).toHaveLength(6);
    expect(svg?.querySelector("[stroke]")).toBeNull();
  });
});
