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
  getStatusDotColor,
  parseMetaTokens,
} from "@/lib/toggle-list/meta-chips";

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
        sourceColumnId: { default: "" },
        sourceColumnName: { default: "" },
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
      line.className = "flex items-center gap-2 min-w-0 flex-nowrap";

      const meta = document.createElement("span");
      meta.className = "inline-flex items-center gap-1.5 flex-nowrap shrink-0";
      meta.contentEditable = "false";

      for (const token of parseMetaTokens(block.props.meta)) {
        const propertyType = classifyMetaToken(token);
        const chip = document.createElement("span");
        chip.className = getMetaChipClassName(token);
        chip.dataset.chipProperty = propertyType;
        chip.dataset.chipCardId = block.props.cardId;
        chip.dataset.chipBlockId = block.id;
        chip.dataset.chipToken = token;

        // Status chips get a real dot element instead of CSS ::before
        const dotColor = getStatusDotColor(token);
        if (dotColor) {
          const dot = document.createElement("span");
          dot.className = "w-2 h-2 rounded-full shrink-0";
          dot.style.background = dotColor;
          chip.appendChild(dot);
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

      const title = document.createElement("p");
      title.className = "min-w-0 m-0 flex-1";

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
      addDefaultPropsExternalHTML(block.props, li);

      if (block.props.meta) {
        const meta = document.createElement("span");
        meta.textContent = `${block.props.meta} `;
        li.appendChild(meta);
      }

      li.appendChild(p);

      return {
        dom: li,
        contentDOM: p,
      };
    },
  },
);
