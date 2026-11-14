import { createInterface } from "node:readline";

const uri = "ui://field-notes/view.html";
const tool = {
  name: "open_notes",
  title: "Field Notes",
  inputSchema: { type: "object" },
  _meta: {
    ui: { resourceUri: uri, visibility: ["app"] },
    "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }, { type: "file", extensions: [".fieldnote"] }] },
  },
};

const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Field Notes</title><style>
:root { color-scheme: light dark; background: Canvas; color: CanvasText; font: 16px system-ui; }
body { padding: 24px; }
h1 { margin: 0 0 12px; font-size: 24px; }
pre { margin: 0; white-space: pre-wrap; }
</style><body><h1>Field Notes</h1><pre id="notes">Ready</pre>
<script type="module">
const pending = new Map();
let nextId = 0;
let resourceUri;
const post = (message) => parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
const request = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  post({ id, method, params });
});
const renderFile = async () => {
  const result = await request("resources/read", {
    uri: resourceUri,
    _meta: { "openai/resource": { representation: "text" } }
  });
  document.querySelector("#notes").textContent = result.contents[0].text;
};
window.addEventListener("message", async ({ source, data }) => {
  if (source !== parent || data?.jsonrpc !== "2.0") return;
  const waiter = pending.get(data.id);
  if (waiter && !data.method) {
    pending.delete(data.id);
    if (data.error) waiter.reject(new Error(data.error.message));
    else waiter.resolve(data.result);
  }
  if (data.method === "ui/resource-teardown") post({ id: data.id, result: {} });
  if (data.method === "ui/notifications/tool-input" && data.params.arguments?.file) {
    resourceUri = data.params.arguments.file.resourceUri;
    try {
      await request("resources/subscribe", { uri: resourceUri });
      await renderFile();
    } catch (error) {
      document.querySelector("#notes").textContent = error.message;
    }
  }
  if (data.method === "notifications/resources/updated" && data.params.uri === resourceUri) {
    await renderFile();
  }
});
await request("ui/initialize", {
  appInfo: { name: "Field Notes", version: "1.0.0" },
  appCapabilities: {}, protocolVersion: "2026-01-26",
});
post({ method: "ui/notifications/initialized" });
</script></body></html>`;

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  let result;
  if (method === "initialize") {
    result = {
      protocolVersion: params.protocolVersion,
      serverInfo: { name: "Field Notes", version: "1.0.0" },
      capabilities: { tools: {}, resources: {} },
    };
  } else if (method === "tools/list") {
    result = { tools: [tool] };
  } else if (method === "resources/read" && params.uri === uri) {
    result = { contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: html }] };
  } else if (method === "tools/call" && params.name === tool.name) {
    result = { content: [], structuredContent: { received: params.arguments } };
  }
  const reply = result ? { result } : { error: { code: -32601, message: "Unsupported fixture request" } };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...reply }) + "\n");
}
