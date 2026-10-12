import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vite-plus/test";

const bootstrap = readFileSync(resolve("src/renderer/public/theme-bootstrap.js"), "utf8");

describe("parser-time theme selection", () => {
  test.each([
    { preference: "light", systemDark: true, resolved: "light" },
    { preference: "dark", systemDark: false, resolved: "dark" },
    { preference: "system", systemDark: true, resolved: "dark" },
    { preference: null, systemDark: false, resolved: "light" },
  ])(
    "selects the CSS scheme before renderer initialization: $preference / $systemDark",
    ({ preference, systemDark, resolved }) => {
      const root = document.createElement("html");
      runInNewContext(bootstrap, {
        document: { documentElement: root },
        localStorage: { getItem: () => preference },
        navigator: { platform: "MacIntel" },
        URL,
        URLSearchParams,
        window: {
          location: { href: "http://localhost/", search: "" },
          matchMedia: () => ({ matches: systemDark }),
        },
      });

      expect(root.dataset.theme).toBe(resolved);
      expect(root.classList.contains("dark")).toBe(resolved === "dark");
      expect(root.classList.contains(`electron-${resolved}`)).toBe(true);
    },
  );
});
