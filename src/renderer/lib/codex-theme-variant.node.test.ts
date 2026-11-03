import { describe, expect, test } from "vite-plus/test";
import {
  closestCodexAccentPreset,
  getCodexAccentStyle,
  getCodexThemeVariantStyle,
  normalizeCodexAccentColor,
  parseCodexAccent,
  renderCodexAppThemes,
  resolveEffectiveCodexAccent,
  type CodexAccentPreset,
} from "./codex-theme-variant";

describe("getCodexThemeVariantStyle", () => {
  test("defines the runtime semantic control and foreground tokens for light", () => {
    const styles = getCodexThemeVariantStyle("light");

    expect(styles["--app-color-background-control"]).toBe("rgba(255, 255, 255, 0.96)");
    expect(styles["--color-background-control-opaque"]).toBe("rgb(255, 255, 255)");
    expect(styles["--app-color-accent-blue"]).toBe("#3a83f7");
    expect(styles["--app-color-text-foreground"]).toBe("#0d0d0d");
    expect(styles["--app-color-background-surface"]).toBe("#ffffff");
    expect(styles["--app-color-background-surface-under"]).toBe("#f5f5f5");
    expect(styles["--app-color-border"]).toBe("rgba(13, 13, 13, 0.078)");
    expect(styles["--cursor-interaction"]).toBe("pointer");
    expect(styles["--app-color-background-elevated-tertiary-opaque"]).toBe("#f3f3f3");
  });

  test("defines the runtime semantic control and foreground tokens for dark", () => {
    const styles = getCodexThemeVariantStyle("dark");

    expect(styles["--app-color-background-control"]).toBe("rgba(38, 38, 38, 0.96)");
    expect(styles["--color-background-control-opaque"]).toBe("rgb(38, 38, 38)");
    expect(styles["--app-color-accent-blue"]).toBe("#3a83f7");
    expect(styles["--app-color-background-surface"]).toBe("#111111");
    expect(styles["--app-color-text-foreground"]).toBe("#fcfcfc");
    expect(styles["--app-color-text-foreground-secondary"]).toBe("rgba(252, 252, 252, 0.71)");
    expect(styles["--app-color-text-foreground-tertiary"]).toBe("rgba(252, 252, 252, 0.498)");
    expect(styles["--app-color-border"]).toBe("rgba(252, 252, 252, 0.084)");
    expect(styles["--app-color-background-button-primary"]).toBe("rgb(9, 9, 9)");
    expect(styles["--app-color-background-surface-under"]).toBe("#0e0e0e");
    expect(styles["--color-background-panel"]).toBe("#1c1c1c");
    expect(styles["--color-background-composer-action-bar"]).toBe("#212121");
    expect(styles["--app-color-background-editor-opaque"]).toBe("rgb(33, 33, 33)");
    expect(styles["--app-color-background-elevated-primary-opaque"]).toBe("rgb(47, 47, 47)");
    expect(styles["--cursor-interaction"]).toBe("pointer");
    expect(styles["--app-color-background-elevated-tertiary-opaque"]).toBe("rgb(33, 33, 33)");
  });

  test("resolves conversation accent roles independently from generic button roles", () => {
    const light = getCodexThemeVariantStyle("light");
    const dark = getCodexThemeVariantStyle("dark");

    expect(light["--color-background-composer-primary"]).toBe("#000000");
    expect(dark["--color-background-composer-primary"]).toBe("#ffffff");
    expect(light["--color-background-user-message"]).toBe("rgb(233 233 233 / 50%)");
    expect(dark["--color-background-user-message"]).toBe("rgb(50 50 50 / 85%)");
    expect(light["--color-background-text-selection"]).toBe("#539af859");
    expect(dark["--color-background-text-selection"]).toBe("#63a8f866");
    expect(light["--app-color-decoration-deleted"]).toBe("#e02e2a");
    expect(dark["--app-color-decoration-added"]).toBe("#00a240");
    expect(light["--app-color-accent-purple"]).toBe("#751ed9");
    expect(dark["--app-color-accent-purple"]).toBe("#b06dff");
  });
});

