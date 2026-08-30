import type * as Context from "effect/Context";
import { ElectronIpc } from "./ElectronIpc";

/** Test-only adapter for harnesses that intentionally observe every typed registration lane. */
export const makeTestElectronIpc = <
  Handle extends (...args: any[]) => any,
  On extends (...args: any[]) => any,
>({
  handle,
  on,
}: {
  readonly handle: Handle;
  readonly on: On;
}) =>
  ElectronIpc.of({
    handleQuery: handle as Context.Service.Shape<typeof ElectronIpc>["handleQuery"],
    handleControl: handle as Context.Service.Shape<typeof ElectronIpc>["handleControl"],
    handleLocalCommitCommand: handle as Context.Service.Shape<
      typeof ElectronIpc
    >["handleLocalCommitCommand"],
    handleRevisionedCommand: handle as Context.Service.Shape<
      typeof ElectronIpc
    >["handleRevisionedCommand"],
    handlePlainCommand: handle as Context.Service.Shape<typeof ElectronIpc>["handlePlainCommand"],
    on: on as Context.Service.Shape<typeof ElectronIpc>["on"],
  });
