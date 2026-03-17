import {
  addDefaultPropsExternalHTML,
  createBlockConfig,
  createBlockSpec,
  createToggleWrapper,
  defaultProps,
} from "@blocknote/core";
import {
  classifyMetaToken,
  getMetaChipClassName,
  parseMetaTokens,
} from "@/lib/toggle-list/meta-chips";
import { createStatusIconElement, getStatusIdByLabel } from "@/lib/status-chip";

export const createCardToggleBlockConfig = createBlockConfig(
  () =>
    ({
      type: "cardToggle" as const,
      propSchema: {
        ...defaultProps,
        cardId: { default: "" },
        meta: { default: "" },
        snapshot: { default: "" },
        sourceProjectId: { default: "" },
        sourceStatus: { default: "" },
        sourceStatusName: { default: "" },
        projectionOwnerId: { default: "" },
        projectionKind: { default: "" },
        projectionSourceProjectId: { default: "" },
        projectionCardId: { default: "" },
      },
      content: "inline" as const,
    }) as const,
);

export const createCardToggleBlockSpec = createBlockSpec(
  createCardToggleBlockConfig,
  {
    meta: {
      isolating: false,
    },
    render(block, editor) {
      const line = document.createElement("div");
      line.className = "min-w-0";

      const meta = document.createElement("span");
      meta.className =
        "mr-1 inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-1 align-middle";
      meta.contentEditable = "false";

      for (const token of parseMetaTokens(block.props.meta)) {
        const propertyType = classifyMetaToken(token);
        const chip = document.createElement("span");
        chip.className = getMetaChipClassName(token);
        chip.dataset.chipProperty = propertyType;
        chip.dataset.chipCardId = block.props.cardId;
        chip.dataset.chipBlockId = block.id;
        chip.dataset.chipToken = token;

        const statusId = getStatusIdByLabel(token);
        if (statusId) {
          const icon = createStatusIconElement(statusId, { className: "size-3.5 shrink-0" });
          chip.appendChild(icon);
        }

        chip.appendChild(document.createTextNode(token));

        if (propertyType !== "tag") {
          chip.classList.add(
            "cursor-pointer",
            "transition-[filter,box-shadow]",
            "duration-swift",
            "ease-linear",
          );
          chip.dataset.chipEditable = "true";
        }
        meta.appendChild(chip);
      }

      const title = document.createElement("span");
      title.className = "min-w-0";

      if (meta.childElementCount > 0) {
        line.appendChild(meta);
      }
      line.appendChild(title);

      const toggleWrapper = createToggleWrapper(
        block as Parameters<typeof createToggleWrapper>[0],
        editor,
        line,
      );

      // Mark projected card toggles so CSS can style the caret differently
      if (block.props.projectionOwnerId) {
        const inner = toggleWrapper.dom.querySelector(".bn-toggle-wrapper");
        if (inner instanceof HTMLElement) {
          inner.dataset.projected = "true";
        }
      }

      return { ...toggleWrapper, contentDOM: title };
    },
    toExternalHTML(block) {
      const li = document.createElement("li");
      const p = document.createElement("p");
      const title = document.createElement("span");
      addDefaultPropsExternalHTML(block.props, li);

      if (block.props.meta) {
        const meta = document.createElement("span");
        meta.textContent = `${block.props.meta} `;
        p.appendChild(meta);
      }

      p.appendChild(title);
      li.appendChild(p);

      return {
        dom: li,
        contentDOM: title,
      };
    },
  },
);
