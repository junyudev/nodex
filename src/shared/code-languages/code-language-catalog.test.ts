import { describe, expect, test } from "vite-plus/test";
import {
  CODE_LANGUAGE_CATALOG,
  CODE_LANGUAGE_LABELS,
  normalizeCodeLanguageId,
  resolveCodeLanguage,
} from "./code-language-catalog";

const EXPECTED_LABELS = [
  "ABAP",
  "Agda",
  "Arduino",
  "ASCII Art",
  "Assembly",
  "Bash",
  "BASIC",
  "BNF",
  "C",
  "C#",
  "C++",
  "Clojure",
  "CoffeeScript",
  "CSS",
  "Dart",
  "Dhall",
  "Diff",
  "Docker",
  "EBNF",
  "Elixir",
  "Elm",
  "Erlang",
  "F#",
  "Flow",
  "Fortran",
  "Gherkin",
  "GLSL",
  "Go",
  "GraphQL",
  "Groovy",
  "Haskell",
  "HCL",
  "HTML",
  "Idris",
  "Java",
  "JavaScript",
  "JSON",
  "Julia",
  "Kotlin",
  "LaTeX",
  "Less",
  "Lisp",
  "LiveScript",
  "LLVM IR",
  "Lua",
  "Makefile",
  "Markdown",
  "Markup",
  "Mathematica",
  "MATLAB",
  "Mermaid",
  "Nix",
  "Notion Formula",
  "Objective-C",
  "OCaml",
  "Pascal",
  "Perl",
  "PHP",
  "Plain Text",
  "PowerShell",
  "Prolog",
  "Protobuf",
  "PureScript",
  "Python",
  "R",
  "Racket",
  "Reason",
  "Rocq",
  "Ruby",
  "Rust",
  "Sass",
  "Scala",
  "Scheme",
  "SCSS",
  "Shell",
  "Smalltalk",
  "Solidity",
  "SQL",
  "Swift",
  "TOML",
  "TypeScript",
  "VB.Net",
  "Verilog",
  "VHDL",
  "Visual Basic",
  "WebAssembly",
  "XML",
  "YAML",
] as const;

describe("Code language catalog", () => {
  test("exposes exactly the 88 product languages in display order", () => {
    expect(CODE_LANGUAGE_LABELS).toEqual(EXPECTED_LABELS);
    expect(CODE_LANGUAGE_CATALOG).toHaveLength(88);
    expect(new Set(CODE_LANGUAGE_CATALOG.map((language) => language.id)).size).toBe(88);
  });

  test("resolves canonical ids, labels, aliases, and extensions", () => {
    expect(normalizeCodeLanguageId("JavaScript")).toBe("javascript");
    expect(normalizeCodeLanguageId("js")).toBe("javascript");
    expect(normalizeCodeLanguageId(".tsx")).toBe("typescript");
    expect(normalizeCodeLanguageId("Coq")).toBe("rocq");
    expect(resolveCodeLanguage("SCSS")?.label).toBe("SCSS");
  });

  test("collapses absent and unsupported language values to Plain Text", () => {
    expect(normalizeCodeLanguageId(undefined)).toBe("text");
    expect(normalizeCodeLanguageId(" ")).toBe("text");
    expect(normalizeCodeLanguageId("vue")).toBe("text");
    expect(normalizeCodeLanguageId("tsx-react-component")).toBe("text");
  });

  test("declares formatter capability independently from highlighting", () => {
    const formatterLabels = CODE_LANGUAGE_CATALOG.filter(
      (language) => language.formatterKind !== null,
    ).map((language) => language.label);

    expect(formatterLabels).toEqual([
      "CSS",
      "GraphQL",
      "HTML",
      "JavaScript",
      "JSON",
      "SCSS",
      "TypeScript",
      "XML",
    ]);
    expect(resolveCodeLanguage("rust")?.shikiLanguage).toBe("rust");
    expect(resolveCodeLanguage("rust")?.formatterKind).toBeNull();
  });
});
