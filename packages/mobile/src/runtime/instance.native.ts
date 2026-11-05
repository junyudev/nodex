import { mobilePlatform } from "./expo-platform";
import { createMobileRuntime } from "./runtime";

let runtime: ReturnType<typeof createMobileRuntime> | undefined;
export const getRuntime = () => (runtime ??= createMobileRuntime(mobilePlatform));
