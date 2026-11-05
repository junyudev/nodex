import type { MobileRuntime } from "./runtime";

// Native resolution binds the application singleton. Tests construct runtimes with a fake platform.
export function getRuntime(): MobileRuntime {
  throw new Error("The mobile runtime needs a native platform.");
}
