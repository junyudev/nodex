import { describe, expect, test } from "bun:test";
import {
  shouldRejectProjectedOwnerStructureChange,
  shouldRejectToggleListStructureChange,
  type StructureGuardChange,
} from "./projection-structure-guard";

const projectedProps = {
  projectionOwnerId: "owner-1",
  projectionCardId: "card-1",
  projectionSourceProjectId: "default",
};

describe("shouldRejectProjectedOwnerStructureChange", () => {
  test("rejects direct projected row deletion when owner remains", () => {
    const changes: StructureGuardChange[] = [
      {
        type: "delete",
        block: {
          id: "projected-row-1",
          type: "cardToggle",
          props: projectedProps,
        },
      },
    ];

    expect(shouldRejectProjectedOwnerStructureChange(changes)).toBeTrue();
  });

  test("allows projected row deletion when owner is deleted in same transaction", () => {
    const changes: StructureGuardChange[] = [
      {
        type: "delete",
        block: {
          id: "owner-1",
          type: "cardRef",
        },
      },
      {
        type: "delete",
        block: {
          id: "projected-row-1",
          type: "cardToggle",
          props: projectedProps,
        },
      },
    ];

    expect(shouldRejectProjectedOwnerStructureChange(changes)).toBeFalse();
  });

  test("keeps rejecting projected insertions", () => {
    const changes: StructureGuardChange[] = [
      {
        type: "insert",
        block: {
          id: "projected-row-1",
          type: "cardToggle",
          props: projectedProps,
        },
      },
    ];

    expect(shouldRejectProjectedOwnerStructureChange(changes)).toBeTrue();
  });
});

describe("shouldRejectToggleListStructureChange", () => {
  test("rejects structural deletion of source card toggle rows", () => {
    const changes: StructureGuardChange[] = [
      {
        type: "delete",
        block: {
          id: "source-row-1",
          type: "cardToggle",
          props: {
            cardId: "source-card-1",
          },
        },
      },
    ];

    expect(shouldRejectToggleListStructureChange(changes)).toBeTrue();
  });

  test("allows structural deletion of projected rows", () => {
    const changes: StructureGuardChange[] = [
      {
        type: "delete",
        block: {
          id: "projected-row-1",
          type: "cardToggle",
          props: projectedProps,
        },
      },
    ];

    expect(shouldRejectToggleListStructureChange(changes)).toBeFalse();
  });

  test("rejects source card-toggle type-change updates", () => {
    const changes: StructureGuardChange[] = [
      {
        type: "update",
        block: {
          id: "source-row-1",
          type: "paragraph",
        },
        prevBlock: {
          id: "source-row-1",
          type: "cardToggle",
          props: {
            cardId: "source-card-1",
          },
        },
      },
    ];

    expect(shouldRejectToggleListStructureChange(changes)).toBeTrue();
  });
});
