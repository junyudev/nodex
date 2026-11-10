import { describe, expect, it } from "vitest";

import { spaceKindLabel, spaceStatusLine } from "./space-presentation";

describe("spaceKindLabel", () => {
  it("leaves a personal Space to its name and avatar", () => {
    expect(spaceKindLabel({ name: "Personal", kind: "personal" })).toBeNull();
    expect(spaceKindLabel({ name: "Jun's Nodex", kind: "personal" })).toBeNull();
  });

  it("names a team Space's kind beside it", () => {
    expect(spaceKindLabel({ name: "Crew", kind: "team" })).toBe("Team");
    expect(spaceKindLabel({ name: "Steam Works", kind: "team" })).toBe("Team");
  });

  it("does not repeat what a team Space's name already says", () => {
    expect(spaceKindLabel({ name: "Team Space", kind: "team" })).toBeNull();
    expect(spaceKindLabel({ name: "Design team", kind: "team" })).toBeNull();
  });
});

describe("spaceStatusLine", () => {
  it("says how a personal Space's connection is doing", () => {
    expect(spaceStatusLine({ name: "Personal", kind: "personal" }, "connected")).toBe("Connected");
    expect(spaceStatusLine({ name: "Personal", kind: "personal" }, "offline")).toBe("Unavailable");
  });

  it("names a team Space's kind first, unless its name already does", () => {
    expect(spaceStatusLine({ name: "Crew", kind: "team" }, "connecting")).toBe("Team · Connecting");
    expect(spaceStatusLine({ name: "Design team", kind: "team" }, "revoked")).toBe(
      "Access revoked",
    );
  });
});
