import {
  responses,
  type ScriptedModelRequest,
  type ScriptedModelToolInvocation,
} from "../../../scripts/scenarios/runtime/scripted-model-server";

/** Code Mode can advertise its native execution tool directly or under functions. */
export const nativeCodeTool = (request: ScriptedModelRequest): ScriptedModelToolInvocation => {
  const nested = request.toolInvocation("functions", "exec");
  if (nested) return nested;
  if (request.namedTool("exec")?.type === "custom") return { name: "exec" };
  throw new Error(`Expected native code tool: ${request.diagnosticSummary()}`);
};

const applicationTools = `
const __nodexAppToolAddresses = Object.keys(tools);
const app = new Proxy({}, {
  get(_, operation) {
    const addresses = __nodexAppToolAddresses.filter(address => address.endsWith("__" + String(operation)));
    if (addresses.length !== 1 || typeof tools[addresses[0]] !== "function") {
      throw new Error("Expected one native application tool for " + String(operation) + "; addresses: " + JSON.stringify(addresses));
    }
    return tools[addresses[0]];
  }
});`;

/** Resolve operation addresses from code-mode metadata without loading resource bodies. */
export const nativeAppToolCall = (
  ...[callId, name, input, namespace]: Parameters<typeof responses.customToolCall>
) => {
  const lines = input.split("\n");
  const pragma = lines[0]?.startsWith("// @exec:") ? lines.shift() : undefined;
  const code = [...(pragma ? [pragma] : []), applicationTools, ...lines].join("\n");
  return responses.customToolCall(callId, name, code, namespace);
};
