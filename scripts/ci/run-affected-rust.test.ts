import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import {
  selectAffectedRustPackageNames,
  selectRustTestBinaryPrerequisites,
  type CargoMetadata,
} from "./run-affected-rust.ts";

const root = path.resolve("/repo");
const metadata: CargoMetadata = {
  workspace_members: ["core-id", "server-id", "cli-id", "external-id"],
  packages: [
    {
      id: "core-id",
      name: "core",
      manifest_path: "/repo/crates/core/Cargo.toml",
      dependencies: [],
    },
    {
      id: "server-id",
      name: "server",
      manifest_path: "/repo/crates/server/Cargo.toml",
      dependencies: [{ name: "core" }],
    },
    {
      id: "cli-id",
      name: "cli",
      manifest_path: "/repo/crates/cli/Cargo.toml",
      dependencies: [{ name: "server" }],
    },
    {
      id: "external-id",
      name: "external",
      manifest_path: "/outside/external/Cargo.toml",
      dependencies: [],
    },
  ],
};

describe("affected Rust workspace selection", () => {
  test("includes transitive reverse dependents of the directly changed crate", () => {
    expect(selectAffectedRustPackageNames(metadata, root, ["crates/core/src/lib.rs"])).toEqual([
      "cli",
      "core",
      "server",
    ]);
  });

  test("keeps an isolated crate narrow", () => {
    expect(selectAffectedRustPackageNames(metadata, root, ["crates/cli/src/main.rs"])).toEqual([
      "cli",
    ]);
  });

  test("selects no packages when the changed paths have no Rust workspace owner", () => {
    expect(selectAffectedRustPackageNames(metadata, root, ["src/shared/core-types.ts"])).toEqual(
      [],
    );
  });

  test("fails closed to the workspace for root inputs and unknown crate paths", () => {
    expect(selectAffectedRustPackageNames(metadata, root, ["Cargo.lock"])).toEqual([
      "cli",
      "core",
      "external",
      "server",
    ]);
    expect(selectAffectedRustPackageNames(metadata, root, ["crates/removed/src/lib.rs"])).toEqual([
      "cli",
      "core",
      "external",
      "server",
    ]);
  });
});

describe("Rust test binary prerequisites", () => {
  test("builds Core for CLI integration tests when Core itself is not selected", () => {
    expect(selectRustTestBinaryPrerequisites(["nodex-cli"])).toEqual([
      { package: "nodex-core-server", bin: "nodex-core" },
    ]);
    expect(selectRustTestBinaryPrerequisites(["nodex-cli", "nodex-core-server"])).toEqual([]);
    expect(selectRustTestBinaryPrerequisites(["nodex-core"])).toEqual([]);
  });
});
