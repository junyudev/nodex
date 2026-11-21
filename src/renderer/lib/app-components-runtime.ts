import type {
  AppComponentId,
  AppComponentsState,
  SetAppComponentEnabledInput,
} from "../../shared/app-components";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";
import { resolveRendererTransport } from "./renderer-transport";

const setEnabledCommand = defineRendererCommand({
  key: "app_components.set_enabled",
  channel: "app-components:set-enabled",
  authority: "main",
  owner: "AppComponents",
  protocol: { kind: "returned_value" },
});

const requestCommand = defineRendererCommand({
  key: "app_components.request",
  channel: "app-components:request",
  authority: "main",
  owner: "AppComponents",
  protocol: { kind: "returned_value" },
});

const retryCommand = defineRendererCommand({
  key: "app_components.retry",
  channel: "app-components:retry",
  authority: "main",
  owner: "AppComponents",
  protocol: { kind: "returned_value" },
});

export interface AppComponentsRuntime {
  readonly read: () => Promise<AppComponentsState>;
  readonly setEnabled: (input: SetAppComponentEnabledInput) => Promise<AppComponentsState>;
  readonly request: (id: AppComponentId) => Promise<AppComponentsState>;
  readonly retry: (id: AppComponentId) => Promise<AppComponentsState>;
  readonly subscribe: (listener: (state: AppComponentsState) => void) => () => void;
}

export const appComponentsRuntime: AppComponentsRuntime = {
  read: () => invokeRendererQuery("app-components:read"),
  setEnabled: (input) => invokePlainCommand(setEnabledCommand, input),
  request: (id) => invokePlainCommand(requestCommand, id),
  retry: (id) => invokePlainCommand(retryCommand, id),
  subscribe: (listener) => resolveRendererTransport().subscribeAppComponentsChanges(listener),
};
