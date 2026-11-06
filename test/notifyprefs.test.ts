import { beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { deviceTimeZone, notificationTimeZone, inQuiet, notificationFor } from "../app/notify";
import { notifyPrefsOf, notifyPatch, type SettingsView } from "../app/hub";
import { P } from "../src/core";
import { saveSettings } from "../src/server";

const io = { pull: async () => true, push: async () => true };
beforeEach(() => {
  mkdirSync(P("journal"), { recursive: true }); mkdirSync(P("agents"), { recursive: true });
  writeFileSync(P("config.toml"), "[host]\nname = 'timezone-fixture'\n");
  rmSync(P("config.local.toml"), { force: true });
  writeFileSync(P("settings.json"), JSON.stringify({ machines: { mac: { enabled: false } }, notify_prefs: { tz: "Europe/London", quiet_hours: { start: "22:00", end: "08:00" }, kinds: { result: false } } }));
});

test("new notification preferences use the device zone and preserve explicit shared choices", () => {
  expect(notifyPrefsOf(null).tz).toBe(deviceTimeZone());
  const view = { current: { notify_prefs: { tz: "Europe/London", quiet_hours: { start: "22:00", end: "08:00" }, kinds: { result: false } } } } as unknown as SettingsView;
  const prefs = notifyPrefsOf(view, "America/Toronto");
  expect(prefs.tz).toBe("Europe/London");
  expect(prefs.kinds.result).toBe(false); expect(prefs.quiet_hours).toEqual({ start: "22:00", end: "08:00" });
  expect(notifyPatch(prefs).notify_prefs.tz).toBe("Europe/London");
  const handwritten = { current: { notify_prefs: { quiet_hours: "22:00-8:00", tz: "Europe/London" } } } as unknown as SettingsView;
  expect(notifyPrefsOf(handwritten).quiet_hours).toEqual({ start: "22:00", end: "08:00" });

  const unavailable = spyOn(Intl, "DateTimeFormat").mockImplementation((() => { throw new Error("timezone unavailable"); }) as unknown as typeof Intl.DateTimeFormat);
  try { expect(deviceTimeZone()).toBe("UTC"); } finally { unavailable.mockRestore(); }
});

test("timezone validation accepts named zones and rejects arbitrary or offset-only values", () => {
  expect(notificationTimeZone(" America/Toronto ")).toBe("America/Toronto");
  expect(notificationTimeZone("UTC")).toBe("UTC");
  expect(notificationTimeZone("Etc/GMT+5")).toBeTruthy();
  for (const invalid of [null, 1, "", "Toronto", "Mars/Olympus", "+05:00", "America/Toronto\nUTC", "x".repeat(101)]) expect(notificationTimeZone(invalid)).toBeNull();
});

test("quiet hours follow Toronto daylight-saving transitions and exclude the exact end", () => {
  const quiet = { start: "01:00", end: "02:00" };
  for (const stamp of ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z", "2026-03-08T06:30:00Z"]) expect(inQuiet(quiet, "America/Toronto", new Date(stamp))).toBe(true);
  for (const stamp of ["2026-11-01T07:00:00Z", "2026-03-08T07:00:00Z"]) expect(inQuiet(quiet, "America/Toronto", new Date(stamp))).toBe(false);
  expect(notificationFor({ kind: "decision", text: "Review?" }, { tz: "America/Toronto", quiet_hours: quiet }, new Date("2026-11-01T06:30:00Z"))).toBeNull();
  expect(notificationFor({ kind: "decision", text: "Review?" }, { tz: "America/Toronto", quiet_hours: quiet }, new Date("2026-11-01T07:00:00Z"))?.title).toBe("Needs your decision");
});

test("a timezone-only save round-trips while preserving quiet hours and unrelated preferences", async () => {
  const view = await saveSettings({ notify_prefs: { tz: " America/Toronto " } }, io);
  expect(view.current).toMatchObject({ machines: { mac: { enabled: false } }, notify_prefs: { tz: "America/Toronto", quiet_hours: { start: "22:00", end: "08:00" }, kinds: { result: false } } });
  expect(notifyPrefsOf(view).tz).toBe("America/Toronto");
});

test("invalid timezone changes are rejected before refresh or any preference write", async () => {
  const before = readFileSync(P("settings.json"), "utf8"); let pulls = 0;
  for (const tz of [null, 1, "", "Mars/Olympus", "+01:00", "UTC\nEurope/London"]) {
    await expect(saveSettings({ notify_prefs: { tz } }, { ...io, pull: async () => { pulls++; return true; } })).rejects.toThrow("IANA time zone");
    expect(readFileSync(P("settings.json"), "utf8")).toBe(before);
  }
  expect(pulls).toBe(0);
});


test("malformed quiet hours and notification kinds cannot bypass preference validation", async () => {
  const before = readFileSync(P("settings.json"), "utf8");
  for (const prefs of [{ quiet_hours: { start: "25:00", end: "08:00" } }, { quiet_hours: { start: "22:00" } }, { quiet_hours: "22:00-88:00" }, { kinds: { result: "false" } }, { kinds: { unknown: true } }, { arbitrary: true }]) {
    await expect(saveSettings({ notify_prefs: prefs }, io)).rejects.toThrow();
    expect(readFileSync(P("settings.json"), "utf8")).toBe(before);
  }
});


test("valid quiet-hour objects and handwritten ranges survive validated timezone saves", async () => {
  for (const quiet_hours of [{ start: "22:00", end: "08:00" }, "22:00-08:00"]) {
    const view = await saveSettings({ notify_prefs: { tz: "America/Toronto", quiet_hours, kinds: { decision: true } } }, io);
    expect((view.current.notify_prefs as any).quiet_hours).toEqual(quiet_hours);
  }
});
