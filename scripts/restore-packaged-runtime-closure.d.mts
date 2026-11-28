import type { AfterPackContext } from "electron-builder";

export default function restorePackagedRuntimeClosure(context: AfterPackContext): Promise<void>;
