import { describe, expect, it } from "vitest";
import { parseAddMarketplaceForm } from "./marketplace-form";

describe("parseAddMarketplaceForm", () => {
  it("requires a source and trims every field", () => {
    expect(parseAddMarketplaceForm({ source: "  ", refName: "main", sparsePaths: "" })).toBeNull();
    expect(
      parseAddMarketplaceForm({ source: " openai/plugins ", refName: "  ", sparsePaths: " " }),
    ).toEqual({ source: "openai/plugins", refName: null, sparsePaths: null });
  });

  it("splits sparse paths on newlines and commas", () => {
    expect(
      parseAddMarketplaceForm({
        source: "git@github.com:org/repo.git",
        refName: " v2 ",
        sparsePaths: "plugins/codex,\n plugins/shared ,,\n",
      }),
    ).toEqual({
      source: "git@github.com:org/repo.git",
      refName: "v2",
      sparsePaths: ["plugins/codex", "plugins/shared"],
    });
  });
});