describe("accent preferences", () => {
  test("resolves selected Default to Blue and preserves explicit monochrome and custom colors", () => {
    expect(resolveEffectiveCodexAccent()).toEqual({ kind: "preset", name: "blue" });
    expect(resolveEffectiveCodexAccent({ kind: "preset", name: "default" })).toEqual({
      kind: "preset",
      name: "blue",
    });
    expect(resolveEffectiveCodexAccent({ kind: "preset", name: "black" })).toEqual({
      kind: "preset",
      name: "black",
    });
    expect(resolveEffectiveCodexAccent({ kind: "custom", color: "#ABC123" })).toEqual({
      kind: "custom",
      color: "#abc123",
    });
  });

  test("accepts explicit presets and normalized six-digit custom colors", () => {
    expect(parseCodexAccent({ kind: "preset", name: "black" })).toEqual({
      kind: "preset",
      name: "black",
    });
    expect(parseCodexAccent({ kind: "custom", color: "  #AbC123  " })).toEqual({
      kind: "custom",
      color: "#abc123",
    });
    expect(normalizeCodexAccentColor(" #00FF00 ")).toBe("#00ff00");
  });

  test.each([
    null,
    "blue",
    {},
    { kind: "preset", name: "red" },
    { kind: "custom", color: "#abc" },
    { kind: "custom", color: "#12345678" },
    { kind: "custom", color: "blue" },
  ])("defaults invalid persisted accent preferences: %j", (value) =>
    expect(parseCodexAccent(value)).toEqual({ kind: "preset", name: "default" }),
  );

  test("classifies custom hues for charts without replacing the exact selected color", () => {
    expect(closestCodexAccentPreset("#3a83f7")).toBe("blue");
    expect(closestCodexAccentPreset("#a67df2")).toBe("purple");
    expect(closestCodexAccentPreset("#787878")).toBe("black");
    expect(closestCodexAccentPreset("invalid")).toBeNull();
    const styles = getCodexThemeVariantStyle("light", { kind: "custom", color: "#0a72e5" });
    expect(styles["--codex-base-accent"]).toBe("#0a72e5");
    expect(styles["--color-chart-sequential-1"]).toBe("var(--blue-75)");
  });
});

const presetCases: Array<{
  name: CodexAccentPreset;
  accent: string;
  submit: [string, string];
  link: [string, string];
  message: [string, string];
  selection: [string, string];
}> = [
  {
    name: "default",
    accent: "#3a83f7",
    submit: ["#000000", "#ffffff"],
    link: ["#2c67c5", "#2c67c5"],
    message: ["rgb(233 233 233 / 50%)", "rgb(50 50 50 / 85%)"],
    selection: ["#539af859", "#63a8f866"],
  },
  {
    name: "blue",
    accent: "#3a83f7",
    submit: ["#3a83f7", "#2c67c5"],
    link: ["#2c67c5", "#2c67c5"],
    message: ["#e8f3fe", "#173e76"],
    selection: ["#539af859", "#3a83f799"],
  },
  {
    name: "green",
    accent: "#53b559",
    submit: ["#53b559", "#48a04c"],
    link: ["#48a04c", "#48a04c"],
    message: ["#def3e5", "#2c6732"],
    selection: ["#6bc67f59", "#53b55999"],
  },
  {
    name: "yellow",
    accent: "#f6c543",
    submit: ["#f6c543", "#d9a337"],
    link: ["#b8802b", "#f6c543"],
    message: ["#fdf6dc", "#95611f"],
    selection: ["#f8d45d59", "#f6c54380"],
  },
  {
    name: "pink",
    accent: "#f077af",
    submit: ["#f077af", "#f077af"],
    link: ["#cf6194", "#f077af"],
    message: ["#fdedf4", "#873e60"],
    selection: ["#f68ebc59", "#f077af99"],
  },
  {
    name: "orange",
    accent: "#ee7c37",
    submit: ["#ee7c37", "#d25e28"],
    link: ["#d25e28", "#ee7c37"],
    message: ["#fbe8db", "#87401d"],
    selection: ["#ef8b5759", "#ee7c3799"],
  },
  {
    name: "purple",
    accent: "#a67df2",
    submit: ["#8952ee", "#7849d1"],
    link: ["#7849d1", "#7849d1"],
    message: ["#ede5fc", "#4e2f88"],
    selection: ["#a67df259", "#8952ee99"],
  },
  {
    name: "black",
    accent: "#3a83f7",
    submit: ["#000000", "#ffffff"],
    link: ["#2c67c5", "#2c67c5"],
    message: ["#000000", "rgb(50 50 50 / 85%)"],
    selection: ["#afafaf66", "color-mix(in srgb, var(--color-text) 32%, transparent)"],
  },
];

