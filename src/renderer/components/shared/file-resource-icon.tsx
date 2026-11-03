import type { ComponentType, CSSProperties } from "react";
import { FileTabIconSvg, type FileTabIconName } from "@/components/shared/icons";
import { getFileTreeIconColor, resolveFileTreeIconToken } from "@/lib/file-tree-icons";

export type FileResourceIconKey = FileTabIconName;

interface FileResourceIconComponentProps {
  className?: string;
  style?: CSSProperties;
}

type FileResourceIconComponent = ComponentType<FileResourceIconComponentProps>;

const EXACT_ICON_KEY_BY_NAME: Readonly<Record<string, FileResourceIconKey>> = {
  "skill.md": "skill",
};

const ICON_KEY_BY_EXTENSION: Readonly<Record<string, FileResourceIconKey>> = {
  bash: "shell",
  bazel: "build",
  bmp: "image",
  bzl: "build",
  c: "cplusplus",
  cc: "cplusplus",
  checksum: "hashes",
  cjs: "javascript",
  cpp: "cplusplus",
  cs: "code",
  css: "css",
  csv: "spreadsheet",
  cxx: "cplusplus",
  dockerfile: "terminal",
  doc: "artifactDocument",
  docx: "artifactDocument",
  dotenv: "document",
  env: "document",
  fish: "shell",
  gif: "image",
  gitignore: "document",
  go: "code",
  gradle: "build",
  gz: "folder",
  h: "cplusplus",
  hh: "cplusplus",
  hpp: "cplusplus",
  hs: "javascript",
  htm: "html",
  html: "html",
  ico: "image",
  ipynb: "notebook",
  java: "java",
  jpeg: "image",
  jpg: "image",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "react",
  kt: "code",
  less: "css",
  lock: "document",
  m: "code",
  makefile: "build",
  markdown: "document",
  md: "document",
  md5: "hashes",
  mdown: "document",
  mdx: "document",
  mk: "build",
  mkd: "document",
  mm: "code",
  mjs: "javascript",
  ninja: "build",
  pdf: "pdf",
  php: "php",
  png: "image",
  ppt: "presentation",
  pptx: "presentation",
  ps1: "shell",
  py: "python",
  rb: "code",
  rs: "rust",
  sass: "css",
  scss: "css",
  sh: "shell",
  sha: "hashes",
  sha1: "hashes",
  sha256: "hashes",
  sql: "code",
  sum: "hashes",
  svg: "image",
  swift: "code",
  tar: "folder",
  tgz: "folder",
  toml: "toml",
  ts: "typescript",
  tsv: "spreadsheet",
  tsx: "react",
  webp: "image",
  xls: "spreadsheet",
  xlsm: "spreadsheet",
  xlsx: "spreadsheet",
  xml: "document",
  yaml: "yaml",
  yml: "yaml",
  zip: "folder",
  zsh: "shell",
};

const ICON_KEY_BY_MIME_PREFIX: readonly {
  prefix: string;
  key: FileResourceIconKey;
}[] = [
  { prefix: "image/", key: "image" },
  { prefix: "text/", key: "document" },
  { prefix: "application/pdf", key: "pdf" },
  { prefix: "application/zip", key: "folder" },
  { prefix: "application/gzip", key: "folder" },
];

function fileResourceBasename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function fileResourceLookupExtension(path: string): string | null {
  const basename = fileResourceBasename(path);
  const dotIndex = basename.lastIndexOf(".");

  if (dotIndex > 0 && dotIndex < basename.length - 1) {
    return basename.slice(dotIndex + 1);
  }
  if (dotIndex === 0 && basename.length > 1) {
    return basename.slice(1);
  }
  if (dotIndex === -1 && basename.length > 0) {
    return basename;
  }
  return null;
}

export function resolveFileResourceIconKey(
  path?: string | null,
  mimeType?: string | null,
): FileResourceIconKey {
  if (path) {
    if (/[\\/]$/.test(path)) return "folder";

    const basename = fileResourceBasename(path);
    const exactKey = EXACT_ICON_KEY_BY_NAME[basename];
    if (exactKey) return exactKey;

    const extension = fileResourceLookupExtension(path);
    if (extension) {
      const extensionKey = ICON_KEY_BY_EXTENSION[extension];
      if (extensionKey) return extensionKey;
    }
  }

  const normalizedMimeType = mimeType?.toLowerCase();
  if (normalizedMimeType) {
    const match = ICON_KEY_BY_MIME_PREFIX.find(({ prefix }) =>
      normalizedMimeType.startsWith(prefix),
    );
    if (match) return match.key;
  }

  return "file";
}

function makeFileResourceIcon(iconKey: FileResourceIconKey): FileResourceIconComponent {
  const ResolvedFileResourceIcon = ({ className, style }: FileResourceIconComponentProps) => (
    <FileTabIconSvg className={className} icon={iconKey} style={style} />
  );
  ResolvedFileResourceIcon.displayName = `FileResourceIcon(${iconKey})`;
  return ResolvedFileResourceIcon;
}

const COMPONENT_BY_ICON_KEY = Object.fromEntries(
  (
    Object.keys({
      artifactDocument: true,
      build: true,
      code: true,
      cplusplus: true,
      css: true,
      document: true,
      file: true,
      folder: true,
      hashes: true,
      html: true,
      image: true,
      java: true,
      javascript: true,
      json: true,
      notebook: true,
      pdf: true,
      php: true,
      presentation: true,
      python: true,
      react: true,
      rust: true,
      shell: true,
      skill: true,
      spreadsheet: true,
      terminal: true,
      toml: true,
      typescript: true,
      yaml: true,
    } satisfies Record<FileResourceIconKey, true>) as FileResourceIconKey[]
  ).map((iconKey) => [iconKey, makeFileResourceIcon(iconKey)]),
) as Record<FileResourceIconKey, FileResourceIconComponent>;

export function resolveFileResourceIcon(
  path?: string | null,
  mimeType?: string | null,
): FileResourceIconComponent {
  return COMPONENT_BY_ICON_KEY[resolveFileResourceIconKey(path, mimeType)];
}

export function FileResourceIcon({
  path,
  mimeType,
  className,
  style,
}: {
  readonly path?: string | null;
  readonly mimeType?: string | null;
  readonly className?: string;
  readonly style?: CSSProperties;
}) {
  return (
    <FileTabIconSvg
      icon={resolveFileResourceIconKey(path, mimeType)}
      className={className}
      style={style}
    />
  );
}

/** Adds the format color used by file trees while preserving the shared path/MIME glyph. */
export function ColorfulFileResourceIcon({
  path,
  mimeType,
  className,
  style,
}: {
  readonly path?: string | null;
  readonly mimeType?: string | null;
  readonly className?: string;
  readonly style?: CSSProperties;
}) {
  const colorToken = resolveFileTreeIconToken(path || "");
  return (
    <FileResourceIcon
      path={path}
      mimeType={mimeType}
      className={className}
      style={{ color: getFileTreeIconColor(colorToken), ...style }}
    />
  );
}
