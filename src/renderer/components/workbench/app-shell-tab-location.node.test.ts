import { describe, expect, test } from "vite-plus/test";
import { resolveAppShellTabLocationDetails } from "./app-shell-tab-location";

const details = (...tabs: Parameters<typeof resolveAppShellTabLocationDetails>[0]) =>
  Object.fromEntries(resolveAppShellTabLocationDetails(tabs));

describe("tab location details", () => {
  test("a title no other tab shares shows no location", () => {
    expect(
      details(
        { id: "a", title: "index.ts", location: ["src", "lib"] },
        { id: "b", title: "README.md", location: ["docs"] },
      ),
    ).toEqual({});
  });

  test("same-titled tabs show the fewest trailing parts that tell them apart", () => {
    expect(
      details(
        { id: "renderer", title: "index.ts", location: ["src", "renderer", "lib"] },
        { id: "main", title: "index.ts", location: ["src", "main", "lib"] },
        { id: "shared", title: "index.ts", location: ["src", "shared"] },
      ),
    ).toEqual({ renderer: "renderer/lib", main: "main/lib", shared: "shared" });
  });

  test("a location that is the tail of another shows all of itself", () => {
    expect(
      details(
        { id: "short", title: "index.ts", location: ["lib"] },
        { id: "long", title: "index.ts", location: ["main", "lib"] },
      ),
    ).toEqual({ short: "lib", long: "main/lib" });
  });

  test("tabs in the same place stay plain, while others with their title still name theirs", () => {
    expect(
      details(
        { id: "first", title: "Untitled", location: ["Library"] },
        { id: "second", title: "Untitled", location: ["Library"] },
      ),
    ).toEqual({});
    expect(
      details(
        { id: "first", title: "Untitled", location: ["Library"] },
        { id: "second", title: "Untitled", location: ["Library"] },
        { id: "beta", title: " Untitled ", location: ["Beta"] },
      ),
    ).toEqual({ first: "Library", second: "Library", beta: "Beta" });
  });

  test("tabs without a location neither show one nor force one on others", () => {
    expect(
      details(
        { id: "browser", title: "Docs" },
        { id: "page", title: "Docs", location: ["Library"] },
      ),
    ).toEqual({});
  });
});
