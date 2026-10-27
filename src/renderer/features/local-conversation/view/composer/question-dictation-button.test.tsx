import { act, fireEvent, render } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { QuestionDictationButton } from "./question-dictation-button";

const state = vi.hoisted(() => ({
  input: null as
    | Parameters<typeof import("./use-composer-dictation").useComposerDictation>[0]
    | null,
  start: vi.fn(async () => {}),
  stop: vi.fn(),
}));
vi.mock("./use-composer-dictation", () => ({
  useComposerDictation: (
    input: Parameters<typeof import("./use-composer-dictation").useComposerDictation>[0],
  ) => {
    state.input = input;
    return {
      isDictating: false,
      isStarting: false,
      isTranscribing: false,
      startDictation: state.start,
      stopDictation: state.stop,
    };
  },
}));

test("dictation preserves the existing answer, records interaction and never submits it", async () => {
  const change = vi.fn();
  const interaction = vi.fn();
  const view = render(
    <QuestionDictationButton
      id="question"
      value="Keep this draft"
      onChange={change}
      onInteraction={interaction}
    />,
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Dictate" }));
  });
  expect(state.start).toHaveBeenCalledOnce();
  await act(async () => {
    state.input?.transcript.start(undefined);
    state.input?.transcript.update("and add these words");
    await state.input?.onTranscriptInsert("and add these words");
  });
  expect(interaction).toHaveBeenCalledOnce();
  expect(change).toHaveBeenLastCalledWith("Keep this draft and add these words");
  expect(state.stop).not.toHaveBeenCalled();
});

test("secret answers cannot acquire dictation", async () => {
  state.start.mockClear();
  const view = render(
    <QuestionDictationButton id="secret" value="Private" onChange={() => {}} isSecret />,
  );
  const button = view.getByRole("button", { name: "Dictate" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(state.input?.enabled).toBe(false);
  await act(async () => {
    fireEvent.click(button);
  });
  expect(state.start).not.toHaveBeenCalled();
});
