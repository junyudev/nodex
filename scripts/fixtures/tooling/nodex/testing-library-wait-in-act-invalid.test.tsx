import * as React from "react";
import * as testing from "@testing-library/react";
import { act, act as flush, render, screen, waitFor as untilReady, within } from "@testing-library/react";
import { renderWithAppMaitai as appRender } from "@/test/app-maitai";
import { renderWithMaitai as threadRender } from "../../../../src/renderer/test/thread-maitai";
import { render as scopedRender } from "@/test/dom";

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
  const view = render(<div />);
  const alias = view;
  await act(async () => {
    await alias.findByRole("dialog");
  });
  await act(async () => {
    await within(document.body).findByText("Ready");
  });
  const renderPanel = () => render(<div />);
  const panel = renderPanel();
  await act(async () => {
    await panel.findByRole("dialog");
  });
  function renderDialog() {
    return render(<div />);
  }
  const dialog = renderDialog();
  await act(async () => {
    await dialog.findByRole("dialog");
  });
  const { findByRole: locateAlias } = alias;
  await act(async () => {
    await locateAlias("dialog");
  });
  const namespacedScreen = testing.screen;
  await act(async () => {
    await namespacedScreen.findByText("Ready");
  });
  const renderScopedPanel = () => appRender(<div />);
  const scopedPanel = renderScopedPanel();
  await act(async () => {
    await scopedPanel.findByRole("dialog");
  });
  const thread = threadRender(<div />);
  await act(async () => {
    await thread.findByRole("dialog");
  });
  const scoped = scopedRender(<div />);
  await act(async () => {
    await scoped.findByText("Ready");
  });
}
