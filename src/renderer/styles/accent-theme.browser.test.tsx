import { act, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import { NodexCheckbox } from "@/components/ui/settings";
import {
  applyCodexThemeVariant,
  CODEX_ACCENT_PRESETS,
  DEFAULT_CODEX_ACCENT,
  getCodexAccentStyle,
  resolveEffectiveCodexAccent,
  type CodexAccent,
} from "@/lib/codex-theme-variant";

import "@blocknote/shadcn/style.css";
import "@/globals.css";

const accentCases: Array<{ label: string; accent: CodexAccent }> = [
  ...CODEX_ACCENT_PRESETS.map((name) => ({
    label: name,
    accent: { kind: "preset" as const, name },
  })),
  { label: "custom light", accent: { kind: "custom", color: "#ffffff" } },
  { label: "custom blue", accent: { kind: "custom", color: "#0169cc" } },
];
const paintCases = accentCases.flatMap((accent) =>
  (["light", "dark"] as const).map((variant) => ({ ...accent, variant })),
);

function AccentSurfaces() {
  return (
    <main>
      <NodexButton variant="ghost" className="bg-composer-primary text-composer-primary">
        Send
      </NodexButton>
      <NodexButton variant="ghost" className="bg-composer-primary text-composer-primary">
        Stop
      </NodexButton>
      <NodexButton variant="primary">Primary action</NodexButton>
      <NodexButton variant="accentAction">Accent action</NodexButton>
      <NodexSwitch checked ariaLabel="Checked switch" onCheckedChange={() => undefined} />
      <NodexCheckbox checked ariaLabel="Checked checkbox" onCheckedChange={() => undefined} />
      <p data-testid="message" className="bg-user-message text-user-message">
        User message
      </p>
      <a href="#reference" className="text-info">
        Reference
      </a>
      <div
        role="progressbar"
        aria-label="Agent progress"
        aria-valuenow={50}
        className="bg-text-info h-1"
      />
      <span data-testid="selectable">Selectable conversation text</span>
      <span data-testid="danger" className="text-danger">
        Failure
      </span>
      <span data-testid="success" className="text-success">
        Complete
      </span>
      {[1, 2, 3, 4].map((step) => (
        <span
          key={step}
          data-testid={`chart-${step}`}
          style={{ backgroundColor: `var(--color-chart-sequential-${step})` }}
        >
          {step}
        </span>
      ))}
      <button
        data-testid="sidebar-primary"
        className="bg-sidebar-primary text-sidebar-primary-foreground"
      >
        Sidebar action
      </button>
      <span data-testid="accent-chart" className="bg-chart-3">
        Accent chart series
      </span>
      <span data-testid="legacy-accent" style={{ color: "var(--accent-blue)" }}>
        Accent alias
      </span>
      <section
        className="nfm-editor"
        data-nodex-editor-selection-surface
        data-nodex-active-editor-selection-surface
        data-nodex-block-selection-presentation
      >
        <div data-toggle-drop-overlay data-testid="toggle-drop">
          Drop into toggle
        </div>
        <div className="prosemirror-dropcursor-block" data-testid="drop-cursor" />
        <div className="bn-editor">
          <div
            className="bn-block-content"
            data-nodex-selected-block-content
            data-testid="selected-block"
          >
            Selected block
          </div>
          <button className="bn-code-block-source-popup-ok-button">Apply code</button>
          <div className="bn-block-content" data-content-type="checkListItem">
            <div>
              <input type="checkbox" aria-label="Editor checklist" checked readOnly />
            </div>
          </div>
          <div className="bn-block-content" data-content-type="table">
            <table>
              <tbody>
                <tr>
                  <td className="selectedCell" data-testid="selected-cell">
                    Selected cell
                  </td>
                  <td
                    data-background-color="blue"
                    data-text-color="blue"
                    data-testid="categorical-blue"
                  >
                    Blue category
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <span className="nfm-search-match" data-testid="search-match">
            Match
          </span>
          <span
            className="nfm-search-match nfm-search-match-active"
            data-testid="active-search-match"
          >
            Active match
          </span>
        </div>
      </section>
    </main>
  );
}

function applyAccent(variant: "light" | "dark", accent: CodexAccent): void {
  const root = document.documentElement;
  root.dataset.codexWindowType = "electron";
  root.classList.toggle("dark", variant === "dark");
  root.classList.toggle("electron-dark", variant === "dark");
  root.classList.toggle("electron-light", variant === "light");
  applyCodexThemeVariant(root, variant, document.body, accent);
}

/** Normalize reference-tested runtime values through the same browser color parser as paint. */
function color(value: string): string {
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.append(probe);
  const result = getComputedStyle(probe).color;
  probe.remove();
  return result;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  const root = document.documentElement;
  root.removeAttribute("style");
  root.removeAttribute("data-theme");
  root.removeAttribute("data-codex-window-type");
  root.classList.remove("dark", "electron-dark", "electron-light");
});

