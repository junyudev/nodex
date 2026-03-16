import { extractReleaseNotes, prepareReleaseArtifacts } from "./release-changelog";

const sampleChangelog = `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Added release automation.

### Fixed
- Fixed the release script edge case.

## [0.1.1] - 2026-03-12

### Added
- Previous release note.
`;

test("prepareReleaseArtifacts rolls Unreleased into a dated release entry", () => {
  const prepared = prepareReleaseArtifacts({
    changelogContent: sampleChangelog,
    version: "0.1.2",
    date: "2026-03-13",
  });

  expect(prepared.changelogContent.includes("## [Unreleased]\n\n### Added\n\n### Changed\n\n### Fixed")).toBeTrue();
  expect(prepared.changelogContent.includes("## [0.1.2] - 2026-03-13")).toBeTrue();
  expect(prepared.changelogContent.includes("- Added release automation.")).toBeTrue();
  expect(prepared.commitMessage).toBe(
    "release: v0.1.2\n\n### Added\n- Added release automation.\n\n### Fixed\n- Fixed the release script edge case.\n",
  );
  expect(prepared.releaseNotes).toBe(
    "### Added\n- Added release automation.\n\n### Fixed\n- Fixed the release script edge case.\n",
  );
});

test("prepareReleaseArtifacts rejects an empty Unreleased section", () => {
  let errorMessage = "";

  try {
    prepareReleaseArtifacts({
      changelogContent: `# Changelog

## [Unreleased]

### Added

### Changed

### Fixed
`,
      version: "0.1.2",
      date: "2026-03-13",
    });
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  expect(errorMessage.includes("Unreleased changelog section is empty")).toBeTrue();
});

test("prepareReleaseArtifacts omits empty subsections from the released version", () => {
  const prepared = prepareReleaseArtifacts({
    changelogContent: `# Changelog

## [Unreleased]

### Added

### Changed

### Fixed
- Fixed the release script edge case.
`,
    version: "0.1.2",
    date: "2026-03-13",
  });

  expect(prepared.changelogContent.includes("## [0.1.2] - 2026-03-13\n\n### Fixed\n- Fixed the release script edge case.")).toBeTrue();
  expect(prepared.changelogContent.includes("## [0.1.2] - 2026-03-13\n\n### Added")).toBeFalse();
  expect(prepared.changelogContent.includes("## [0.1.2] - 2026-03-13\n\n### Changed")).toBeFalse();
  expect(prepared.releaseNotes).toBe("### Fixed\n- Fixed the release script edge case.\n");
  expect(prepared.commitMessage).toBe("release: v0.1.2\n\n### Fixed\n- Fixed the release script edge case.\n");
});

test("prepareReleaseArtifacts rejects an already released version", () => {
  let errorMessage = "";

  try {
    prepareReleaseArtifacts({
      changelogContent: sampleChangelog,
      version: "0.1.1",
      date: "2026-03-13",
    });
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  expect(errorMessage).toBe("Release 0.1.1 already exists in CHANGELOG.md.");
});

test("extractReleaseNotes returns only the requested release body", () => {
  const releaseNotes = extractReleaseNotes({
    changelogContent: `# Changelog

## [Unreleased]

### Added
- Upcoming work.

## [0.1.2] - 2026-03-13

### Added
- Added release automation.

### Fixed
- Fixed the release script edge case.

## [0.1.1] - 2026-03-12

### Added
- Previous release note.
`,
    version: "0.1.2",
  });

  expect(releaseNotes).toBe(
    "### Added\n- Added release automation.\n\n### Fixed\n- Fixed the release script edge case.\n",
  );
});
