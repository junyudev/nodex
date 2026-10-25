import { describe, expect, test } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { render } from "../../test/dom";
import { NodexSwitch } from "./button";
import {
  NodexCheckbox,
  NodexSettingsExpandableRow,
  NodexSettingsNumberInput,
  NodexSettingsPageSurface,
  NodexSettingsRow,
  NodexSettingsSection,
  useNodexSettingsDisclosures,
} from "./settings";

describe("NodexSettingsPageSurface", () => {
  test("renders a labelled settings main surface with semantic headings", () => {
    const view = render(
      <NodexSettingsPageSurface title="Environments">
        <NodexSettingsSection title="Local environments">
          <NodexSettingsRow label="Default environment" description="Used for new tasks">
            <button type="button">Choose</button>
          </NodexSettingsRow>
        </NodexSettingsSection>
      </NodexSettingsPageSurface>,
    );

    const main = view.getByRole("main");
    const pageHeading = view.getByRole("heading", { level: 1, name: "Environments" });
    const section = view.getByRole("region", { name: "Local environments" });
    const sectionHeading = view.getByRole("heading", {
      level: 2,
      name: "Local environments",
    });

    expect(main.getAttribute("aria-labelledby")).toBe(pageHeading.id);
    expect(section.getAttribute("aria-labelledby")).toBe(sectionHeading.id);
    expect(view.getByText("Used for new tasks").textContent).toBe("Used for new tasks");
  });
});

describe("shared settings controls", () => {
  test("keeps number, switch, and checkbox controls semantic and interactive", () => {
    function Controls() {
      const [switchChecked, setSwitchChecked] = useState(false);
      const [checkboxChecked, setCheckboxChecked] = useState(false);

      return (
        <>
          <NodexSettingsNumberInput
            aria-label="Sans font size"
            defaultValue={15}
            min={11}
            max={20}
            step={1}
          />
          <NodexSwitch
            ariaLabel="Safety backup"
            checked={switchChecked}
            onCheckedChange={setSwitchChecked}
          />
          <NodexCheckbox
            ariaLabel="Platform specific"
            checked={checkboxChecked}
            onCheckedChange={setCheckboxChecked}
          />
        </>
      );
    }

    const view = render(<Controls />);
    const numberInput = view.getByRole("spinbutton", { name: "Sans font size" });
    expect(numberInput.getAttribute("type")).toBe("number");
    expect(numberInput.getAttribute("min")).toBe("11");
    expect(numberInput.getAttribute("max")).toBe("20");

    const switchControl = view.getByRole("switch", { name: "Safety backup" });
    expect(switchControl.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(switchControl);
    expect(switchControl.getAttribute("aria-checked")).toBe("true");

    const checkbox = view.getByRole("checkbox", { name: "Platform specific" });
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(checkbox);
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
  });
});

const click = async (element: HTMLElement) =>
  act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });

describe("collapsible settings sections", () => {
  function Page({ revealed }: { readonly revealed: string | null }) {
    const disclosure = useNodexSettingsDisclosures(revealed);
    return (
      <>
        <NodexSettingsSection
          id="codex"
          title="Codex"
          description="OpenAI's coding agent."
          summary="Default setup"
          disclosure={disclosure("codex")}
        >
          <NodexSettingsRow label="Codex home">
            <input aria-label="Codex home" />
          </NodexSettingsRow>
        </NodexSettingsSection>
        <NodexSettingsSection
          id="claude"
          title="Claude Code"
          summary="On"
          disclosure={disclosure("claude")}
        >
          <NodexSettingsRow label="Profiles">
            <span>Claude Code profiles</span>
          </NodexSettingsRow>
        </NodexSettingsSection>
      </>
    );
  }
  const header = (view: ReturnType<typeof render>, name: string) =>
    view.getByRole("button", { name });
  const panelOf = (element: HTMLElement) => element.closest("[data-open], [data-closed]")!;

  test("start closed, summarize themselves, and keep drafts while collapsed", async () => {
    const view = render(<Page revealed={null} />);
    const codex = header(view, "Codex");
    expect(view.getByRole("heading", { level: 2, name: "Codex" })).toBeTruthy();
    expect(codex.getAttribute("aria-expanded")).toBe("false");
    expect(codex.getAttribute("aria-describedby")!.split(" ").length).toBe(2);
    expect(view.getByText("Default setup")).toBeTruthy();
    expect(panelOf(view.getByLabelText("Codex home")).hasAttribute("data-closed")).toBe(true);

    await click(codex);
    expect(codex.getAttribute("aria-expanded")).toBe("true");
    expect(view.queryByText("Default setup")).toBeNull();
    fireEvent.change(view.getByLabelText("Codex home"), { target: { value: "~/work-codex" } });
    await click(codex);
    expect(view.getByText("Default setup")).toBeTruthy();
    await click(codex);
    expect((view.getByLabelText("Codex home") as HTMLInputElement).value).toBe("~/work-codex");
    expect(header(view, "Claude Code").getAttribute("aria-expanded")).toBe("false");
  });

  test("open the section a link lands on, leaving the others as they are", async () => {
    const view = render(<Page revealed="claude" />);
    expect(header(view, "Claude Code").getAttribute("aria-expanded")).toBe("true");
    expect(header(view, "Codex").getAttribute("aria-expanded")).toBe("false");

    await click(header(view, "Claude Code"));
    view.rerender(<Page revealed="codex" />);
    expect(header(view, "Codex").getAttribute("aria-expanded")).toBe("true");
    expect(header(view, "Claude Code").getAttribute("aria-expanded")).toBe("false");
    view.rerender(<Page revealed="claude" />);
    expect(header(view, "Claude Code").getAttribute("aria-expanded")).toBe("true");
    expect(header(view, "Codex").getAttribute("aria-expanded")).toBe("true");
  });
});

describe("NodexSettingsExpandableRow", () => {
  test("mounts its configuration only while expanded and keeps its controls apart", async () => {
    function Row() {
      const [expanded, setExpanded] = useState(false);
      const [enabled, setEnabled] = useState(true);
      return (
        <NodexSettingsExpandableRow
          label="Work"
          detail="claude · ~/work"
          expanded={expanded}
          onExpandedChange={setExpanded}
          controls={
            <NodexSwitch ariaLabel="Turn off Work" checked={enabled} onCheckedChange={setEnabled} />
          }
        >
          <input aria-label="Profile name" />
        </NodexSettingsExpandableRow>
      );
    }
    const view = render(<Row />);
    const toggle = view.getByRole("button", { name: /^Work/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByLabelText("Profile name")).toBeNull();

    await click(view.getByRole("switch", { name: "Turn off Work" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const name = view.getByLabelText("Profile name");
    expect(toggle.getAttribute("aria-controls")).toBe(name.parentElement!.id);
    await click(toggle);
    expect(view.queryByLabelText("Profile name")).toBeNull();
  });
});
