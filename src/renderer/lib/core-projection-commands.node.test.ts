import { describe, expect, it } from "vitest";
import type {
  DatabaseApplyOperationV2,
  DatabaseApplyV2,
  LibraryDatabaseApplyV2,
} from "../../shared/database-module-v2";
import type { LibraryModuleApplyRequest } from "../../shared/library-module";
import type { PageLifecycleMutationRequestV2 } from "../../shared/page-lifecycle-v2";
import {
  databaseSettingsApplyCommand,
  libraryCommandFor,
  libraryDatabaseCommandFor,
  pageLifecycleCommandFor,
  projectDatabaseCommandFor,
} from "./core-projection-commands";

const databaseRequest = (
  operations: readonly Pick<DatabaseApplyOperationV2, "kind">[],
): DatabaseApplyV2 => ({ operations }) as DatabaseApplyV2;

const libraryDatabaseRequest = (
  operations: readonly Pick<DatabaseApplyOperationV2, "kind">[],
): LibraryDatabaseApplyV2 => ({ operations }) as LibraryDatabaseApplyV2;

describe("aggregate Core projection command routing", () => {
  it("keeps Database Settings pending until its causally newer descriptor is returned", () => {
    expect(databaseSettingsApplyCommand).toMatchObject({
      key: "database.settings.apply",
      owner: "DatabaseSettingsRuntime",
      protocol: { kind: "pending_operation" },
    });
  });

  it("routes each operation family to a semantic definition", () => {
    expect(projectDatabaseCommandFor(databaseRequest([{ kind: "put_view" }])).key).toBe(
      "database.put_view",
    );
    expect(
      libraryCommandFor({ operation: { kind: "create_page" } } as LibraryModuleApplyRequest).key,
    ).toBe("library.create_page");
    expect(
      pageLifecycleCommandFor({
        operation: { kind: "archive_page" },
      } as PageLifecycleMutationRequestV2).key,
    ).toBe("page_lifecycle.archive_page");
  });

  it("routes Page relocation and Undo through Library-owned semantic definitions", () => {
    expect(
      libraryCommandFor({ operation: { kind: "move_page" } } as LibraryModuleApplyRequest),
    ).toMatchObject({
      key: "library.move_page",
      owner: "LibraryOperationRuntime",
      protocol: { kind: "pending_operation" },
    });
    expect(
      libraryCommandFor({
        operation: { kind: "undo_page_relocation" },
      } as LibraryModuleApplyRequest).key,
    ).toBe("library.undo_page_relocation");
  });

  it("rejects an empty or unowned mixed Database batch", () => {
    expect(() => projectDatabaseCommandFor(databaseRequest([]))).toThrow(
      "Database apply requires at least one operation",
    );
    expect(() =>
      projectDatabaseCommandFor(databaseRequest([{ kind: "put_view" }, { kind: "delete_view" }])),
    ).toThrow("mixed operation kinds requires an owning semantic command");
  });

  it("allows a homogeneous atomic Database batch", () => {
    expect(
      projectDatabaseCommandFor(databaseRequest([{ kind: "put_option" }, { kind: "put_option" }]))
        .key,
    ).toBe("database.put_option");
  });

  it("routes atomic View publication through its owning semantic command", () => {
    const operations = [{ kind: "put_view" }, { kind: "put_view_personal_preferences" }] as const;

    expect(projectDatabaseCommandFor(databaseRequest(operations)).key).toBe(
      "database.publish_view",
    );
    expect(libraryDatabaseCommandFor(libraryDatabaseRequest(operations)).key).toBe(
      "library_database.publish_view",
    );
  });

  it("routes atomic cross-group Page movement through its owning semantic command", () => {
    const operations = [{ kind: "edit_property_values" }, { kind: "position_pages" }] as const;

    expect(projectDatabaseCommandFor(databaseRequest(operations)).key).toBe("database.move_pages");
    expect(libraryDatabaseCommandFor(libraryDatabaseRequest([...operations].reverse())).key).toBe(
      "library_database.move_pages",
    );
  });

  it("covers the other mixed operation sets emitted by renderer compilers", () => {
    expect(
      projectDatabaseCommandFor(
        databaseRequest([{ kind: "edit_property_values" }, { kind: "position_page" }]),
      ).key,
    ).toBe("database.move_page");
    expect(
      libraryDatabaseCommandFor(
        libraryDatabaseRequest([{ kind: "put_option" }, { kind: "edit_property_values" }]),
      ).key,
    ).toBe("library_database.create_option_and_select");
  });
});
