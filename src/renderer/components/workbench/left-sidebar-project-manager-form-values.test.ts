import { describe, expect, test } from "bun:test";
import { resolveProjectManagerFormValues } from "./left-sidebar-project-manager-form-values";

describe("resolveProjectManagerFormValues", () => {
  test("maps a project into editable form values", () => {
    const values = resolveProjectManagerFormValues({
      id: "alpha",
      name: "Alpha",
      icon: "🚀",
      workspacePath: "/tmp/alpha",
    });

    expect(values.id).toBe("alpha");
    expect(values.name).toBe("Alpha");
    expect(values.icon).toBe("🚀");
    expect(values.workspacePath).toBe("/tmp/alpha");
  });

  test("falls back to empty strings for a new draft", () => {
    const values = resolveProjectManagerFormValues();

    expect(values.id).toBe("");
    expect(values.name).toBe("");
    expect(values.icon).toBe("");
    expect(values.workspacePath).toBe("");
  });
});
