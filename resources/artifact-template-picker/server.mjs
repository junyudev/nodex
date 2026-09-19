import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ARTIFACT_KINDS = new Map([
  ["document", { extension: "docx" }],
  ["presentation", { extension: "pptx" }],
  ["spreadsheet", { extension: "xlsx" }],
  ["google-docs", { family: "document", workspacePath: "document" }],
  ["google-slides", { family: "presentation", workspacePath: "presentation" }],
  ["google-sheets", { family: "spreadsheet", workspacePath: "spreadsheets" }],
]);
const LIMITS = {
  templates: 100,
  offered: 10,
  request: 1_000,
  previewBytes: 8 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  previewPixels: 16 * 1024 * 1024,
  totalPixels: 32 * 1024 * 1024,
};
const REQUIRED_STRING = { type: "string", minLength: 1 };
const WORK_MODE = process.argv.includes("--work");
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const WORK_SKILLS_ROOT = path.join(CODEX_HOME, "skills", "remote-skills");
const WORK_PLUGINS_ROOT = path.join(CODEX_HOME, "plugins", "cache");
const WORK_PREVIEW = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const DESCRIPTION_KINDS = new Map([
  ["document", "document"],
  ["presentation", "presentation"],
  ["spreadsheet", "spreadsheet"],
  ["google doc", "google-docs"],
  ["google slides presentation", "google-slides"],
  ["google sheet", "google-sheets"],
]);
const catalog = new Map(
  JSON.parse(process.env.CODEX_ARTIFACT_TEMPLATE_SKILLS ?? "[]").map((template) => [
    template.skillName,
    template,
  ]),
);
const workCatalog = new Map();
const pendingRequests = new Map();
let formExtension;
let legacyFormExtension;
let nextRequestId = 0;
let workCatalogListed = false;

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
    if (message.jsonrpc !== "2.0") {
      throw new InvalidParamsError("Invalid request");
    }
    if (typeof message.method !== "string") {
      const pending = pendingRequests.get(message.id);
      if (pending == null) {
        throw new InvalidParamsError("Invalid request");
      }
      pendingRequests.delete(message.id);
      message.error == null
        ? pending.resolve(message.result)
        : pending.reject(new Error("Template selection was unavailable"));
      return;
    }
    if (message.id != null) {
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: await handleRequest(message.method, message.params),
      });
    }
  } catch (error) {
    const expected = error instanceof InvalidParamsError;
    write({
      jsonrpc: "2.0",
      id: message?.id ?? null,
      error: {
        code: expected ? -32602 : -32603,
        message: expected ? error.message : "Internal server error",
      },
    });
  }
});

async function handleRequest(method, params) {
  if (method === "initialize") {
    formExtension = params?.capabilities?.extensions?.["openai/elicitation"]?.form;
    legacyFormExtension = params?.capabilities?.extensions?.["openai/form"];
    return {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "openai_artifact_template_picker", version: "1.0.0" },
    };
  }
  if (method === "ping") {
    return {};
  }
  if (method === "tools/list") {
    return {
      tools: [
        {
          name: "choose_artifact_template",
          description:
            "Show the ten most relevant enabled templates, or all available when fewer exist, in model-selected order. Include Office and Google templates and built-in, personal, shared, and team choices.",
          inputSchema: inputSchema(
            {
              templates: {
                type: "array",
                ...(WORK_MODE ? { minItems: 1 } : {}),
                maxItems: LIMITS.templates,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["skillName"],
                  properties: {
                    skillName: REQUIRED_STRING,
                    skillPath: REQUIRED_STRING,
                  },
                },
              },
              request: { ...REQUIRED_STRING, maxLength: LIMITS.request },
              includeAllTemplates: { type: "boolean" },
            },
            "templates",
          ),
        },
        {
          name: "list_artifact_templates",
          description:
            "List all compatible enabled templates without exposing paths. Rank the returned titles and descriptions by relevance before choosing.",
          inputSchema: inputSchema(
            {
              request: { ...REQUIRED_STRING, maxLength: LIMITS.request },
              ...(WORK_MODE
                ? {
                    pluginTemplates: {
                      type: "array",
                      maxItems: LIMITS.templates,
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: [
                          "skillName",
                          "resourceUri",
                          "pluginId",
                          "pluginReleaseSkillId",
                          "title",
                          "description",
                        ],
                        properties: {
                          skillName: REQUIRED_STRING,
                          resourceUri: REQUIRED_STRING,
                          pluginId: REQUIRED_STRING,
                          pluginReleaseSkillId: REQUIRED_STRING,
                          title: REQUIRED_STRING,
                          description: REQUIRED_STRING,
                        },
                      },
                    },
                  }
                : {}),
            },
            "request",
          ),
        },
      ],
    };
  }
  if (method === "tools/call") {
    if (params?.name === "choose_artifact_template") {
      return chooseArtifactTemplate(params.arguments);
    }
    if (params?.name === "list_artifact_templates") {
      return listArtifactTemplates(params.arguments);
    }
  }
  throw new InvalidParamsError("Unknown method or tool");
}

