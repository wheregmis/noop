/** A Markdown document (an agent's report) rather than an image: shown as a file card, opened in a reader. */
export const isDoc = (url: string) => /\.(md|markdown)(\?|$)/i.test(url);
/** A file the client can decode as an image: the types the server serves inline as images (cloud/src/uploads.ts).
 *  Anything else — a log, a patch, a pptx, an svg the server sends as a download — is a file card; sending it to the image
 *  decoder only ever fails, and a failed load reads as "the image expired" while the file is perfectly fine.
 *  Extensionless uploads and local previews keep their image behavior: the composer only takes images. */
export const isImage = (url: string) => {
  if (/^(blob:|data:image\/)/i.test(url)) return true;
  const name = url.replace(/[?#].*$/, "").split("/").pop() || "";
  return !name.includes(".") || /\.(png|jpe?g|gif|webp|avif|heic|heif|bmp)$/i.test(name);
};
/** An attachment's file name for display, without the storage timestamps ("1731-1732-report.md" → "report.md"). */
export const attachmentName = (url: string) => {
  const last = decodeURIComponent(url.replace(/[?#].*$/, "").split("/").pop() || "");
  return last.replace(/^(\d{10,}-)+/, "") || last;
};
