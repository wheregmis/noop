import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { P } from "./core";
const present = (path: string) => { try { return lstatSync(path); } catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; } };

/** Archive names remain readable, while a same-clock remove/restore/remove never replaces history. */
export function archiveDestination(folder: string, id: string, extension = ""): string {
  for (const path of [P("archive"), P("archive", folder)]) {
    if (!present(path)) mkdirSync(path);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("The archive folder must be a real directory");
  }
  const stamp = new Date().toISOString().replace(/\W/g, "");
  for (let suffix = 0; ; suffix++) {
    const path = join(P("archive", folder), `${id}-${stamp}${suffix ? `-${suffix}` : ""}${extension}`);
    if (!present(path)) return path;
  }
}
