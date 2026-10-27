import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { vi } from "vite-plus/test";
import * as React from "react";

const click = async (element: HTMLElement) =>
  act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });

export async function waitsAfterReactFlushes() {
  const button = await screen.findByRole("button");
  await click(button);
  // Function arguments settle before the helper enters its own act callback.
  await click(await screen.findByRole("button"));
  await waitFor(() => screen.getByRole("dialog"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button"));
    await Promise.resolve();
  });
}

export async function localActIsUnrelated(act: (run: () => Promise<void>) => Promise<void>) {
  await act(async () => {
    await screen.findByRole("dialog");
  });
}

export async function callbackRunsLater() {
  let observe = async () => {};
  await act(async () => {
    observe = async () => {
      await screen.findByRole("dialog");
    };
  });
  await observe();
}

export async function nonDomWaitsStayLegal() {
  const connection = { waitFor: async () => {} };
  const directory = { findByRole: async (_role: string) => [] };
  await act(async () => {
    await vi.waitFor(() => true);
    await connection.waitFor();
    await directory.findByRole("admin");
  });
}

export async function computedMemberIsNotTheActExport() {
  const act = "other";
  await React[act](async () => {
    await screen.findByRole("dialog");
  });
}

export async function businessQueriesAndUnknownReceiversStayLegal(
  unknownDirectory: { findByRole: (role: string) => Promise<unknown> },
) {
  const directory = { findByRole: async (_role: string) => [] };
  const alias = directory;
  const { findByRole: findAccount } = directory;
  const renderWithAppMaitai = () => directory;
  const created = renderWithAppMaitai();
  await act(async () => {
    await alias.findByRole("admin");
    await findAccount("admin");
    await created.findByRole("admin");
    await unknownDirectory.findByRole("admin");
  });
}

export async function recursiveWrappersDoNotSupplyKnownQueryResults() {
  function makeDirectory() {
    return makeDirectory();
  }
  const directory = makeDirectory();
  await act(async () => {
    await directory.findByRole("admin");
  });
}
