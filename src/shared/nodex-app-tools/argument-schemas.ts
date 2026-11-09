import { sessionControlSchemas } from "./session-control-schemas";
import { sessionQuestionSchema } from "./session-question-schema";
import { z } from "zod";
import { NODEX_AGENT_V6_TOOL_CONTRACTS } from "../nodex-agent-tools/v6-contracts";
import { accountSchemas } from "./account-schemas";
import { automationSchema } from "./automation-schema";
import { sendToInboxSchema } from "./inbox-schema";
import {
  InboxSuggestionOutput,
  writeTurnNoteSchema,
  answerInboxQuestionSchema,
} from "./coordinator-schema";
import { reportWorkSchema, startWorkSchema, handBackMessageSchema } from "./work-schema";
import { uninstallPluginSchema } from "./plugin-schema";
import { describeContentSchemaInput, sqlQuerySchema } from "./query-schemas";
import { sessionForkSchema } from "./session-fork-schema";
import { sessionHandoffSchema, handoffStatusSchema } from "./session-handoff-schemas";
import { createSessionSchema } from "./session-launch-schema";
import { sessionMergeSchema } from "./session-merge-schema";
import { sessionMessageSchema } from "./session-message-schema";
import { sessionObservationSchemas } from "./session-observation-schemas";
import { sessionPresentationSchemas } from "./session-presentation-schemas";
import { sessionSchemas } from "./session-schemas";
import { sidebarSchemas } from "./sidebar-schemas";
import { readSessionTerminalSchema } from "./terminal-schema";
import { workbenchControlSchemas } from "./workbench-control-schemas";
import { workbenchObservationSchemas } from "./workbench-observation-schemas";

import { emptyAppToolArguments } from "./empty-arguments";

/** The complete hosted catalog's executable argument contracts, including semantic content tools. */
export const appToolArgumentSchemas: Readonly<Record<string, z.ZodType>> = {
  ...Object.fromEntries(
    Object.entries(NODEX_AGENT_V6_TOOL_CONTRACTS).map(([name, contract]) => [
      name,
      contract.inputSchema,
    ]),
  ),
  ...accountSchemas,
  ...sessionControlSchemas,
  ...sessionObservationSchemas,
  ...sessionPresentationSchemas,
  ...sessionSchemas,
  ...sidebarSchemas,
  ...workbenchControlSchemas,
  ...workbenchObservationSchemas,
  automation_update: automationSchema,
  send_to_inbox: sendToInboxSchema,
  inbox_suggest: InboxSuggestionOutput,
  write_turn_note: writeTurnNoteSchema,
  answer_inbox_question: answerInboxQuestionSchema,
  report_work: reportWorkSchema,
  hand_back_message: handBackMessageSchema,
  start_work: startWorkSchema,
  uninstall_plugin: uninstallPluginSchema,
  query_content: sqlQuerySchema,
  describe_content_schema: describeContentSchemaInput,
  fork_session: sessionForkSchema,
  handoff_session: sessionHandoffSchema,
  get_handoff_status: handoffStatusSchema,
  create_session: createSessionSchema,
  merge_session_back: sessionMergeSchema,
  send_message_to_session: sessionMessageSchema,
  session_question: sessionQuestionSchema,
  read_session_terminal: readSessionTerminalSchema,
  load_workspace_dependencies: emptyAppToolArguments,
  list_projects: emptyAppToolArguments,
  get_app_capabilities: emptyAppToolArguments,
};
