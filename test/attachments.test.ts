import { expect, test } from "bun:test";
import { attachmentName, isDoc, isImage } from "../app/files";

test("markdown attachments are documents, images are not", () => {
  expect(isDoc("/media/1731-report.md")).toBe(true);
  expect(isDoc("/media/1731-notes.markdown?token=x")).toBe(true);
  expect(isDoc("/media/1731-shot.png")).toBe(false);
});

test("only files an image decoder can read are images; logs, patches and archives get a file card", () => {
  for (const file of ["verify.log", "fix.patch", "changes.diff", "settings.json", "notes.txt", "slides.pptx", "manual.pdf", "bundle.zip", "drawing.svg"])
    expect(isImage(`/media/1794484440793-${file}?token=x`)).toBe(false);
  for (const file of ["shot.png", "photo.JPG", "anim.gif", "pic.webp", "pic.avif", "pic.heic", "pic.bmp"])
    expect(isImage(`/media/1794484440793-${file}?token=x`)).toBe(true);
  // the composer only takes images, so an extensionless upload or a local preview is one
  expect(isImage("/media/1794484440793-image")).toBe(true);
  expect(isImage("blob:https://hub.example/preview-id")).toBe(true);
  expect(isImage("data:image/png;base64,AAAA")).toBe(true);
});

test("attachment names drop the storage timestamps", () => {
  expect(attachmentName("/media/1762650000000-1762650000123-push-notifications.md")).toBe("push-notifications.md");
  expect(attachmentName("https://hub.example/media/1762650000000-report.md?token=x")).toBe("report.md");
  expect(attachmentName("/media/plain.md")).toBe("plain.md");
});
