import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioManifest,
  type ScenarioRecoveryDraftSeed,
} from "../contracts";
import {
  insertParagraphAfter,
  insertUncapturedPage,
  removeBlock,
  replaceInBlock,
  typeAndDelete,
} from "../seed/recovery-draft";

export const DOCUMENT_RECOVERY_REVIEW_SCENARIO_ID = "document-recovery-review";

const parseFacts: ScenarioDomainRecipe["parseFacts"] = (value) => {
  const facts = parseScenarioFacts(value);
  if (facts.scenarioId !== DOCUMENT_RECOVERY_REVIEW_SCENARIO_ID || facts.scenarioRevision !== 1)
    throw new Error("Invalid document recovery review scenario facts");
  return facts;
};

const PAGES = {
  plan: {
    title: "手机 App 发布计划",
    markdown: [
      "## 目标",
      "让用户在手机上也能往 Inbox 里塞东西、启动一个 chat，并查看 chat 的实时状态。",
      "## 发布范围",
      "- iOS 和 Android 同时发布",
      "- 首发只支持 Inbox 和 Chat",
      "- 通知放到下一个版本",
      "## 时间线",
      "十一月第二周完成内测，十一月底提交 App Store 审核。",
      "## 风险",
      "审核可能需要一周以上，需要预留缓冲时间。",
      "## 负责人",
      "产品和设计由产品组负责，客户端由移动组负责。",
      "## 附录",
      "内测名单和反馈渠道放在单独的 Page 里。",
    ].join("\n\n"),
  },
  notes: {
    title: "设计评审记录",
    markdown: [
      "## 结论",
      "对话框不再用两个全文标签来回切换，改成一份差异视图。",
      "## 待办",
      "把实现细节的用词全部换成产品语言。",
    ].join("\n\n"),
  },
  retro: {
    title: "周报",
    markdown: ["本周完成了快照恢复的回归测试。", "下周开始灰度发布。"].join("\n\n"),
  },
} as const;

const HOUR = 3_600_000;

/** One draft per outcome: Core can merge it, Core refuses it, and it adds nothing readable. */
const DRAFTS = {
  plan: {
    ageMs: 2 * HOUR,
    edit: (document) => {
      replaceInBlock(document, "十一月第二周", "十一月底", "十二月初");
      insertParagraphAfter(document, "审核可能需要", "还要提前准备隐私问卷和审核用的演示账号。");
      removeBlock(document, "通知放到");
    },
  },
  notes: {
    ageMs: 5 * HOUR,
    edit: (document) => {
      insertParagraphAfter(document, "把实现细节", "空状态也要重新设计，不能只留一句话。");
      insertUncapturedPage(document, "把实现细节");
    },
  },
  retro: {
    ageMs: 26 * HOUR,
    edit: (document) => {
      typeAndDelete(document, "本周完成");
    },
  },
} as const satisfies Record<
  keyof typeof PAGES,
  { readonly ageMs: number; readonly edit: ScenarioRecoveryDraftSeed["edit"] }
>;

/** Real Pages and real drafts, so `--seed` opens directly on something to review. */
export const documentRecoveryReviewScenario: ScenarioDomainRecipe = {
  id: DOCUMENT_RECOVERY_REVIEW_SCENARIO_ID,
  revision: 1,
  parseFacts,
  async materialize(port, workspace): Promise<ScenarioManifest> {
    const project = await port.createProject({ name: "Recovery Review", sources: [workspace] });
    if (!project.defaultDatabaseViewId)
      throw new Error("Document recovery review requires a Database View");
    const pageIdsByKey: Record<string, string> = {};
    const entityIdsByKey: Record<string, string> = {};
    for (const key of Object.keys(PAGES) as (keyof typeof PAGES)[]) {
      const page = PAGES[key];
      const pageId = createUuidV7();
      const { documentId } = await port.createPage({
        key,
        pageId,
        projectId: project.id,
        operationId: createUuidV7(),
        status: "doing",
        title: page.title,
        markdown: "",
      });
      await port.replaceOwnedDocument({
        projectId: project.id,
        pageId,
        mutationId: createUuidV7(),
        operationId: createUuidV7(),
        clientSessionId: createUuidV7(),
        markdown: page.markdown,
      });
      pageIdsByKey[key] = pageId;
      entityIdsByKey[`${key}Document`] = documentId;
      await port.captureRecoveryDraft({
        projectId: project.id,
        documentId,
        draftId: `draft:${key}`,
        createdAt: new Date(Date.now() - DRAFTS[key].ageMs).toISOString(),
        edit: DRAFTS[key].edit,
      });
    }
    return {
      version: 1,
      scenarioId: DOCUMENT_RECOVERY_REVIEW_SCENARIO_ID,
      scenarioRevision: 1,
      projectId: project.id,
      databaseViewId: project.defaultDatabaseViewId,
      pageIdsByKey,
      entityIdsByKey,
      minimumCommitSeq: 0,
      materializedAt: new Date().toISOString(),
    };
  },
  async inspect(port, manifest) {
    for (const pageId of Object.values(manifest.pageIdsByKey)) {
      const page = await port.readPage(manifest.projectId, pageId);
      if (page.documentReadiness !== "ready")
        throw new Error("Recovery review documents are not ready");
    }
    return { scenarioId: DOCUMENT_RECOVERY_REVIEW_SCENARIO_ID, scenarioRevision: 1 };
  },
};
