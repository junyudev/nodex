import * as React from "react";
import * as testing from "@testing-library/react";
import { act, act as flush, render, screen, waitFor as untilReady, within } from "@testing-library/react";

export async function waitsBeforeReactCanFlush() {
  await act(async () => {
    await screen.findByRole("dialog");
  });
  await flush(async () => {
    await untilReady(() => screen.getByRole("dialog"));
  });
  await React.act(async () => {
    await testing.waitForElementToBeRemoved(() => screen.queryByRole("dialog"));
  });
  await testing.act(() => screen.findAllByText("Ready"));
  await act(async () => {
    await testing.findByText(document.body, "Ready");
  });
  const { findByRole: locate } = render(<div />);
  await act(async () => {
    await locate("dialog");
  });
  const { findByText } = within(document.body);
  await act(async () => {
    await findByText("Ready");
  });
  const { findByRole: locateNested } = testing.render(<div />);
  await act(async () => {
    await locateNested("dialog");
  });
}
