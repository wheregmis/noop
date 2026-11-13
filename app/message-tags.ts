import type { TextViewDocument } from "nsh/base";

/** AppKit inline attachment views can disappear in compositing. Use ordinary
 * attributed text on macOS, keeping task navigation through TextView links. */
export function messageTags(document: TextViewDocument, os: string): TextViewDocument {
  if (os !== "macos") return document;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const node = value as Record<string, unknown>;
    if (node.type === "custom" && (node.name === "task" || node.name === "item") && typeof node.text === "string") {
      const code = { type: "code", code: node.text };
      return node.name === "task"
        ? { type: "link", url: `noop-task:${node.text}`, content: [code] }
        : code;
    }
    const result = { ...node };
    for (const key of ["blocks", "footnotes", "content", "children", "items", "summary", "head", "rows"]) {
      if (Array.isArray(node[key])) result[key] = visit(node[key]);
    }
    return result;
  };
  return visit(document) as TextViewDocument;
}

export function taskTagId(url: string): string | undefined {
  return /^noop-task:(T-[A-Z]?\d{4})$/.exec(url)?.[1];
}
