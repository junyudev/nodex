import { waitFor } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/dom";
import { change, click, expandProfile, openSection } from "./agent-instance-settings.test-fixtures";
import {
  AntigravityAgentSettingsControl,
  antigravitySettingsUpdate,
  type AntigravityAgentSettingsRuntime,
  type AntigravityProfile,
} from "./antigravity-agent-settings-control";

const profile = (patch: Partial<AntigravityProfile> = {}): AntigravityProfile => ({
  id: "work",
  displayName: "Work",
  enabled: true,
  authMethod: "gemini-api-key",
  apiKey: null,
  hasApiKey: true,
  gcpProject: "",
  gcpLocation: "",
  binaryPath: "",
  ...patch,
});

const section = (runtime: AntigravityAgentSettingsRuntime) => (
  <AntigravityAgentSettingsControl
    open
    disclosure={openSection}
    runtime={runtime}
    shared={() => null}
    account={(saved) => <div>Account of {saved.displayName}</div>}
    executableStatus={() => null}
  />
);

it("keeps a saved key through other edits and replaces it only when one is typed", async () => {
  const update = vi.fn<AntigravityAgentSettingsRuntime["update"]>(async ({ instances }) => ({
    instances: instances.map((instance) => ({
      ...instance,
      hasApiKey: instance.apiKey === null ? instance.hasApiKey : instance.apiKey !== "",
      apiKey: null,
    })),
  }));
  const view = render(section({ read: async () => ({ instances: [profile()] }), update }));
  await expandProfile(view, "Work");
  expect(view.getByText("Account of Work")).toBeTruthy();
  const key = view.getByLabelText("Antigravity API key") as HTMLInputElement;
  expect(key.placeholder).toBe("Saved");
  // A key profile reads no Google Cloud project.
  expect(view.queryByLabelText("Antigravity Google Cloud project")).toBeNull();

  await change(view.getByLabelText("Antigravity profile name"), "Billing");
  await click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(update.mock.calls[0]?.[0].instances[0]).toMatchObject({
    displayName: "Billing",
    apiKey: null,
  });

  await change(view.getByLabelText("Antigravity API key"), "new-key");
  await click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(update.mock.calls[1]?.[0].instances[0]?.apiKey).toBe("new-key");
});

it("asks a new profile to be saved before it can sign in, and needs no executable", async () => {
  const update = vi.fn<AntigravityAgentSettingsRuntime["update"]>(async ({ instances }) => ({
    instances: [...instances],
  }));
  const view = render(section({ read: async () => ({ instances: [] }), update }));
  await click(await view.findByRole("button", { name: "Add profile" }));
  expect(view.getByText("Save this profile to sign in.")).toBeTruthy();
  expect(view.queryByLabelText("Antigravity API key")).toBeNull();
  await click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(update.mock.calls[0]?.[0].instances[0]).toMatchObject({
    displayName: "Antigravity",
    authMethod: "oauth-personal",
    binaryPath: "",
  });
  expect(await view.findByText("Account of Antigravity")).toBeTruthy();
});

it("drops a saved key when the sign-in method no longer reads one", () => {
  expect(
    antigravitySettingsUpdate([
      profile(),
      profile({ id: "personal", authMethod: "oauth-personal" }),
      profile({ id: "vertex", authMethod: "agent-platform", apiKey: "typed" }),
    ]).instances.map(({ id, apiKey }) => [id, apiKey]),
  ).toEqual([
    ["work", null],
    ["personal", ""],
    ["vertex", "typed"],
  ]);
});
