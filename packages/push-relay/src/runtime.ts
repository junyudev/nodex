import { createRelay } from "./relay.js";

let relay: ReturnType<typeof createRelay> | undefined;

// Warm function invocations share the provider JWT, never registrations or notifications.
export const getRelay = (): ReturnType<typeof createRelay> => (relay ??= createRelay(process.env));
