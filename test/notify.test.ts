import { expect, test } from "bun:test";
import { inQuiet, notificationFor } from "../app/notify";

const at = (hm: string) => new Date(`2026-11-05T${hm}:00Z`);
const quiet = { start: "22:00", end: "08:00" };

test("quiet hours are read in both the app's shape and a hand-written range", () => {
  for (const range of [quiet, "22:00-08:00"]) {
    expect(inQuiet(range, "UTC", at("23:30"))).toBe(true);
    expect(inQuiet(range, "UTC", at("07:59"))).toBe(true);
    expect(inQuiet(range, "UTC", at("08:00"))).toBe(false);
  }
  expect(inQuiet(null, "UTC", at("23:30"))).toBe(false);
  expect(inQuiet(quiet, "Asia/Shanghai", at("23:30"))).toBe(true); // 07:30 there
  expect(inQuiet(quiet, "Asia/Shanghai", at("01:00"))).toBe(false); // 09:00 there
});

test("quiet hours hold back all but logins and urgent decisions", () => {
  const prefs = { quiet_hours: quiet, tz: "UTC" };
  const now = at("23:30");
  expect(notificationFor({ kind: "decision", text: "merge?" }, prefs, now)).toBe(null);
  expect(notificationFor({ kind: "decision", text: "merge?", priority: "urgent" }, prefs, now)?.title).toBe("Needs your decision");
  expect(notificationFor({ kind: "login", text: "code" }, prefs, now)?.title).toBe("Sign-in alert");
});

test("the settings' switches reach their kinds, notices being the results", () => {
  const off = (kind: string) => ({ kinds: { [kind]: false } });
  expect(notificationFor({ kind: "notice", from: "lead@mac", text: "done" }, off("result"))).toBe(null);
  expect(notificationFor({ kind: "decision", text: "merge?" }, off("decision"))).toBe(null);
  expect(notificationFor({ kind: "notice", from: "lead@mac", text: "done" }, off("decision"))?.body).toBe("done");
});

test("the owner's own words and the hub's housekeeping never notify", () => {
  expect(notificationFor({ kind: "owner", text: "hi" }, {})).toBe(null);
  expect(notificationFor({ kind: "system", text: "x" }, {})).toBe(null);
  expect(notificationFor({ kind: "notice", from: "hub@mac", text: "x" }, {})).toBe(null);
});

test("the body is plain and short", () => {
  const body = notificationFor({ kind: "decision", text: `*merge* \`#1\` [pr](https://x.test/1) ${"y".repeat(200)}` }, {})!.body;
  expect(body.startsWith("merge 1 pr y")).toBe(true);
  expect(body.length).toBe(140);
});
