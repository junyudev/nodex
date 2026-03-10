import { describe, expect, test } from "bun:test";
import { shouldOpenProjectManagerForRequest } from "./left-sidebar-project-manager-open-request";

describe("shouldOpenProjectManagerForRequest", () => {
  test("does not replay a previously handled request after remount", () => {
    expect(shouldOpenProjectManagerForRequest(1, 1)).toBeFalse();
  });

  test("opens when a new request tick arrives", () => {
    expect(shouldOpenProjectManagerForRequest(2, 1)).toBeTrue();
  });

  test("ignores the initial zero tick", () => {
    expect(shouldOpenProjectManagerForRequest(0, 0)).toBeFalse();
  });
});
