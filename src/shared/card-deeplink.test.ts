import { describe, expect, test } from "bun:test";
import {
  buildCardDeepLink,
  parseCardDeepLink,
} from "./card-deeplink";

describe("card deeplink", () => {
  test("builds nodex card deeplinks", () => {
    expect(buildCardDeepLink({ cardId: "card-42" })).toBe("nodex://cards/card-42");
  });

  test("parses nodex card deeplinks", () => {
    const target = parseCardDeepLink("nodex://cards/card-42");

    expect(target?.cardId).toBe("card-42");
  });

  test("parses alternate empty-host card deeplinks", () => {
    const target = parseCardDeepLink("nodex:///cards/card-42");

    expect(target?.cardId).toBe("card-42");
  });

  test("returns null for legacy singular deeplinks", () => {
    expect(parseCardDeepLink("nodex://card/card-42")).toBe(null);
  });

  test("returns null for unsupported deeplinks", () => {
    expect(parseCardDeepLink("nodex://thread/thread-1")).toBe(null);
  });
});
