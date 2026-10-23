import { describe, expect, it } from "vitest";
import {
  defaultComposerPredictionConfiguration,
  resolveComposerPredictionConfiguration,
} from "./CodexComposerPredictionDefaults";

describe("Composer prediction configuration", () => {
  it("enables unassigned hosts with the built-in configuration", () => {
    expect(resolveComposerPredictionConfiguration({}, true, "local")).toBe(
      defaultComposerPredictionConfiguration,
    );
    expect(resolveComposerPredictionConfiguration({}, true, "remote")).toBe(
      defaultComposerPredictionConfiguration,
    );
  });

  it("applies exact host overrides, including a disabled assignment", () => {
    const override = { ...defaultComposerPredictionConfiguration, is_enabled: false };
    const hosts = { local: override };
    expect(resolveComposerPredictionConfiguration(hosts, true, "local")).toBe(override);
    expect(resolveComposerPredictionConfiguration(hosts, true, "remote")).toBe(
      defaultComposerPredictionConfiguration,
    );
    expect(resolveComposerPredictionConfiguration(hosts, true, "toString")).toBe(
      defaultComposerPredictionConfiguration,
    );
  });

  it("the Profile switch disables defaults and explicit assignments on every host", () => {
    const hosts = { local: defaultComposerPredictionConfiguration };
    expect(resolveComposerPredictionConfiguration(hosts, false, "local")).toBeNull();
    expect(resolveComposerPredictionConfiguration(hosts, false, "remote")).toBeNull();
  });
});
