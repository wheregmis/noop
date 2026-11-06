import { expect, test } from "bun:test";
import { machineLearningPath, readLearningPreview, readLearningStatus, readLearningRunResult, readLearningDiscardResult, validLearningPreviewRequest, validLearningRunRequest, validLearningDiscardRequest, validLearningResult,
  type LearningStatus, type LearningPreview, type LearningPending, type LearningRunResult, type LearningDiscardResult } from "../cloud/src/learning";

const request = { request_id: "12345678-1234-4234-8234-123456789abc", preview_digest: "a".repeat(64) };
const counts = { turns: 2, sessions: 1, truncated: false };
const result: LearningRunResult = { host: "mac", ...request, ...counts, id: "T-mac-0001", applied: true, replayed: false };

test("learning paths and inputs permit only explicit host-bound status, preview and saved runs", () => {
  expect(machineLearningPath("/api/machines/mac/learning")).toEqual({ host: "mac", action: "status" });
  expect(machineLearningPath("/api/machines/mac/learning/preview")).toEqual({ host: "mac", action: "preview" });
  expect(machineLearningPath("/api/machines/mac/learning/run")).toEqual({ host: "mac", action: "run" });
  expect(machineLearningPath("/api/machines/mac/learning/discard")).toEqual({ host: "mac", action: "discard" });
  for (const path of ["/api/learning/run", "/api/machines/constructor/learning", "/api/machines/mac/learning/full", "/api/machines/mac/learning/run/more", "/api/machines/%2f/learning"])
    expect(machineLearningPath(path)).toBeNull();
  expect(validLearningPreviewRequest({})).toBe(true);
  for (const body of [null, [], { full: true }, { path: "/private" }, { sources: ["claude"] }]) expect(validLearningPreviewRequest(body)).toBe(false);
  expect(validLearningRunRequest(request)).toBe(true); expect(validLearningRunRequest({ ...request, confirm_only: true })).toBe(true);
  expect(validLearningDiscardRequest(request)).toBe(true); expect(validLearningDiscardRequest({ ...request, confirm_only: true })).toBe(false);
  for (const body of [{ ...request, confirm_only: false }, { ...request, request_id: "../x" }, { ...request, preview_digest: "b" }, { ...request, host: "linux" }, { ...request, full: true }])
    expect(validLearningRunRequest(body)).toBe(false);
});

test("learning responses carry only counts and bind exact reviewed host and request", () => {
  const status: LearningStatus = { host: "mac", learning_api: 1, sources: ["claude", "noop"], blocked_reason: null };
  const preview: LearningPreview = { host: "mac", ...counts, sources: ["claude"], preview_digest: request.preview_digest };
  expect(readLearningStatus(status)).toEqual(status); expect(readLearningPreview(preview)).toEqual(preview); expect(readLearningRunResult(result)).toEqual(result);
  const pending: LearningPending = { ...request, ...counts, id: result.id, sources: ["claude"] };
  expect(readLearningStatus({ ...status, pending })?.pending).toEqual(pending);
  for (const unsafe of [{ ...pending, text: "private" }, { ...pending, id: "../secret" }, { ...pending, sources: ["shell"] }]) expect(readLearningStatus({ ...status, pending: unsafe })).toBeUndefined();
  for (const unsafe of [{ ...status, sources: ["shell"] }, { ...status, sources: ["claude", "claude"] }, { ...status, path: "/private" }]) expect(readLearningStatus(unsafe)).toBeUndefined();
  for (const unsafe of [{ ...preview, turns: -1 }, { ...preview, sessions: 0.5 }, { ...preview, content: "private transcript" }, { ...preview, truncated: "yes" }]) expect(readLearningPreview(unsafe)).toBeUndefined();
  const path = { host: "mac", action: "run" as const };
  expect(validLearningResult(result, path, request, 200)).toBe(true);
  for (const unsafe of [{ ...result, host: "linux" }, { ...result, request_id: "22345678-1234-4234-8234-123456789abc" }, { ...result, preview_digest: "b".repeat(64) }, { ...result, content: "private" }, { ...result, id: "../secret" }])
    expect(validLearningResult(unsafe, path, request, 200)).toBe(false);
  expect(validLearningResult({ error: "Still confirming", host: "mac", ...request, id: result.id, uncertain: true }, path, request, 503)).toBe(true);
  expect(validLearningResult({ error: "Failed", host: "linux" }, path, request, 503)).toBe(false);
  expect(validLearningResult({ error: "Failed", stack: "private" }, path, request, 500)).toBe(false);
  expect(validLearningResult(result, { host: "mac", action: "preview" }, {}, 200)).toBe(false);
  const discarded: LearningDiscardResult = { host: "mac", ...request, id: "T-mac-0001", discarded: true, replayed: false };
  expect(readLearningDiscardResult(discarded)).toEqual(discarded);
  expect(validLearningResult(discarded, path, { ...request, confirm_only: true }, 200)).toBe(true);
  expect(validLearningResult(discarded, { host: "mac", action: "discard" }, request, 200)).toBe(true);
  expect(validLearningResult(result, { host: "mac", action: "discard" }, request, 200)).toBe(false);
});
