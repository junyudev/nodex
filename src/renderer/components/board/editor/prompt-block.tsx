import { createReactBlockSpec } from "@blocknote/react";
import { promptBlockConfig } from "../../../../shared/block-documents/blocknote-schema-config";

export const createPromptBlockSpec = createReactBlockSpec(promptBlockConfig, {
  render: (props) => <div ref={props.contentRef} />,
  toExternalHTML: (props) => <p ref={props.contentRef} />,
});
