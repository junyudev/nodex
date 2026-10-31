import { describe, expect, test } from "vite-plus/test";
import {
  blockDocumentCustomBlockConfigs,
  blockDocumentCustomInlineContentConfigs,
} from "../../../../shared/block-documents/blocknote-schema-config";
import { headlessBlockDocumentSchema } from "../../../../shared/block-documents/headless-blocknote-schema";
import { nfmSchema } from "./nfm-schema";

const sortedKeys = (value: object): string => Object.keys(value).sort().join(",");

interface SchemaConfig {
  readonly type: string;
  readonly content: string;
  readonly propSchema: Readonly<
    Record<
      string,
      {
        readonly default: unknown;
        readonly type?: string;
        readonly values?: readonly unknown[];
      }
    >
  >;
}

const configSignature = (input: unknown): string => {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("Expected a custom schema config");
  }
  const config = input as SchemaConfig;
  return JSON.stringify({
    type: config.type,
    content: config.content,
    props: Object.entries(config.propSchema).map(([key, prop]) => ({
      key,
      default: prop.default === undefined ? { kind: "undefined" } : prop.default,
      type: prop.type ?? null,
      values: prop.values ?? null,
    })),
  });
};

describe("Block Document schema parity", () => {
  test("keeps Prompt inline and its send history separate from presentation props", () => {
    expect(nfmSchema.blockSchema.prompt).toEqual({
      type: "prompt",
      content: "inline",
      propSchema: {
        sentSessionId: { default: "" },
        sentAt: { default: "" },
        sentMessageId: { default: "" },
      },
    });
  });

  test("shares every writable custom config with the renderer schema", () => {
    expect(sortedKeys(headlessBlockDocumentSchema.inlineContentSchema)).toBe(
      sortedKeys(nfmSchema.inlineContentSchema),
    );

    for (const type of Object.keys(blockDocumentCustomBlockConfigs) as Array<
      keyof typeof blockDocumentCustomBlockConfigs
    >) {
      const config = blockDocumentCustomBlockConfigs[type];
      expect(headlessBlockDocumentSchema.blockSchema[type]).toBe(config);
      expect(nfmSchema.blockSchema[type]).toBe(config);
    }

    for (const type of Object.keys(blockDocumentCustomInlineContentConfigs) as Array<
      keyof typeof blockDocumentCustomInlineContentConfigs
    >) {
      const config = blockDocumentCustomInlineContentConfigs[type];
      expect(configSignature(headlessBlockDocumentSchema.inlineContentSpecs[type].config)).toBe(
        configSignature(config),
      );
      expect(configSignature(nfmSchema.inlineContentSpecs[type].config)).toBe(
        configSignature(config),
      );
    }
  });
});
