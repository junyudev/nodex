const { app } = require("electron");
const { mkdirSync } = require("node:fs");
const { isAbsolute, join } = require("node:path");

const scenarioHome = process.env.NODEX_INTERNAL_SCENARIO_HOME;
delete process.env.NODEX_INTERNAL_SCENARIO_HOME;
if (process.type !== "browser" || !scenarioHome || !isAbsolute(scenarioHome)) {
  throw new Error("An absolute isolated Electron scenario home is required");
}

const documents = join(scenarioHome, "Documents");
mkdirSync(documents, { recursive: true });
app.setPath("home", scenarioHome);
app.setPath("documents", documents);
process.env.HOME = scenarioHome;
