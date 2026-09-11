import { describe, expect, test } from "vite-plus/test";
import { applyCodexThemeVariant, getCodexThemeVariantStyle } from "./codex-theme-variant";

function makeStyleTarget() {
  const declarations: Record<string, string> = {};
  const target = {
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

    expect(styles["--color-background-control"]).toBe("rgba(255, 255, 255, 0.96)");
    expect(styles["--color-background-control-opaque"]).toBe("rgb(255, 255, 255)");
    expect(styles["--color-accent-blue"]).toBe("#3a83f7");
    expect(styles["--color-icon-error"]).toBe("#e02e2a");
    expect(styles["--color-text-error"]).toBe("#e02e2a");
    expect(styles["--color-text-warning"]).toBe("#e25507");
    expect(styles["--color-text-foreground"]).toBe("#0d0d0d");
    expect(styles["--color-background-surface"]).toBe("#ffffff");
    expect(styles["--color-border"]).toBe("rgba(13, 13, 13, 0.078)");
    expect(styles["--cursor-interaction"]).toBe("pointer");
  });

  test("defines the runtime semantic control and foreground tokens for dark", () => {
    const styles = getCodexThemeVariantStyle("dark");

    expect(styles["--color-background-control"]).toBe("rgba(38, 38, 38, 0.96)");
    expect(styles["--color-background-control-opaque"]).toBe("rgb(38, 38, 38)");
    expect(styles["--color-accent-blue"]).toBe("#3a83f7");
    expect(styles["--color-icon-error"]).toBe("#ff6764");
    expect(styles["--color-text-error"]).toBe("#ff6764");
    expect(styles["--color-text-warning"]).toBe("#fb6a22");
    expect(styles["--color-background-surface"]).toBe("#111111");
    expect(styles["--color-text-foreground"]).toBe("#fcfcfc");
    expect(styles["--color-text-foreground-secondary"]).toBe("rgba(252, 252, 252, 0.71)");
    expect(styles["--color-text-foreground-tertiary"]).toBe("rgba(252, 252, 252, 0.498)");
    expect(styles["--color-border"]).toBe("rgba(252, 252, 252, 0.084)");
    expect(styles["--color-background-button-primary"]).toBe("rgb(9, 9, 9)");
    expect(styles["--color-background-surface-under"]).toBe("#0e0e0e");
    expect(styles["--color-background-panel"]).toBe("#1c1c1c");
    expect(styles["--color-background-editor-opaque"]).toBe("rgb(33, 33, 33)");
    expect(styles["--color-background-elevated-primary-opaque"]).toBe("rgb(47, 47, 47)");
    expect(styles["--cursor-interaction"]).toBe("pointer");
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
    expect(light["--color-decoration-deleted"]).toBe("#e02e2a");
    expect(dark["--color-decoration-added"]).toBe("#00a240");
    expect(light["--color-accent-purple"]).toBe("#751ed9");
    expect(dark["--color-accent-purple"]).toBe("#b06dff");
  });

  test("applies document-scoped runtime interaction tokens to root and body", () => {
    const root = makeStyleTarget();
    const body = makeStyleTarget();

    applyCodexThemeVariant(root.target, "light", body.target);

    expect(root.declarations["--cursor-interaction"]).toBe("pointer");
    expect(body.declarations["--cursor-interaction"]).toBe("pointer");

    applyCodexThemeVariant(root.target, "dark", body.target);
    expect(root.declarations).toEqual(getCodexThemeVariantStyle("dark"));
    applyCodexThemeVariant(root.target, "light", body.target);
    expect(root.declarations).toEqual(getCodexThemeVariantStyle("light"));
  });
});
