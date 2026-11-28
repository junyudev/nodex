import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { predictionResult } from "./composer-prediction.test-fixtures";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./composer-prompt-editor";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function editor({ value = "", prediction = predictionResult(), disabled = false } = {}) {
  const ref = createRef<ComposerPromptEditorHandle>();
  const change = vi.fn();
  const submit = vi.fn<(text: string) => void>();
  const interaction = vi.fn();
  const props = {
    value,
    prediction,
    disabled,
    placeholder: "Ask",
    onChange: change,
    onKeyDown: () => {
      submit(ref.current!.getPersistedText());
      return true;
    },
    onPredictionInteraction: interaction,
  };
  const view = render(<ComposerPromptEditor ref={ref} {...props} />);
  const input = view.container.querySelector<HTMLElement>("[data-codex-composer='true']");
  if (!input) throw new Error("Composer editor did not mount");
  return { view, input, ref, change, submit, interaction, props };
}

async function key(input: HTMLElement, key: string, extra: KeyboardEventInit = {}) {
  await act(async () => {
    fireEvent.keyDown(input, { key, ...extra });
    await Promise.resolve();
  });
}

describe("composer prediction document consumption", () => {
  it.each(["Tab", "ArrowRight", "Enter"])(
    "accepts %s into an editable draft and submits only on a separate Enter",
    async (acceptKey) => {
      const { input, ref, change, submit, interaction } = editor();
      const suggestion = "Inspect the tests next";
      expect(ref.current?.getPersistedText()).toBe("");
      const ghost = input.querySelector("[data-composer-prediction]");
      expect(ghost?.textContent).toBe(suggestion);
      expect(ghost?.getAttribute("aria-hidden")).toBe("true");
      await key(input, acceptKey);
      expect(ref.current?.getPersistedText()).toBe(suggestion);
      expect(change).toHaveBeenCalledWith(suggestion);
      expect(submit).not.toHaveBeenCalled();
      expect(input.querySelector("[data-composer-prediction]")).toBeNull();
      expect(interaction).toHaveBeenCalledWith(
        expect.objectContaining({ action: "accepted", acceptedText: suggestion }),
      );
      await act(async () => {
        ref.current?.insertText(", including empty input.");
        await Promise.resolve();
      });
      expect(ref.current?.getPersistedText()).toBe(`${suggestion}, including empty input.`);
      expect(submit).not.toHaveBeenCalled();
      await key(input, "Enter");
      expect(submit).toHaveBeenCalledExactlyOnceWith(`${suggestion}, including empty input.`);
    },
  );

  it("keeps nonempty drafts, modified keys and active mention suggestions outside acceptance", async () => {
    const full = editor({ value: "My draft" });
    expect(full.input.querySelector("[data-composer-prediction]")).toBeNull();
    await key(full.input, "Tab");
    expect(full.ref.current?.getText()).toBe("My draft");
    full.view.unmount();
    const empty = editor();
    await key(empty.input, "Enter", { shiftKey: true });
    expect(empty.ref.current?.getText()).toBe("");
    await act(async () => {
      empty.ref.current?.toggleContextSuggestions();
      await Promise.resolve();
    });
    expect(empty.ref.current?.getSuggestionState().active).toBe(true);
    expect(empty.input.querySelector("[data-composer-prediction]")).toBeNull();
    await key(empty.input, "Tab");
    expect(empty.ref.current?.getText()).toBe("");
    expect(
      empty.interaction.mock.calls.filter(([event]) => event.action === "accepted"),
    ).toHaveLength(0);
  });

  it("hides predictions during IME composition, then restores them without accepting its confirmation key", async () => {
    const { input, ref, interaction } = editor();
    await act(async () => {
      fireEvent.compositionStart(input);
      await Promise.resolve();
    });
    expect(input.querySelector("[data-composer-prediction]")).toBeNull();
    await key(input, "Enter", { isComposing: true, keyCode: 229 });
    expect(ref.current?.getText()).toBe("");
    expect(interaction.mock.calls.filter(([event]) => event.action === "accepted")).toHaveLength(0);
    await act(async () => {
      fireEvent.compositionEnd(input);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(input.querySelector("[data-composer-prediction]")).not.toBeNull();
  });

  it("parses prediction mentions through the ordinary prompt schema and syncs their metadata", async () => {
    const { input, ref, interaction } = editor({
      prediction: predictionResult("source-turn", "Use [$pdf](/skills/pdf/SKILL.md)"),
    });
    await act(async () => {
      ref.current?.syncMentionMetadata({
        apps: [],
        plugins: [],
        skills: [
          {
            name: "pdf",
            displayName: "PDF tools",
            description: "",
            iconUrl: null,
            brandColor: null,
            path: "/skills/pdf/SKILL.md",
          },
        ],
      });
      await Promise.resolve();
    });
    expect(ref.current?.getText()).toBe("");
    const ghostMention = input.querySelector(
      "[data-composer-prediction] [data-composer-mention='true']",
    );
    expect(ghostMention?.getAttribute("data-mention-display-name")).toBe("PDF tools");
    await key(input, "Tab");
    expect(ref.current?.getText()).toBe("Use [$pdf](/skills/pdf/SKILL.md)");
    expect(input.querySelector("[data-composer-mention='true']")).not.toBeNull();
    expect(interaction.mock.calls.filter(([event]) => event.action === "accepted")).toHaveLength(1);
  });

  it("updates same-text metadata without replacing the ghost widget and respects disabled editors", () => {
    const { input, view, ref, props, interaction } = editor();
    const ghost = input.querySelector("[data-composer-prediction]");
    view.rerender(
      <ComposerPromptEditor
        ref={ref}
        {...props}
        prediction={{ ...props.prediction, requestedAt: "2026-10-12T00:01:00Z" }}
      />,
    );
    expect(input.querySelector("[data-composer-prediction]")).toBe(ghost);
    expect(interaction.mock.calls.filter(([event]) => event.action === "shown")).toHaveLength(1);
    view.rerender(<ComposerPromptEditor ref={ref} {...props} disabled />);
    expect(input.querySelector("[data-composer-prediction]")).toBeNull();
    expect(ref.current?.getText()).toBe("");
  });
});
