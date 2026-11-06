import fs from "fs/promises";
import process from "process";
import { randomUUID } from "crypto";
import { host, platform } from "nsh";

const nativeWrites = new Map<string, Promise<void>>();
const conflict = () => Object.assign(new Error("Saved pending actions changed in another window. Reload before trying again."), { code: "ERR_INTENT_STORAGE_CONFLICT" });

/** One session's raw pending-intent document. A successful write completes before an action may be sent. */
export function createIntentStorage(scope: string): { read(): Promise<string | null>; write(text: string, expected: string | null): Promise<void> } {
  if (typeof scope !== "string" || !/^[a-f0-9]{64}$/.test(scope)) throw new Error("Invalid pending-action storage scope");
  if (platform.os === "web" || !process.dataDir) return {
    async read() {
      const result = await host.call("pendingRead", { scope }) as { scope?: unknown; text?: unknown } | null;
      if (!result || result.scope !== scope || result.text !== null && typeof result.text !== "string")
        throw new Error("Could not read saved pending actions");
      return result.text as string | null;
    },
    async write(text, expected) {
      if (typeof text !== "string" || expected !== null && typeof expected !== "string") throw new Error("Pending-action storage requires text and its previous value");
      const result = await host.call("pendingWrite", { scope, text, expected }) as { scope?: unknown; saved?: unknown } | null;
      if (!result || result.scope !== scope || result.saved !== true) throw new Error("Could not confirm saved pending actions");
    },
  };
  const directory = "${dataDir}/pending-intents", path = `${directory}/${scope}.json`;
  const available = () => {
    if (!process.dataDir) throw new Error("This app has no private directory for saved pending actions");
  };
  const read = async () => {
    available();
    try { return await fs.readFile(path, "utf8"); }
    catch (error) { if ((error as { code?: string }).code === "ENOENT") return null; throw error; }
  };
  return {
    read,
    async write(text, expected) {
      available();
      if (typeof text !== "string" || expected !== null && typeof expected !== "string") throw new Error("Pending-action storage requires text and its previous value");
      const key = `${process.dataDir}/${scope}`;
      // All Hub instances in this app share the queue; this is not a cross-process file lock.
      const write = (nativeWrites.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
        if (await read() !== expected) throw conflict();
        await fs.mkdir(directory, { recursive: true });
        const temporary = `${directory}/${scope}.${randomUUID()}.tmp`;
        // Await real I/O and a same-directory replacement; the SDK exposes no file/directory fsync.
        try { await fs.writeFile(temporary, text); await fs.rename(temporary, path); }
        finally { await fs.unlink(temporary).catch(() => {}); }
      });
      nativeWrites.set(key, write);
      const release = () => { if (nativeWrites.get(key) === write) nativeWrites.delete(key); };
      void write.then(release, release);
      await write;
    },
  };
}
