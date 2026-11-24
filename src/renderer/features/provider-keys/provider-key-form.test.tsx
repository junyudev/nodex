import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import type { ProviderKeyConnectInput, ProviderKeyResult } from "../../../shared/provider-keys";
import { ProviderKeyForm } from "./provider-key-form";

const connected: ProviderKeyResult = {
  ok: true,
  connectionId: "c1",
  settings: { connections: [] },
};

const type = async (element: HTMLElement, value: string) =>
  act(async () => {
    fireEvent.change(element, { target: { value } });
    await Promise.resolve();
  });

const press = async (element: HTMLElement) =>
  act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });

describe("API key form", () => {
  test("connects the chosen provider on Codex and starts again for the next key", async () => {
    const connect = vi.fn(async (_input: ProviderKeyConnectInput) => connected);
    const onConnected = vi.fn();
    const view = render(<ProviderKeyForm keys={{ connect }} onConnected={onConnected} />);

    await press(view.getByRole("radio", { name: "MiniMax" }));
    await press(view.getByRole("radio", { name: "International" }));
    const key = view.getByLabelText("MiniMax API key");
    await type(key, "  mm-0123456789  ");
    await press(view.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith("c1"));
    expect(connect).toHaveBeenCalledWith({
      target: { preset: "minimax", endpoint: "international", agent: "codex" },
      apiKey: "mm-0123456789",
    });
    expect((view.getByLabelText("MiniMax API key") as HTMLInputElement).value).toBe("");
  });

  test("says why a key was refused and marks the key", async () => {
    const connect = vi.fn(async (): Promise<ProviderKeyResult> => ({
      ok: false,
      reason: "rejected",
      message: "DeepSeek didn't accept this key.",
    }));
    const view = render(<ProviderKeyForm keys={{ connect }} onConnected={vi.fn()} />);
    const key = view.getByLabelText("DeepSeek API key");
    await type(key, "sk-wrong-key-123");
    await press(view.getByRole("button", { name: "Connect" }));

    expect((await view.findByRole("alert")).textContent).toBe("DeepSeek didn't accept this key.");
    expect(key.getAttribute("aria-invalid")).toBe("true");
    await type(key, "sk-other-key-123");
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("asks for model IDs when a custom endpoint lists none", async () => {
    const connect = vi
      .fn<(input: ProviderKeyConnectInput) => Promise<ProviderKeyResult>>()
      .mockResolvedValueOnce({
        ok: false,
        reason: "no-models",
        message: "This endpoint doesn't list its models. Enter the model IDs to use.",
      })
      .mockResolvedValueOnce(connected);
    const view = render(<ProviderKeyForm keys={{ connect }} onConnected={vi.fn()} />);

    await press(view.getByRole("radio", { name: "Other" }));
    // An endpoint that serves the Anthropic Messages API runs on Claude Code.
    await press(view.getByRole("radio", { name: "Claude Code" }));
    await press(view.getByRole("button", { name: "Connect" }));
    expect((await view.findByRole("alert")).textContent).toBe("Enter the endpoint’s base URL.");
    expect(connect).not.toHaveBeenCalled();

    await type(view.getByLabelText("Base URL"), "https://gw.example.com/anthropic");
    await type(view.getByLabelText("API key"), "gw-key-0123");
    await press(view.getByRole("button", { name: "Connect" }));
    const models = await view.findByLabelText("Model IDs");
    await type(models, "qwen3-coder-plus");
    await press(view.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(connect).toHaveBeenLastCalledWith({
      target: {
        preset: "custom",
        baseUrl: "https://gw.example.com/anthropic",
        agent: "claudeAgent",
      },
      apiKey: "gw-key-0123",
      models: [{ id: "qwen3-coder-plus", name: "Qwen3 Coder Plus" }],
    });
  });
});
