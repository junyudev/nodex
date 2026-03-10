import { defaultProps } from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";

export const createCalloutBlock = createReactBlockSpec(
  {
    type: "callout" as const,
    propSchema: {
      ...defaultProps,
      icon: { default: "💡" },
    },
    content: "inline",
  },
  {
    render: (props) => {
      return (
        <div
          className="nfm-callout"
          style={{
            display: "flex",
            gap: "8px",
            padding: "16px",
            borderRadius: "4px",
            backgroundColor: "var(--background-tertiary, rgba(0,0,0,0.03))",
          }}
        >
          <span
            className="nfm-callout-icon"
            contentEditable={false}
            style={{ fontSize: "1.2em", userSelect: "none" }}
          >
            {props.block.props.icon}
          </span>
          <div ref={props.contentRef} style={{ flex: 1, minWidth: 0 }} />
        </div>
      );
    },
  },
);
