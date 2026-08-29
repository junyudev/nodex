import type { DatabaseViewFilterGroup, DatabaseViewFilterNode } from "../../shared/database-kernel";
import type { DatabaseViewFilterPath } from "./database-view-authoring";

const nodeAtPath = (
  root: DatabaseViewFilterNode,
  path: DatabaseViewFilterPath,
): DatabaseViewFilterNode | null => {
  let current = root;
  for (const index of path) {
    if (current.kind !== "group") return null;
    const next = current.children[index];
    if (!next) return null;
    current = next;
  }
  return current;
};

const cloneNode = (node: DatabaseViewFilterNode): DatabaseViewFilterNode =>
  node.kind === "clause" ? { ...node } : { ...node, children: node.children.map(cloneNode) };

const replaceChildList = (
  root: DatabaseViewFilterGroup,
  parentPath: DatabaseViewFilterPath,
  transform: (children: readonly DatabaseViewFilterNode[]) => readonly DatabaseViewFilterNode[],
): DatabaseViewFilterGroup => {
  if (parentPath.length === 0) return { ...root, children: transform(root.children) };
  const [index, ...rest] = parentPath;
  const child = root.children[index!];
  if (!child || child.kind !== "group") return root;
  return {
    ...root,
    children: root.children.map((candidate, candidateIndex) =>
      candidateIndex === index ? replaceChildList(child, rest, transform) : candidate,
    ),
  };
};

export const duplicateDatabaseViewAdvancedFilterNode = (
  root: DatabaseViewFilterGroup,
  path: DatabaseViewFilterPath,
): DatabaseViewFilterGroup => {
  if (path.length === 0) return root;
  const target = nodeAtPath(root, path);
  const index = path.at(-1);
  if (!target || index === undefined) return root;
  return replaceChildList(root, path.slice(0, -1), (children) => [
    ...children.slice(0, index + 1),
    cloneNode(target),
    ...children.slice(index + 1),
  ]);
};

export const wrapDatabaseViewAdvancedFilterNode = (
  root: DatabaseViewFilterGroup,
  path: DatabaseViewFilterPath,
): DatabaseViewFilterGroup => {
  if (path.length === 0) return root;
  const target = nodeAtPath(root, path);
  const parent = nodeAtPath(root, path.slice(0, -1));
  const index = path.at(-1);
  if (!target || !parent || parent.kind !== "group" || index === undefined) return root;
  const wrapper: DatabaseViewFilterGroup = {
    kind: "group",
    operator: parent.operator === "and" ? "or" : "and",
    children: [target],
  };
  return replaceChildList(root, path.slice(0, -1), (children) =>
    children.map((child, childIndex) => (childIndex === index ? wrapper : child)),
  );
};

export const unwrapDatabaseViewAdvancedFilterGroup = (
  root: DatabaseViewFilterGroup,
  path: DatabaseViewFilterPath,
): DatabaseViewFilterGroup => {
  if (path.length === 0) return root;
  const target = nodeAtPath(root, path);
  const index = path.at(-1);
  if (!target || target.kind !== "group" || index === undefined) return root;
  return replaceChildList(root, path.slice(0, -1), (children) => [
    ...children.slice(0, index),
    ...target.children,
    ...children.slice(index + 1),
  ]);
};

export const databaseViewAdvancedFilterDepth = (node: DatabaseViewFilterNode): number => {
  if (node.kind === "clause" || node.children.length === 0) return 0;
  return 1 + Math.max(...node.children.map(databaseViewAdvancedFilterDepth));
};
