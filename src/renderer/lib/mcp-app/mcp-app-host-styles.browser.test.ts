import { afterEach, expect, test } from "vite-plus/test";
import { applyCodexThemeVariant } from "../codex-theme-variant";
import { readMcpAppHostStyleVariables } from "./mcp-app-host-styles";

import "@/globals.css";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-codex-window-type");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.classList.remove("dark", "electron-dark", "electron-light");
});

test.each(["light", "dark"] as const)(
  "exports portable host values and updates accent roles without changing %s appearance",
  (variant) => {
    const root = document.documentElement;
    root.dataset.codexWindowType = "electron";
    root.classList.toggle("dark", variant === "dark");
    root.classList.toggle("electron-dark", variant === "dark");
    root.classList.toggle("electron-light", variant === "light");
    applyCodexThemeVariant(root, variant, document.body, { kind: "preset", name: "green" });
    const green = readMcpAppHostStyleVariables();

    expect(Object.keys(green).length).toBeGreaterThan(60);
    for (const value of Object.values(green)) expect(value).not.toContain("var(");
    expect(green["--font-text-sm-size"]).toBe("14px");
    expect(green["--font-weight-normal"]).toBe("400");
    expect(Number.parseFloat(green["--border-radius-md"] ?? "")).toBeGreaterThan(0);

    applyCodexThemeVariant(root, variant, document.body, { kind: "preset", name: "pink" });
    const pink = readMcpAppHostStyleVariables();
    expect(pink["--color-text-info"]).not.toBe(green["--color-text-info"]);
    expect(pink["--color-ring-info"]).not.toBe(green["--color-ring-info"]);
    expect(pink["--color-background-info"]).not.toBe(green["--color-background-info"]);
    expect(pink["--color-text-success"]).toBe(green["--color-text-success"]);
    expect(pink["--color-text-danger"]).toBe(green["--color-text-danger"]);

    applyCodexThemeVariant(root, variant, document.body, { kind: "preset", name: "green" });

    const guest = document.createElement("div");
    const shadow = guest.attachShadow({ mode: "open" });
    const view = document.createElement("div");
    view.style.color = "var(--color-text-info)";
    view.style.background = "var(--color-background-info)";
    view.style.border = "1px solid var(--color-border-info)";
    for (const [key, value] of Object.entries(pink)) view.style.setProperty(key, value);
    shadow.append(view);
    document.body.append(guest);

    expect(getComputedStyle(view).color).toBe(pink["--color-text-info"]);
    expect(getComputedStyle(view).backgroundColor).toBe(pink["--color-background-info"]);
    expect(getComputedStyle(view).borderTopColor).toBe(pink["--color-border-info"]);
    expect(shadow.children).toHaveLength(1);
    guest.remove();
  },
);
