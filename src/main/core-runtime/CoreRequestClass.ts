import * as Context from "effect/Context";
import type { CoreRequestClass as RequestClass } from "../core-client/types";

export const CoreRequestClass = Context.Reference<RequestClass>(
  "nodex/main/core-runtime/CoreRequestClass",
  { defaultValue: () => "background" },
);
