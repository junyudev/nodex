import { createHandler } from "../src/relay.js";
import { getRelay } from "../src/runtime.js";

export default { fetch: createHandler("push", getRelay) };
