import { expect, test } from "vite-plus/test";
import {
  advanceChangelog,
  extractUnreleasedNotes,
  validateNextVersionChangelog,
} from "./changelog";

test("release notes omit empty categories and retain multi-line entries", () => {
  const source =
    "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Released.\n  Detail.\n\n### Fixed\n";
  const notes = extractUnreleasedNotes(source);
  expect(notes).toBe("### Added\n- Released.\n  Detail.\n");
  expect(
    advanceChangelog(
      source.replace("  Detail.", "  Detail.\n- New."),
      notes,
      "1.0.0",
      "2026-11-11",
    ),
  ).toContain("### Added\n\n- New.\n\n### Changed\n\n### Fixed\n\n## [1.0.0] - 2026-11-11");
});

test("requires Unreleased and prohibits a dated heading for the source version", () => {
  expect(() =>
    validateNextVersionChangelog("## [Unreleased]\n\n## [1.0.0] - 2026-11-11", "1.0.0"),
  ).toThrow("already has a dated");
  expect(() => validateNextVersionChangelog("# Changelog", "1.0.0")).toThrow("Unreleased");
  expect(() => extractUnreleasedNotes("## [Unreleased]\n\n### Added")).toThrow("empty");
});