function inputSchema(properties, required) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      artifactKind: { type: "string", enum: Array.from(ARTIFACT_KINDS.keys()) },
      ...properties,
    },
    required: ["artifactKind", required],
  };
}

async function listArtifactTemplates(arguments_) {
  const { artifactKind, request, pluginTemplates } = arguments_ ?? {};
  if (
    !ARTIFACT_KINDS.has(artifactKind) ||
    typeof request !== "string" ||
    request.trim() === "" ||
    Array.from(request).length > LIMITS.request ||
    (WORK_MODE &&
      pluginTemplates != null &&
      (!Array.isArray(pluginTemplates) || pluginTemplates.length > LIMITS.templates))
  ) {
    throw new InvalidParamsError("Invalid template request");
  }

  if (WORK_MODE) {
    workCatalog.clear();
    for (const template of await discoverWorkTemplates()) {
      workCatalog.set(template.skillName, template);
    }
    for (const template of pluginTemplates ?? []) {
      const validated = validatePluginTemplate(template, artifactKind);
      if (validated == null) {
        continue;
      }
      workCatalog.set(validated.skillName, {
        ...workCatalog.get(validated.skillName),
        ...catalog.get(validated.skillName),
        ...validated,
        librarySkillId: validated.pluginReleaseSkillId,
      });
    }
  }

  const templates = [];
  const identities = new Set();
  for (const template of [...workCatalog.values(), ...catalog.values()]) {
    const validated =
      WORK_MODE && template.skillPath == null
        ? validatePluginTemplate(template, artifactKind)
        : await validateTemplate(template, artifactKind);
    if (validated == null) {
      continue;
    }
    const identity = `${validated.artifactKind}:${validated.skillName}`;
    if (identities.has(identity)) {
      continue;
    }
    identities.add(identity);
    templates.push({
      artifactKind: validated.artifactKind,
      skillName: validated.skillName,
      title: validated.title,
      description: template.description,
      ...(template.resourceUri == null ? {} : { resourceUri: template.resourceUri }),
    });
  }
  if (WORK_MODE) {
    workCatalogListed = true;
  }
  return toolResult({
    templates,
    selectionGuidance:
      "Rank these templates by relevance to the user's request, then pass the ten most relevant to choose_artifact_template, or all templates when fewer than ten are available.",
  });
}

