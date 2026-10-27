import { describe, expect, test } from "vite-plus/test";
import {
  applyCodexThemeVariant,
  closestCodexAccentPreset,
  getCodexAccentStyle,
  getCodexThemeVariantStyle,
  normalizeCodexAccentColor,
  parseCodexAccent,
  resolveEffectiveCodexAccent,
  type CodexAccent,
  type CodexAccentPreset,
} from "./codex-theme-variant";

function makeStyleTarget() {
  const declarations: Record<string, string> = {};
  const target = {
    dataset: {},
    style: {
      setProperty(name: string, value: string) {
        declarations[name] = value;
      },
    },
  } as HTMLElement;

  return { declarations, target };
}

describe("getCodexThemeVariantStyle", () => {
  test("defines the runtime semantic control and foreground tokens for light", () => {
    const styles = getCodexThemeVariantStyle("light");

    expect(styles["--app-color-background-control"]).toBe("rgba(255, 255, 255, 0.96)");
    expect(styles["--color-background-control-opaque"]).toBe("rgb(255, 255, 255)");
    expect(styles["--app-color-accent-blue"]).toBe("#3a83f7");
    expect(styles["--app-color-text-foreground"]).toBe("#1a1c1f");
    expect(styles["--app-color-background-surface"]).toBe("#ffffff");
    expect(styles["--app-color-border"]).toBe("rgba(26, 28, 31, 0.078)");
    expect(styles["--cursor-interaction"]).toBe("pointer");
    expect(styles["--app-color-background-elevated-tertiary-opaque"]).toBe("#f4f4f4");
  });

  test("defines the runtime semantic control and foreground tokens for dark", () => {
    const styles = getCodexThemeVariantStyle("dark");

    expect(styles["--app-color-background-control"]).toBe("rgba(45, 45, 45, 0.96)");
    expect(styles["--color-background-control-opaque"]).toBe("rgb(45, 45, 45)");
    expect(styles["--app-color-accent-blue"]).toBe("#3a83f7");
    expect(styles["--app-color-background-surface"]).toBe("#181818");
    expect(styles["--app-color-text-foreground"]).toBe("#ffffff");
    expect(styles["--app-color-text-foreground-secondary"]).toBe("rgba(255, 255, 255, 0.71)");
    expect(styles["--app-color-text-foreground-tertiary"]).toBe("rgba(255, 255, 255, 0.498)");
    expect(styles["--app-color-border"]).toBe("rgba(255, 255, 255, 0.084)");
    expect(styles["--app-color-background-button-primary"]).toBe("rgb(13, 13, 13)");
    expect(styles["--app-color-background-surface-under"]).toBe("#141414");
    expect(styles["--color-background-panel"]).toBe("#232323");
    expect(styles["--color-background-composer-action-bar"]).toBe("#282828");
    expect(styles["--app-color-background-editor-opaque"]).toBe("rgb(40, 40, 40)");
    expect(styles["--app-color-background-elevated-primary-opaque"]).toBe("rgb(54, 54, 54)");
    expect(styles["--cursor-interaction"]).toBe("pointer");
    expect(styles["--app-color-background-elevated-tertiary-opaque"]).toBe("rgb(40, 40, 40)");
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

  test("updates the active palette and scheme while preserving document interaction tokens", () => {
    const root = makeStyleTarget();
    const body = makeStyleTarget();

    applyCodexThemeVariant(root.target, "light", body.target);

    expect(root.target.dataset.theme).toBe("light");
    expect(root.declarations["--cursor-interaction"]).toBe("pointer");
    expect(body.declarations["--cursor-interaction"]).toBe("pointer");

    applyCodexThemeVariant(root.target, "dark", body.target);
    expect(root.target.dataset.theme).toBe("dark");
    expect(root.declarations).toEqual(
      getCodexThemeVariantStyle("dark", { kind: "preset", name: "blue" }),
    );
    applyCodexThemeVariant(root.target, "light", body.target);
    expect(root.target.dataset.theme).toBe("light");
    expect(root.declarations).toEqual(
      getCodexThemeVariantStyle("light", { kind: "preset", name: "blue" }),
    );
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
    selection: ["#afafaf66", "#78787866"],
  },
];

describe("accent role projection", () => {
  test.each(["light", "dark"] as const)(
    "applies selected Default as Blue and keeps explicit Black/White distinct in %s",
    (variant) => {
      const root = makeStyleTarget();
      applyCodexThemeVariant(root.target, variant);
      expect(root.declarations["--color-background-composer-primary"]).toBe(
        variant === "light" ? "#3a83f7" : "#2c67c5",
      );
      expect(root.declarations["--color-text-composer-primary"]).toBe("#ffffff");
      expect(root.declarations["--color-background-user-message"]).toBe(
        variant === "light" ? "#e8f3fe" : "#173e76",
      );
      const blue = { ...root.declarations };

      applyCodexThemeVariant(root.target, variant, undefined, { kind: "preset", name: "black" });
      expect(root.declarations["--color-background-composer-primary"]).toBe(
        variant === "light" ? "#000000" : "#ffffff",
      );
      expect(root.declarations["--color-background-user-message"]).toBe(
        variant === "light" ? "#000000" : "rgb(50 50 50 / 85%)",
      );
      applyCodexThemeVariant(root.target, variant);
      expect(root.declarations).toEqual(blue);
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

  test("clears named color projections when changing to custom and back to default", () => {
    const root = makeStyleTarget();
    const accents: CodexAccent[] = [
      { kind: "preset", name: "purple" },
      { kind: "custom", color: "#159c6f" },
      { kind: "preset", name: "default" },
    ];
    for (const accent of accents) {
      applyCodexThemeVariant(root.target, "dark", undefined, accent);
      expect(root.declarations).toEqual(
        getCodexThemeVariantStyle("dark", resolveEffectiveCodexAccent(accent)),
      );
    }
    expect(root.declarations["--color-background-composer-primary"]).toBe("#2c67c5");
    expect(root.declarations["--color-background-user-message"]).toBe("#173e76");
    expect(root.declarations["--color-chart-sequential-1"]).toBe("var(--blue-800)");
    expect(root.declarations["--app-color-text-accent"]).toBe("#2c67c5");
  });
});
