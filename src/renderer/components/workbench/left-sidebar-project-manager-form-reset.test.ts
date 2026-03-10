import { describe, expect, test } from "bun:test";
import { FormApi } from "@tanstack/form-core";
import { EMPTY_PROJECT_MANAGER_FORM_VALUES } from "./left-sidebar-project-manager-form-values";
import { resolveProjectManagerFormValues } from "./left-sidebar-project-manager-form-values";

describe("project manager form reset semantics", () => {
  test("reset with keepDefaultValues survives a later useForm options update", () => {
    const form = new FormApi({
      defaultValues: EMPTY_PROJECT_MANAGER_FORM_VALUES,
    });
    const projectValues = resolveProjectManagerFormValues({
      id: "alpha",
      name: "Alpha",
      icon: "🚀",
      workspacePath: "/tmp/alpha",
    });

    form.reset(projectValues, { keepDefaultValues: true });
    form.update({
      defaultValues: EMPTY_PROJECT_MANAGER_FORM_VALUES,
    });

    expect(form.state.values.id).toBe("alpha");
    expect(form.state.values.name).toBe("Alpha");
    expect(form.state.values.icon).toBe("🚀");
    expect(form.state.values.workspacePath).toBe("/tmp/alpha");
  });

  test("plain reset is overwritten by a later options update back to empty defaults", () => {
    const form = new FormApi({
      defaultValues: EMPTY_PROJECT_MANAGER_FORM_VALUES,
    });
    const projectValues = resolveProjectManagerFormValues({
      id: "alpha",
      name: "Alpha",
      icon: "🚀",
      workspacePath: "/tmp/alpha",
    });

    form.reset(projectValues);
    form.update({
      defaultValues: EMPTY_PROJECT_MANAGER_FORM_VALUES,
    });

    expect(form.state.values.id).toBe("");
    expect(form.state.values.name).toBe("");
    expect(form.state.values.icon).toBe("");
    expect(form.state.values.workspacePath).toBe("");
  });
});
