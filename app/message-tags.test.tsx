import { expect, test } from "nsh/test";
import type { TextViewDocument } from "nsh/base";
import { messageTags, taskTagId } from "./message-tags";

const doc: TextViewDocument = {
  blocks: [{ type: "paragraph", content: [
    { type: "text", text: "按 " },
    { type: "custom", name: "item", text: "D-0408" },
    { type: "text", text: " 选 A，处理 " },
    { type: "strong", content: [{ type: "custom", name: "task", text: "T-H0001" }] },
    { type: "code", code: "T-0002" },
    { type: "text", text: " tasks/done/T-0003.md" },
  ] }],
  footnotes: [{ label: "1", index: 1, children: [{ type: "paragraph", content: [{ type: "custom", name: "item", text: "P-0001" }] }] }],
};

test("macOS identifiers remain text, including nested content and footnotes", () => {
  const rendered = messageTags(doc, "macos");
  expect(JSON.stringify(rendered)).not.toContain('"custom"');
  expect(rendered.blocks[0]).toEqual({ type: "paragraph", content: [
    { type: "text", text: "按 " }, { type: "code", code: "D-0408" },
    { type: "text", text: " 选 A，处理 " },
    { type: "strong", content: [{ type: "link", url: "noop-task:T-H0001", content: [{ type: "code", code: "T-H0001" }] }] },
    { type: "code", code: "T-0002" }, { type: "text", text: " tasks/done/T-0003.md" },
  ] });
  expect(JSON.stringify(doc)).toContain('"custom"');
});

test("other platforms keep the original document and attachment behavior", () => {
  for (const os of ["linux", "windows", "ios", "android", "web"]) expect(messageTags(doc, os)).toBe(doc);
});

test("only complete task tag links navigate to a task", () => {
  expect(taskTagId("noop-task:T-H0001")).toBe("T-H0001");
  expect(taskTagId("noop-task:T-0005")).toBe("T-0005");
  for (const url of ["https://example.com/T-0005", "noop-task:D-0001", "noop-task:T-0005/more", "noop-task:T-00055"]) expect(taskTagId(url)).toBeUndefined();
});
