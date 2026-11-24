import { expect, test } from "vite-plus/test";
import {
  advanceChangelog,
  extractReleaseNotes,
  extractUnreleasedNotes,
  validateNextVersionChangelog,
} from "./changelog";

test("release notes lead with the headline, omit empty categories and keep multi-line entries", () => {
  const source =
    "# Changelog\n\n## [Unreleased]\n\nVerified releases\n\n### Added\n\n- Released.\n  Detail.\n\n### Fixed\n";

  expect(extractUnreleasedNotes(source)).toBe(
    "Verified releases\n\n### Added\n\n- Released.\n  Detail.\n",
  );
});

test("advancing keeps new entries, clears the draft headline and dates the released headline", () => {
  const source =
    "# Changelog\n\n## [Unreleased]\n\nA newer draft headline\n\n### Added\n\n- Released.\n  Detail.\n- New.\n\n### Fixed\n";
  const notes = "Verified releases\n\n### Added\n\n- Released.\n  Detail.\n";

  const advanced = advanceChangelog(source, notes, "1.0.0", "2026-11-11");
  expect(advanced).toBe(
    `# Changelog\n\n## [Unreleased]\n\n### Added\n\n- New.\n\n### Changed\n\n### Fixed\n\n## [1.0.0] - 2026-11-11\n\n${notes}`,
  );
  expect(extractReleaseNotes(advanced, "1.0.0")).toBe(notes);
});

test("requires Unreleased and prohibits a dated heading for the source version", () => {
  expect(() =>
    validateNextVersionChangelog("## [Unreleased]\n\n## [1.0.0] - 2026-11-11", "1.0.0"),
  ).toThrow("already has a dated");
  expect(() => validateNextVersionChangelog("# Changelog", "1.0.0")).toThrow("Unreleased");
});

test("source validation permits accumulating entries before authoring the Unreleased headline", () => {
  const source = "## [Unreleased]\n\n### Added\n\n- Added a feature.\n";
  expect(() => validateNextVersionChangelog(source, "1.0.0")).not.toThrow();
  expect(() => extractUnreleasedNotes(source)).toThrow("Unreleased needs a headline");
  const invalidDraft = source.replace("### Added", "Release notes.\n\n### Added");
  expect(() => validateNextVersionChangelog(invalidDraft, "1.0.0")).toThrow(
    "Unreleased needs a headline",
  );
  expect(() => extractUnreleasedNotes(invalidDraft)).toThrow("Unreleased needs a headline");
  expect(() => extractUnreleasedNotes("## [Unreleased]\n\n### Added")).toThrow("empty");
});

test("dated sections require valid headlines in source validation and note extraction", () => {
  const source = "## [Unreleased]\n\n## [1.0.0] - 2026-11-11\n\n### Added\n\n- Added a feature.\n";
  expect(() => validateNextVersionChangelog(source, "1.0.1")).toThrow(
    "Release 1.0.0 needs a headline",
  );
  expect(() => extractReleaseNotes(source, "1.0.0")).toThrow("Release 1.0.0 needs a headline");
});
