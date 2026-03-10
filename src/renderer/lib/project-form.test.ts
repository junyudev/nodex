import { describe, expect, test } from "bun:test";
import {
  isValidProjectId,
  resolveProjectIconValue,
  sanitizeProjectIdInput,
  validateProjectIdInput,
  validateProjectNameInput,
} from "./project-form";

describe("project form helpers", () => {
  test("sanitizeProjectIdInput normalizes to lowercase hyphen-safe ids", () => {
    expect(sanitizeProjectIdInput("Team Alpha_123")).toBe("teamalpha123");
    expect(sanitizeProjectIdInput("Feature-X!")).toBe("feature-x");
  });

  test("isValidProjectId accepts only lowercase alphanumeric + hyphen ids", () => {
    expect(isValidProjectId("project-1")).toBe(true);
    expect(isValidProjectId("1project")).toBe(true);
    expect(isValidProjectId("Project-1")).toBe(false);
    expect(isValidProjectId("project_1")).toBe(false);
  });

  test("project field validators return readable errors", () => {
    expect(validateProjectIdInput("")).toBe("Project ID is required.");
    expect(validateProjectIdInput("Project_1")).toBe(
      "Project ID must be lowercase alphanumeric with hyphens.",
    );
    expect(validateProjectIdInput("project-1")).toBe(undefined);

    expect(validateProjectNameInput("")).toBe("Project name is required.");
    expect(validateProjectNameInput("  Project Alpha  ")).toBe(undefined);
  });

  test("resolveProjectIconValue returns one emoji or undefined", () => {
    expect(resolveProjectIconValue("🚀 launch")).toBe("🚀");
    expect(resolveProjectIconValue("plain-text")).toBe(undefined);
  });
});