test.each(paintCases)(
  "paints $label accents through shared controls and semantic roles in $variant",
  async ({ variant, accent }) => {
    applyAccent(variant, DEFAULT_CODEX_ACCENT);
    const view = render(<AccentSurfaces />);
    const statusColors = ["danger", "success"].map(
      (role) => getComputedStyle(view.getByTestId(role)).color,
    );
    const searchColors = ["search-match", "active-search-match"].map(
      (role) => getComputedStyle(view.getByTestId(role)).backgroundColor,
    );
    view.unmount();

    applyAccent(variant, accent);
    const surfaces = render(<AccentSurfaces />);
    const styles = getCodexAccentStyle(variant, resolveEffectiveCodexAccent(accent));
    const send = surfaces.getByRole("button", { name: "Send" });
    const stop = surfaces.getByRole("button", { name: "Stop" });
    for (const action of [send, stop]) {
      expect(getComputedStyle(action).backgroundColor).toBe(
        color(styles["--color-background-composer-primary"]!),
      );
      expect(getComputedStyle(action).color).toBe(color(styles["--color-text-composer-primary"]!));
    }
    const bubble = surfaces.getByTestId("message");
    expect(getComputedStyle(bubble).backgroundColor).toBe(
      color(styles["--color-background-user-message"]!),
    );
    expect(getComputedStyle(bubble).color).toBe(color(styles["--color-text-user-message"]!));
    expect(getComputedStyle(surfaces.getByRole("link", { name: "Reference" })).color).toBe(
      color(styles["--app-color-text-accent"]!),
    );
    expect(getComputedStyle(surfaces.getByRole("progressbar")).backgroundColor).toBe(
      color(styles["--app-color-text-accent"]!),
    );

    const accentAction = surfaces.getByRole("button", { name: "Accent action" });
    expect(getComputedStyle(accentAction).backgroundColor).toBe(
      color(styles["--app-color-accent-blue"]!),
    );
    expect(getComputedStyle(accentAction).color).toBe(color(styles["--app-color-text-on-accent"]!));
    const switchTrack = surfaces.getByRole("switch").firstElementChild;
    if (!switchTrack) throw new Error("Checked switch track is missing");
    expect(getComputedStyle(switchTrack).backgroundColor).toBe(
      color(styles["--app-color-accent-blue"]!),
    );
    const switchThumb = switchTrack.firstElementChild;
    if (!switchThumb) throw new Error("Checked switch thumb is missing");
    expect(getComputedStyle(switchThumb).backgroundColor).toBe("rgb(255, 255, 255)");
    const primaryBackground = getComputedStyle(
      surfaces.getByRole("button", { name: "Primary action" }),
    ).backgroundColor;
    expect(
      getComputedStyle(surfaces.getByRole("checkbox", { name: "Checked checkbox" }))
        .backgroundColor,
    ).toBe(primaryBackground);
    expect(
      getComputedStyle(surfaces.getByRole("checkbox", { name: "Checked checkbox" })).color,
    ).toBe(getComputedStyle(surfaces.getByRole("button", { name: "Primary action" })).color);

    const primaryInk = getComputedStyle(
      surfaces.getByRole("button", { name: "Primary action" }),
    ).color;
    const editorChecklist = surfaces.getByRole("checkbox", { name: "Editor checklist" });
    expect(getComputedStyle(editorChecklist).backgroundColor).toBe(primaryBackground);
    expect(getComputedStyle(editorChecklist, "::after").borderTopColor).toBe(primaryInk);
    for (const element of [
      surfaces.getByTestId("sidebar-primary"),
      surfaces.getByRole("button", { name: "Apply code" }),
    ]) {
      expect(getComputedStyle(element).backgroundColor).toBe(
        color(styles["--app-color-accent-blue"]!),
      );
      expect(getComputedStyle(element).color).toBe(color(styles["--app-color-text-on-accent"]!));
    }
    expect(getComputedStyle(surfaces.getByTestId("legacy-accent")).color).toBe(
      color(styles["--app-color-accent-blue"]!),
    );
    expect(getComputedStyle(surfaces.getByTestId("accent-chart")).backgroundColor).toBe(
      color(styles["--app-color-accent-blue"]!),
    );
    const selectedCell = surfaces.getByTestId("selected-cell");
    expect(getComputedStyle(selectedCell).backgroundColor).toBe(
      color(styles["--color-background-text-selection"]!),
    );
    expect(getComputedStyle(selectedCell, "::after").borderTopColor).toBe(
      color(styles["--app-color-border-focus"]!),
    );
    expect(
      getComputedStyle(surfaces.getByTestId("selected-block"), "::after").backgroundColor,
    ).toBe(color(styles["--color-background-text-selection"]!));
    expect(getComputedStyle(surfaces.getByTestId("toggle-drop")).backgroundColor).toBe(
      color(styles["--color-background-text-selection"]!),
    );
    expect(getComputedStyle(surfaces.getByTestId("drop-cursor")).backgroundColor).toBe(
      color(styles["--app-color-border-focus"]!),
    );
    const categoricalBlue = getComputedStyle(surfaces.getByTestId("categorical-blue"));
    expect(categoricalBlue.color).toBe("rgb(51, 156, 255)");
    expect(categoricalBlue.backgroundColor).toBe(
      color("color-mix(in srgb, #339cff 22%, transparent)"),
    );
    expect(
      ["search-match", "active-search-match"].map(
        (role) => getComputedStyle(surfaces.getByTestId(role)).backgroundColor,
      ),
    ).toEqual(searchColors);

    await act(async () => {
      await userEvent.keyboard("{Tab}");
      window.getSelection()?.selectAllChildren(surfaces.getByTestId("selectable"));
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(send);
    expect(getComputedStyle(send).boxShadow).not.toBe("none");
    expect(getComputedStyle(send).boxShadow).toContain(color(styles["--app-color-border-focus"]!));
    const selection = getComputedStyle(surfaces.getByTestId("selectable"), "::selection");
    expect(selection.backgroundColor).toBe(color(styles["--color-background-text-selection"]!));

    for (const step of [1, 2, 3, 4]) {
      const background = getComputedStyle(surfaces.getByTestId(`chart-${step}`)).backgroundColor;
      expect(background, `chart ${step}`).not.toBe("rgba(0, 0, 0, 0)");
      expect(background).toBe(color(styles[`--color-chart-sequential-${step}`]!));
    }
    expect(
      ["danger", "success"].map((role) => getComputedStyle(surfaces.getByTestId(role)).color),
    ).toEqual(statusColors);
  },
);

test.each(["light", "dark"] as const)(
  "renders Default as Blue and clears named, custom, and Black/White paint in %s",
  async (variant) => {
    applyAccent(variant, DEFAULT_CODEX_ACCENT);
    const view = render(<AccentSurfaces />);
    const capture = () => {
      const send = getComputedStyle(view.getByRole("button", { name: "Send" }));
      const message = getComputedStyle(view.getByTestId("message"));
      const link = getComputedStyle(view.getByRole("link"));
      return {
        send: send.backgroundColor,
        text: send.color,
        message: message.backgroundColor,
        link: link.color,
        selection: getComputedStyle(view.getByTestId("selectable"), "::selection").backgroundColor,
      };
    };
    const baseline = capture();
    const expectPalettePaint = async (accent: CodexAccent) => {
      const styles = getCodexAccentStyle(variant, resolveEffectiveCodexAccent(accent));
      const expected = {
        send: color(styles["--color-background-composer-primary"]!),
        text: color(styles["--color-text-composer-primary"]!),
        message: color(styles["--color-background-user-message"]!),
        link: color(styles["--app-color-text-accent"]!),
        selection: color(styles["--color-background-text-selection"]!),
      };
      await waitFor(() => expect(capture()).toEqual(expected));
    };
    expect(baseline.send).toBe(color(variant === "light" ? "#3a83f7" : "#2c67c5"));
    expect(baseline.text).toBe("rgb(255, 255, 255)");
    expect(baseline.message).toBe(color(variant === "light" ? "#e8f3fe" : "#173e76"));
    applyAccent(variant, { kind: "preset", name: "blue" });
    expect(capture()).toEqual(baseline);
    applyAccent(variant, { kind: "preset", name: "purple" });
    await expectPalettePaint({ kind: "preset", name: "purple" });
    expect(capture()).not.toEqual(baseline);
    applyAccent(variant, { kind: "custom", color: "#159c6f" });
    await expectPalettePaint({ kind: "custom", color: "#159c6f" });
    applyAccent(variant, DEFAULT_CODEX_ACCENT);
    await expectPalettePaint(DEFAULT_CODEX_ACCENT);
    expect(capture()).toEqual(baseline);
    applyAccent(variant, { kind: "preset", name: "black" });
    await expectPalettePaint({ kind: "preset", name: "black" });
    expect(capture().send).toBe(variant === "light" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)");
    expect(capture().message).toBe(color(variant === "light" ? "#000000" : "rgb(50 50 50 / 85%)"));
    expect(capture()).not.toEqual(baseline);
    applyAccent(variant, DEFAULT_CODEX_ACCENT);
    await expectPalettePaint(DEFAULT_CODEX_ACCENT);
    expect(capture()).toEqual(baseline);
  },
);
