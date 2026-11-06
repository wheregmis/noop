import { mount, platform, signal, Text, View } from "nsh";
import process from "process";
import fs from "fs/promises";
import { createIntentStorage } from "./intent-storage";

const scope = "a".repeat(64), other = "b".repeat(64), blocked = "c".repeat(64);
const dataDir = process.dataDir;
const safeNative = !!dataDir && /\/(?:T|tmp)\/nsh-test-\d+-\d+\/dev\.noop\.app$/.test(dataDir.replaceAll("\\", "/"));

function Probe() {
  const result = signal("ready");
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  async function run() {
    try {
      // This check happens before even mkdir: a test-target regression cannot touch the real app's files.
      if (platform.os !== "web" && dataDir && !safeNative) throw new Error("Refusing a non-test native data directory");
      const io = createIntentStorage(scope);
      assert(await io.read() === null, "missing document must be null");
      await io.write("first", null); assert(await io.read() === "first", "completed replacement is readable");
      await io.write("", "first"); assert(await io.read() === "", "empty document must stay empty");
      await io.write("{malformed", ""); assert(await io.read() === "{malformed", "malformed raw document must be preserved");
      assert(await createIntentStorage(other).read() === null, "sessions must stay separate");
      let invalid = false;
      try { createIntentStorage("../outside"); } catch { invalid = true; }
      assert(invalid, "invalid scope must be refused");
      const second = createIntentStorage(scope), baseline = await io.read();
      const race = await Promise.allSettled([io.write("first adapter", baseline), second.write("second adapter", baseline)]);
      assert(race.filter((value) => value.status === "fulfilled").length === 1, "stale adapter cannot overwrite a concurrent save");
      const winner = await io.read();
      assert(winner === "first adapter" || winner === "second adapter", "winner must remain saved");
      await io.write("{malformed", winner);
      if (platform.os !== "web" && dataDir) {
        const path = "${dataDir}/pending-intents/" + blocked + ".json";
        await fs.mkdir(path);
        let readFailed = false;
        try { await createIntentStorage(blocked).read(); } catch { readFailed = true; }
        assert(readFailed, "read errors other than ENOENT must reject");
        let failed = false;
        try { await createIntentStorage(blocked).write("must not replace a directory", null); } catch { failed = true; }
        assert(failed && (await fs.lstat(path)).isDirectory(), "invalid target must reject and leave its target intact");
        assert(await io.read() === "{malformed", "failed write cannot corrupt another session");
        assert(!(await fs.readdir("${dataDir}/pending-intents")).some((name) => name.endsWith(".tmp")), "temporary files must be cleaned");
        await fs.rmdir(path);
      }
      result.set("passed");
    } catch (error) { result.set("error: " + (error instanceof Error ? error.message : String(error))); }
  }
  return <View style={{ padding: 20, gap: 12 }}>
    <Text>{"test-data-dir:" + (dataDir ?? "none")}</Text>
    <Text>{result()}</Text>
    <View testID="run-storage" onPress={() => void run()} style={{ height: 50 }}><Text>Run storage check</Text></View>
  </View>;
}
mount(Probe);
