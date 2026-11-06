// Editable knowledge documents; member profiles have their own validated form and decisions are historical records.
export const DOCUMENT_MAX_BYTES = 64_000;
export function editableDocument(path: unknown): path is string {
  return typeof path === "string" && path.length <= 240 && !path.split("/").some((part) => !part || part === "." || part === "..")
    && (/^(?:policies|memory)\/(?:[a-zA-Z0-9][\w.-]*\/)*[a-zA-Z0-9][\w.-]*\.md$/.test(path)
      || /^agents\/[a-z0-9][a-z0-9-]{0,39}\/memory\.md$/.test(path));
}
export const documentBody = (content: string) => content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