async function discoverWorkTemplates() {
  const templates = [];
  let entries;
  try {
    entries = await fs.readdir(WORK_SKILLS_ROOT, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    entries = [];
  }

  for (const entry of entries) {
    const match = /^skill-([A-Za-z0-9_+-]+={0,2})$/u.exec(entry.name);
    if (!entry.isDirectory() || match == null || match[1].length > 255) {
      continue;
    }
    const template = await readWorkTemplate(
      path.join(WORK_SKILLS_ROOT, entry.name),
      null,
      match[1],
    );
    if (template != null) {
      templates.push(template);
    }
    if (templates.length === LIMITS.templates) {
      return templates;
    }
  }

  let marketplaces;
  try {
    marketplaces = await fs.readdir(WORK_PLUGINS_ROOT, {
      withFileTypes: true,
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return templates;
    }
    throw error;
  }

  for (const marketplace of marketplaces.slice(0, 32)) {
    if (!marketplace.isDirectory()) {
      continue;
    }
    let plugins;
    try {
      plugins = await fs.readdir(path.join(WORK_PLUGINS_ROOT, marketplace.name), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }

    for (const plugin of plugins.slice(0, LIMITS.templates)) {
      if (!plugin.isDirectory()) {
        continue;
      }
      const pluginRoot = path.join(WORK_PLUGINS_ROOT, marketplace.name, plugin.name);
      let version;
      let skillEntries;
      try {
        const versions = (await fs.readdir(pluginRoot, { withFileTypes: true })).filter((entry) =>
          entry.isDirectory(),
        );
        if (versions.length !== 1) {
          continue;
        }
        version = path.join(pluginRoot, versions[0].name);
        const manifest = JSON.parse(await readTrustedText(version, ".codex-plugin/plugin.json"));
        if (manifest.name !== plugin.name) {
          continue;
        }
        skillEntries = await fs.readdir(path.join(version, "skills"), {
          withFileTypes: true,
        });
      } catch {
        continue;
      }

      for (const entry of skillEntries) {
        if (!entry.isDirectory() || !/^artifact-template-[a-z0-9][a-z0-9._-]*$/u.test(entry.name)) {
          continue;
        }
        const template = await readWorkTemplate(
          path.join(version, "skills", entry.name),
          plugin.name,
        );
        if (template != null) {
          templates.push(template);
        }
        if (templates.length === LIMITS.templates) {
          return templates;
        }
      }
    }
  }

  return templates;
}

async function readWorkTemplate(directory, owner, librarySkillId) {
  let source;
  try {
    source = await readTrustedText(directory, "SKILL.md");
  } catch {
    return null;
  }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source)?.[1];
  const skillName = /^name:\s*["']?([^\s"']+)["']?\s*$/mu.exec(frontmatter ?? "")?.[1];
  if (
    !/^artifact-template-[a-z0-9][a-z0-9._-]*$/u.test(skillName ?? "") ||
    (owner != null && skillName !== path.basename(directory))
  ) {
    return null;
  }
  const description = /^description:\s*["']?(.+?)["']?\s*$/mu.exec(frontmatter ?? "")?.[1] ?? "";
  return {
    skillName: owner == null ? skillName : `${owner}:${skillName}`,
    skillPath: path.join(directory, "SKILL.md"),
    description,
    ...(librarySkillId == null ? {} : { librarySkillId }),
  };
}

function validatePluginTemplate(template, requestedKind) {
  const { skillName, resourceUri, pluginId, pluginReleaseSkillId, title, description } =
    template ?? {};
  if (
    typeof skillName !== "string" ||
    typeof resourceUri !== "string" ||
    typeof pluginId !== "string" ||
    typeof pluginReleaseSkillId !== "string" ||
    typeof title !== "string" ||
    typeof description !== "string" ||
    skillName.length > 512 ||
    resourceUri.length > 1_024 ||
    pluginId.length > 512 ||
    pluginReleaseSkillId.length > 512 ||
    title.length > 256 ||
    description.length > 4_096 ||
    !title.trim() ||
    !/^[A-Za-z0-9_-]+$/u.test(pluginId) ||
    !/^[A-Za-z0-9_-]+$/u.test(pluginReleaseSkillId)
  ) {
    return null;
  }
  const names = skillName.split(":");
  const unqualifiedSkillName = names[1];
  if (
    names.length !== 2 ||
    !names[0] ||
    /[\s/\\]/u.test(names[0]) ||
    !/^artifact-template-[a-z0-9][a-z0-9._-]*$/u.test(unqualifiedSkillName ?? "") ||
    resourceUri !== `skill://${pluginId}/${unqualifiedSkillName}`
  ) {
    return null;
  }
  const descriptionKind =
    /^Create a (document|presentation|spreadsheet|Google Doc|Google Slides presentation|Google Sheet) using the /iu
      .exec(description)?.[1]
      ?.toLowerCase();
  const artifactKind = DESCRIPTION_KINDS.get(descriptionKind);
  if (
    artifactKind == null ||
    (ARTIFACT_KINDS.get(artifactKind).family ?? artifactKind) !==
      (ARTIFACT_KINDS.get(requestedKind).family ?? requestedKind)
  ) {
    return null;
  }
  return {
    artifactKind,
    skillName,
    resourceUri,
    pluginId,
    pluginReleaseSkillId,
    title,
    description,
    unqualifiedSkillName,
    pixels: 0,
    preview: null,
  };
}

async function chooseArtifactTemplate(arguments_) {
  const { artifactKind, templates, request, includeAllTemplates } = arguments_ ?? {};
  if (
    !ARTIFACT_KINDS.has(artifactKind) ||
    !Array.isArray(templates) ||
    templates.length > LIMITS.templates ||
    (request != null &&
      (typeof request !== "string" ||
        !request.trim() ||
        Array.from(request).length > LIMITS.request)) ||
    (includeAllTemplates != null && typeof includeAllTemplates !== "boolean")
  ) {
    throw new InvalidParamsError("Invalid template selection");
  }
  if (WORK_MODE && templates.length === 0) {
    throw new InvalidParamsError(
      "Call list_artifact_templates and pass its returned templates before opening the picker",
    );
  }
  if (WORK_MODE && !workCatalogListed) {
    throw new InvalidParamsError(
      "Call list_artifact_templates with plugin templates from codex_apps before choosing a template",
    );
  }

  const candidates = new Map();
  for (const selected of templates) {
    if (typeof selected?.skillName !== "string" || candidates.has(selected.skillName)) {
      throw new InvalidParamsError("Invalid or duplicate template");
    }
    const configured = workCatalog.get(selected.skillName) ?? catalog.get(selected.skillName);
    if (configured == null && typeof selected.skillPath !== "string") {
      throw new InvalidParamsError("Selected template is not enabled");
    }
    candidates.set(selected.skillName, {
      ...(configured ?? selected),
      includeSkillPath: configured != null && selected.skillPath !== configured.skillPath,
    });
  }
  if (includeAllTemplates || WORK_MODE) {
    for (const [name, template] of [...workCatalog, ...catalog]) {
      if (!candidates.has(name)) {
        candidates.set(name, { ...template, includeSkillPath: true });
      }
    }
  }
  if (!formExtension && !legacyFormExtension) {
    return toolResult({ status: "unsupported" });
  }

  const offered = new Map();
  const identities = new Set();
  let totalBytes = 0;
  let totalPixels = 0;
  for (const candidate of candidates.values()) {
    const template =
      WORK_MODE && candidate.skillPath == null
        ? validatePluginTemplate(candidate, artifactKind)
        : await validateTemplate(candidate, artifactKind);
    if (!template) {
      continue;
    }
    const identity = `${template.artifactKind}:${template.skillName}`;
    if (identities.has(identity)) {
      continue;
    }
    if (!WORK_MODE) {
      totalBytes += template.preview?.length ?? 0;
      totalPixels += template.pixels;
      if (totalBytes > LIMITS.totalBytes || totalPixels > LIMITS.totalPixels) {
        throw new InvalidParamsError("Template previews exceed the allowed size");
      }
    }
    identities.add(identity);
    const templateId = WORK_MODE
      ? (candidate.librarySkillId ?? template.skillName)
      : template.skillName;
    const itemId = formExtension
      ? `artifact-template:${encodeURIComponent(templateId)}`
      : templateId;
    if (offered.has(itemId)) {
      throw new InvalidParamsError("Template identities must be unique");
    }
    offered.set(itemId, {
      item: {
        id: itemId,
        title: template.title,
        image: WORK_MODE
          ? WORK_PREVIEW
          : `data:image/png;base64,${template.preview.toString("base64")}`,
      },
      skillName: template.skillName,
      skillPath: candidate.includeSkillPath ? candidate.skillPath : undefined,
      ...(WORK_MODE && candidate.resourceUri != null ? { pluginTemplate: candidate } : {}),
    });
    if (offered.size === LIMITS.offered) {
      break;
    }
  }
  if (!offered.size && candidates.size) {
    return toolResult({ status: "unavailable" });
  }

  const family = ARTIFACT_KINDS.get(artifactKind).family ?? artifactKind;
  const extension = ARTIFACT_KINDS.get(family).extension;
  const title = `What style should this ${family} use?`;
  const result = await requestClient({
    message: title,
    requestedSchema: {
      type: "object",
      required: ["selection"],
      properties: {
        selection: {
          title,
          ...(formExtension
            ? {
                type: "string",
                format: "uri",
                "x-openai-input": {
                  type: "file",
                  options: Array.from(offered.values(), ({ item, skillName }) => ({
                    uri: item.id,
                    name: skillName,
                    title: item.title,
                    icons: [{ src: item.image }],
                  })),
                  userOptions: { accept: [`.${extension}`] },
                },
              }
            : {
                type: "openai/imagePicker",
                items: Array.from(offered.values(), ({ item }) => item),
                file: {
                  accept: [`.${extension}`],
                  title: "Upload a reference",
                },
              }),
        },
      },
    },
  });
  if (result.action === "decline" || result.action === "cancel") {
    return toolResult({
      status: result.action === "cancel" ? "cancelled" : "declined",
    });
  }
  if (result.action !== "accept" || typeof result.content?.selection !== "string") {
    throw new InvalidParamsError("Invalid form response");
  }
  const selection = result.content.selection;
  let selected = offered.get(selection);
  if (selected == null && WORK_MODE) {
    const matches = Array.from(candidates.values()).filter(
      (candidate) =>
        candidate.skillName === selection ||
        candidate.librarySkillId === selection ||
        candidate.pluginReleaseSkillId === selection,
    );
    if (matches.length === 1) {
      const candidate = matches[0];
      const template =
        candidate.skillPath == null
          ? validatePluginTemplate(candidate, artifactKind)
          : await validateTemplate(candidate, artifactKind);
      if (template != null) {
        selected = {
          skillName: template.skillName,
          skillPath: candidate.skillPath,
          pluginTemplate: candidate.resourceUri == null ? undefined : candidate,
        };
      }
    }
  }
  if (selected != null) {
    const selectedPath =
      selected.skillPath ??
      (selected.pluginTemplate == null
        ? undefined
        : await installedPluginSkillPath(selected.pluginTemplate, artifactKind));
    return toolResult({
      status: "selected",
      skillName: selected.skillName,
      ...(selectedPath ? { skillPath: selectedPath } : {}),
    });
  }
  let selectedPath;
  try {
    selectedPath = fileURLToPath(selection);
  } catch {
    throw new InvalidParamsError("Selected template is unavailable");
  }
  if (
    !path.isAbsolute(selectedPath) ||
    path.extname(selectedPath).slice(1).toLowerCase() !== extension
  ) {
    throw new InvalidParamsError("Selected template is unavailable");
  }

  const suggestedName = path
    .basename(selectedPath, path.extname(selectedPath))
    .replace(/[_-]+/gu, " ")
    .trim()
    .replace(/(?:^|\s)\p{L}/gu, (wordStart) => wordStart.toUpperCase())
    .slice(0, 64);
  const saveResult = await requestClient({
    message:
      "Save this reference as a reusable template? Continue to save it, or skip to use it only for this task.",
    requestedSchema: {
      type: "object",
      required: ["displayName"],
      properties: {
        displayName: {
          type: "string",
          title: "Template name",
          default: suggestedName,
          minLength: 1,
          maxLength: 64,
        },
      },
    },
  });
  if (saveResult.action === "cancel") {
    return toolResult({ status: "cancelled" });
  }
  if (saveResult.action === "decline") {
    return toolResult({
      status: "uploaded",
      path: selectedPath,
      saveForFutureUse: false,
    });
  }
  const displayName = saveResult.content?.displayName;
  if (
    saveResult.action !== "accept" ||
    typeof displayName !== "string" ||
    displayName !== displayName.trim() ||
    displayName.length > 64 ||
    /[<>\0\r\n]/u.test(displayName) ||
    !/[A-Za-z0-9]/u.test(displayName.normalize("NFKD"))
  ) {
    throw new InvalidParamsError("Invalid form response");
  }
  return toolResult({
    status: "uploaded",
    path: selectedPath,
    saveForFutureUse: true,
    displayName,
  });
}

async function installedPluginSkillPath(template, artifactKind) {
  let marketplaces;
  try {
    marketplaces = await fs.readdir(WORK_PLUGINS_ROOT, {
      withFileTypes: true,
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const [owner, name] = template.skillName.split(":");
  for (const marketplace of marketplaces.slice(0, 32)) {
    if (!marketplace.isDirectory()) {
      continue;
    }
    const directory = path.join(WORK_PLUGINS_ROOT, marketplace.name, owner);
    try {
      const marker = JSON.parse(
        await readTrustedText(directory, ".codex-remote-plugin-install.json"),
      );
      if (marker.remote_plugin_id !== template.pluginId) {
        continue;
      }
      const versions = (await fs.readdir(directory, { withFileTypes: true })).filter((entry) =>
        entry.isDirectory(),
      );
      if (versions.length !== 1) {
        continue;
      }
      const skillPath = path.join(directory, versions[0].name, "skills", name, "SKILL.md");
      if (await validateTemplate({ ...template, skillPath }, artifactKind)) {
        return skillPath;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

async function validateTemplate(template, requestedKind) {
  try {
    const names = template.skillName.split(":");
    const name = names.at(-1);
    const owner = names.length === 2 ? names[0] : null;
    if (
      names.length > 2 ||
      !/^artifact-template-[a-z0-9][a-z0-9._-]*$/u.test(name) ||
      !path.isAbsolute(template.skillPath) ||
      path.basename(template.skillPath) !== "SKILL.md"
    ) {
      return null;
    }
    const directory = path.dirname(await fs.realpath(template.skillPath));
    const personalSkill =
      WORK_MODE &&
      owner == null &&
      typeof template.librarySkillId === "string" &&
      path.basename(directory) === `skill-${template.librarySkillId}` &&
      path.dirname(directory) === (await fs.realpath(WORK_SKILLS_ROOT));
    if (
      !personalSkill &&
      (path.basename(directory) !== name || path.basename(path.dirname(directory)) !== "skills")
    ) {
      return null;
    }
    const pluginDirectory = path.dirname(path.dirname(directory));
    let plugin = null;
    try {
      plugin = JSON.parse(await readTrustedText(pluginDirectory, ".codex-plugin/plugin.json"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        return null;
      }
    }
    if ((plugin?.name ?? null) !== owner) {
      return null;
    }

    const [manifestText, metadata] = await Promise.all([
      readTrustedText(directory, "artifact-template.json"),
      readTrustedText(directory, "agents/openai.yaml"),
    ]);
    const manifest = JSON.parse(manifestText);
    const kind = ARTIFACT_KINDS.get(manifest.kind);
    const requestedFamily = ARTIFACT_KINDS.get(requestedKind).family ?? requestedKind;
    if (
      manifest.schemaVersion !== 1 ||
      !kind ||
      (kind.family ?? manifest.kind) !== requestedFamily ||
      manifest.reference !== `assets/reference.${kind.extension ?? "png"}` ||
      (kind.family && !hasCanonicalGoogleUrl(manifest.sourceUrl, kind.workspacePath))
    ) {
      return null;
    }

    const title = JSON.parse(/^ {2}display_name:\s*(.+?)\s*$/mu.exec(metadata)?.[1] ?? "null");
    const icon = JSON.parse(/^ {2}icon_large:\s*(.+?)\s*$/mu.exec(metadata)?.[1] ?? "null");
    if (
      typeof title !== "string" ||
      !title.trim() ||
      typeof icon !== "string" ||
      path.isAbsolute(icon)
    ) {
      return null;
    }
    const [reference, previewPath] = await Promise.all([
      fs.realpath(path.join(directory, manifest.reference)),
      fs.realpath(path.resolve(directory, icon)),
    ]);
    if (
      !isInside(directory, reference) ||
      !isInside(directory, previewPath) ||
      path.extname(previewPath).toLowerCase() !== ".png" ||
      (typeof manifest.preview === "string" &&
        path.resolve(directory, manifest.preview) !== previewPath)
    ) {
      return null;
    }

    const [referenceStats, previewStats] = await Promise.all([
      fs.stat(reference),
      fs.stat(previewPath),
    ]);
    if (
      !referenceStats.isFile() ||
      !previewStats.isFile() ||
      previewStats.size < 45 ||
      previewStats.size > LIMITS.previewBytes
    ) {
      return null;
    }
    const preview = WORK_MODE
      ? await fs.open(previewPath, "r").then(async (file) => {
          try {
            const header = Buffer.alloc(24);
            const { bytesRead } = await file.read(header, 0, header.length, 0);
            return bytesRead === header.length ? header : null;
          } finally {
            await file.close();
          }
        })
      : await fs.readFile(previewPath);
    if (
      preview == null ||
      (!WORK_MODE && preview.length !== previewStats.size) ||
      preview.toString("hex", 0, 8) !== "89504e470d0a1a0a" ||
      preview.toString("ascii", 12, 16) !== "IHDR"
    ) {
      return null;
    }
    const width = preview.readUInt32BE(16);
    const height = preview.readUInt32BE(20);
    const pixels = width * height;
    if (!pixels || Math.max(width, height) > 8_192 || pixels > LIMITS.previewPixels) {
      return null;
    }
    return {
      artifactKind: manifest.kind,
      pixels,
      preview,
      skillName: template.skillName,
      title,
      unqualifiedSkillName: name,
    };
  } catch {
    return null;
  }
}

function hasCanonicalGoogleUrl(value, workspacePath) {
  try {
    const url = new URL(value);
    const id = url.pathname.split("/")[3];
    const resourceKey = url.searchParams.get("resourcekey");
    return (
      id !== "e" &&
      /^[A-Za-z0-9_-]+$/u.test(id ?? "") &&
      value ===
        `https://docs.google.com/${workspacePath}/d/${id}/edit${resourceKey == null ? "" : `?resourcekey=${encodeURIComponent(resourceKey)}`}`
    );
  } catch {
    return false;
  }
}

async function readTrustedText(root, relativePath) {
  const realPath = await fs.realpath(path.join(root, relativePath));
  const stats = await fs.stat(realPath);
  if (!isInside(root, realPath) || !stats.isFile() || stats.size > 64 * 1024) {
    throw new Error("Invalid template metadata");
  }
  return fs.readFile(realPath, "utf8");
}

function isInside(directory, filePath) {
  const relative = path.relative(directory, filePath);
  return !!relative && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..";
}

function requestClient(params) {
  const id = ++nextRequestId;
  const result = new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
  });
  write({
    jsonrpc: "2.0",
    id,
    method: formExtension ? "openai/elicitation/create" : "openai/form",
    params: {
      ...params,
      ...(formExtension ? { mode: "form" } : {}),
      _meta: { autoResolutionMs: 30_000 },
    },
  });
  return result;
}

function toolResult(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

class InvalidParamsError extends Error {}