describe("accent role projection", () => {
  test.each(["light", "dark"] as const)(
    "applies selected Default as Blue and keeps explicit Black/White distinct in %s",
    (variant) => {
      const blue = getCodexThemeVariantStyle(variant, resolveEffectiveCodexAccent());
      expect(blue["--color-background-composer-primary"]).toBe(
        variant === "light" ? "#3a83f7" : "#2c67c5",
      );
      expect(blue["--color-text-composer-primary"]).toBe("#ffffff");
      expect(blue["--color-background-user-message"]).toBe(
        variant === "light" ? "#e8f3fe" : "#173e76",
      );

      const black = getCodexThemeVariantStyle(variant, { kind: "preset", name: "black" });
      expect(black["--color-background-composer-primary"]).toBe(
        variant === "light" ? "#000000" : "#ffffff",
      );
      expect(black["--color-background-user-message"]).toBe(
        variant === "light" ? "#000000" : "rgb(50 50 50 / 85%)",
      );
    },
  );

  test.each(presetCases)(
    "projects $name conversation, focus, link, and selection roles in both appearances",
    ({ name, accent, submit, link, message, selection }) => {
      for (const [index, variant] of (["light", "dark"] as const).entries()) {
        const styles = getCodexAccentStyle(variant, { kind: "preset", name });
        expect(styles["--codex-base-accent"]).toBe(accent);
        expect(styles["--app-color-border-focus"]).toBe(accent);
        expect(styles["--color-background-composer-primary"]).toBe(submit[index]);
        expect(styles["--app-color-text-accent"]).toBe(link[index]);
        expect(styles["--color-background-user-message"]).toBe(message[index]);
        expect(styles["--color-background-text-selection"]).toBe(selection[index]);
      }
    },
  );

  test("can keep user messages neutral without discarding a named accent", () => {
    const styles = getCodexAccentStyle("dark", { kind: "preset", name: "green" }, false);
    expect(styles["--color-background-user-message"]).toBe("rgb(50 50 50 / 85%)");
    expect(styles["--color-text-user-message"]).toBe("#ffffff");
    expect(styles["--color-background-composer-primary"]).toBe("#48a04c");
    expect(styles["--app-color-text-accent"]).toBe("#48a04c");
  });

  test.each([
    ["#ffffff", "rgb(0, 0, 0)"],
    ["#000000", "rgb(255, 255, 255)"],
    ["#3a83f7", "rgb(0, 0, 0)"],
    ["#0169cc", "rgb(255, 255, 255)"],
    ["#008cff", "rgb(255, 255, 255)"],
    ["#3f77e1", "rgb(255, 255, 255)"],
    ["#757575", "rgb(255, 255, 255)"],
    ["#767676", "rgb(0, 0, 0)"],
    ["#00ff00", "rgb(0, 0, 0)"],
  ])("chooses readable ink for custom accent %s", (color, ink) => {
    const styles = getCodexAccentStyle("light", { kind: "custom", color });
    expect(styles["--app-color-text-on-accent"]).toBe(ink);
    expect(styles["--app-color-text-unread-badge"]).toBe(ink);
  });

  test("uses semantic neutral conversation roles for an exact custom accent", () => {
    const styles = getCodexAccentStyle("light", { kind: "custom", color: "#dc229a" });
    expect(styles["--app-color-border-focus"]).toBe("#dc229a");
    expect(styles["--app-color-text-accent"]).toBe("#dc229a");
    expect(styles["--color-background-composer-primary"]).toBe(
      "var(--color-background-primary-solid)",
    );
    expect(styles["--color-background-user-message"]).toBe(
      "color-mix(in oklab, var(--color-text) 5%, transparent)",
    );
    expect(styles["--color-background-text-selection"]).toBe("var(--color-background-info-soft)");
    expect(styles["--color-background-attribution-highlight"]).toBe(
      "var(--color-background-info-soft)",
    );
  });
});

test("serializes both supplied palettes for document roots and nested appearance scopes", () => {
  expect(
    renderCodexAppThemes({
      light: { "--surface": "#ffffff", "--accent": "#365b9d" },
      dark: { "--surface": "#111111", "--accent": "#df5142" },
    }),
  )
    .toBe(`@layer theme {:where(:root:not([data-codex-window-type="extension"]))[data-theme="light"], :where(:root:not([data-codex-window-type="extension"])) [data-theme="light"] {--surface:#ffffff;
--accent:#365b9d;}
:where(:root:not([data-codex-window-type="extension"]))[data-theme="dark"], :where(:root:not([data-codex-window-type="extension"])) [data-theme="dark"] {--surface:#111111;
--accent:#df5142;}}`);
});
