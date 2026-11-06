import { DEFAULT_PROVIDERS, PROVIDER_IDS, providerLabel, providerOrders, type ProviderStatus, type ToolPolicy } from "../cloud/src/providers";
import { encodeAccountSegment, validMachineHost, validRunId, type ProjectFolderCheck } from "../cloud/src/machine-requests";
import { hasPendingStops, pendingStopsError, pendingStopsView, readPendingStops, readStopReviewPreview, readStopReviewAudit, validStopResolveRequest, type PendingStops, type StopOwner, type StopReviewPreview, type StopResolveRequest, type StopReviewAudit } from "../cloud/src/stop-intents";
import { ARCHIVE_KINDS, readArchiveList, readArchivePreview, readArchiveRestoreResult, type ArchiveKind, type ArchiveItem, type ArchivePreview, type ArchiveRestoreRequest, type ArchiveRestoreResult } from "../cloud/src/archives";
import { readTaskFormResult, readTaskReopenPreview, validTaskCreateRequest, validTaskReopenRequest, type TaskCreateRequest, type TaskReopenRequest, type TaskReopenPreview, type TaskFormResult, type TaskRunSettings } from "../cloud/src/task-forms";
import { machineLearningPath, readLearningStatus, readLearningPreview, type LearningStatus, type LearningPreview, type LearningRunRequest, type LearningRunResult } from "../cloud/src/learning";
import { createPendingStore, intentScope, type PendingEntry } from "./pending-intents";
import { createIntentStorage } from "./intent-storage";
import { editableDocument, documentBody } from "../cloud/src/documents";
// noop chat client: one TSX app for the web (served by the hub), macOS, Linux and phones.
// Design: the NSH gallery's (~/work/nsh/examples/gallery): its theme tokens (theme.json is the
// gallery's), its shared UI layer (nsh-gallery-ui: palette, icons, tooltips, scroll bars), its
// sidebar + toolbar layout; sized up for reading a chat all day (16 pt text, 40 pt controls).
import {
  cleanup,
  createAnimatedValue,
  colorScheme,
  computed,
  effect,
  host,
  Image,
  keymap,
  lifecycle,
  locale,
  LayoutAnimation,
  List,
  type ListRef,
  mount,
  platform,
  reduceMotion,
  safeArea,
  Scroll,
  type Signal,
  setColorScheme,
  signal,
  Storage,
  Text,
  untracked,
  Video,
  View,
  windowSize, token, openUrl, keyboardFrame, Picker, Speech, Clipboard, Notifications } from "nsh";
import fs from "fs/promises";
import type { InputRef, JSX, SpeechSession, ViewStyle } from "nsh";
import { AlertDialog, ContextMenu, Dialog, Menu, MenuItem, Input, NavPage, NavStack, NumberInput, Radio, RadioGroup, Scrollbar, TextView, createNavStack, type MarkdownExtension, type TextViewBlock, type TextViewCustomNode, type TextViewInline } from "nsh/base";
import { isAvailable as hasWindow, titleBar, Window } from "nsh/desktop";
import { checkForUpdate, downloadUpdate, installAndRestart } from "nsh/updater";
import { AUTONOMY_LEVELS, CONFIGURATION_FIELDS, CONFIGURATION_GROUPS, MACHINE_CONFIGURATION_FIELDS, validAutonomyLevel, type AutonomyLevel, type ConfigValue, type ConfigurationField } from "../cloud/src/configuration";
import { CHECK_EVERY_MS, createUpdates, type UpdateState } from "./update";
import {
  alpha,
  colors,
  Toggle,
  focusRing,
  hovered,
  Icon,
  type IconName,
  isDark,
  radius,
  scrollbarTheme,
  Spinner,
  tints,
  Tip,
} from "./ui";
import {
  answeredIds,
  choiceLabel,
  choicesOf,
  dayLabel,
  displayName,
  greeting,
  type HubEvent,
  initials,
  isAsk,
  isHub,
  isVideo,
  loadOf,
  mediaUrl,
  merge,
  normalizeUrl,
  osOf,
  recommended,
  type Attachment,
  attachProblem,
  filePath,
  imageType,
  rows,
  type Status,
  TAGS,
  timeOf,
  waiting,
  wsUrl,
  autonomyLabel,
  cliKey,
  cliLabel,
  readToolPolicy,
  readToolPolicyView,
  readAutonomyPolicy,
  learningReceipt,
  learningRelease,
  learningTaskId,
  intervalsWith,
  activityLine,
  everyLabel,
  patches,
  MEDIA_DAYS,
  mediaDaysOf,
  type SettingsView,
  settingsSnapshot,
  NOTIFY_KINDS,
  type NotifyKind,
  type NotifyPrefs,
  notifyPrefsOf,
  notifyPatch,
  QUIET_PRESETS,
  quietKey,
  firstUnread,
  type Row,
  type DataFile,
  type RuleGroup,
  RULE_PREFIXES,
  groupRules,
  stripFrontMatter,
  type HostInfo,
  type Command,
  type CommandItem,
  commandItems,
  savedCommands,
  BUILTIN_COMMANDS,
  PLAN_STATUS,
  type PlanInfo,
  type PlanStepInfo,
  type Project,
  plural,
  slashQuery,
  needsLabel,
  updateLine,
  updateSummary,
  type UpdateLine,
  isQueued,
  type TaskInfo,
} from "./hub";
import { deviceTimeZone, notificationTimeZone, notificationFor, type NotifyRules } from "./notify";

type Config = { url: string; token: string };
/** `token` holds the login session (sent as `Bearer`, and `?token=` on the WebSocket and media URLs). */
const KEYS = { url: "hub.url", token: "hub.token", email: "hub.email", theme: "hub.theme", seen: "hub.lastSeen", notifyOff: "hub.notifyOff", draft: "hub.draft" };
const touch = !(platform.idiom === "desktop" || platform.idiom === "mac");
/** iOS and Android draw the pages' headers (title, back, swipe back); the desktops and the web show the app's. */
const systemHeader = platform.os === "ios" || platform.os === "android";
const MONO = "monospace";

/** Sizes: the gallery's proportions, a step larger (the owner reads this all day). */
const size = {
  text: 17,
  line: 26,
  small: 15,
  tiny: 13,
  control: touch ? 44 : 38,
  row: touch ? 44 : 34,
  bar: touch ? 56 : 52,
  sidebar: 288,
  column: 880,
};

// ---------------------------------------------------------------- settings & connection

type Page = { origin?: string; theme?: string | null; ref?: string | null };

/** A function of the page's host (host.js on the web: push, badge, ...); null where there is none or it failed. */
async function hostCall<T>(name: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    if (!host.available()) return null;
    return ((await host.call(name, args ?? {})) ?? null) as T | null;
  } catch {
    return null;
  }
}

/** Where the app was served from on the web (nsh.json `web.host`); nothing elsewhere. */
async function pageInfo(): Promise<Page> {
  try {
    if (!host.available()) return {};
    return ((await host.call("page")) ?? {}) as Page;
  } catch {
    return {};
  }
}

type Boot = { config: Config | null; suggested: string; served: boolean; email: string; ref: string | null };

async function loadConfig(): Promise<Boot> {
  const page = await pageInfo();
  if (page.theme === "light" || page.theme === "dark") setColorScheme(page.theme);
  else {
    const saved = await Storage.getItem(KEYS.theme);
    if (saved === "light" || saved === "dark") setColorScheme(saved);
  }
  let url = (await Storage.getItem(KEYS.url)) ?? "";
  const token = (await Storage.getItem(KEYS.token)) ?? "";
  if (!url && page.origin) url = page.origin;
  const suggested = url || page.origin || "";
  const email = (await Storage.getItem(KEYS.email)) ?? "";
  return { config: url && token ? { url: normalizeUrl(url), token } : null, suggested, served: !!page.origin, email, ref: page.ref ?? null };
}

type Conn = "connecting" | "live" | "offline" | "unauthorized";

/** Failed reconnects in a row before the owner hears about it; anything shorter recovers silently. */
const OFFLINE_AFTER = 5;
const newRequestKey = () => `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function createHub(cfg: Config) {
  const events = signal<HubEvent[]>([]);
  const status = signal<Status | null>(null);
  const conn = signal<Conn>("connecting");
  const loaded = signal(false);
  const headers = { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" };
  let disposed = false;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  const last = () => {
    const evs = untracked(events);
    return evs.length ? evs[evs.length - 1].ts : "";
  };

  async function loadFeed() {
    const since = last();
    try {
      const r = await fetch(`${cfg.url}/api/feed${since ? `?since=${encodeURIComponent(since)}` : ""}`, { headers });
      if (r.status === 401) return conn.set("unauthorized");
      const body = (await r.json()) as { events: HubEvent[] };
      events.update((evs) => merge(evs, body.events));
    } catch {
      /* the socket's retries decide when this counts as offline */
    } finally {
      loaded.set(true);
    }
  }

  async function loadStatus() {
    try {
      const r = await fetch(`${cfg.url}/api/status`, { headers });
      if (r.ok) status.set((await r.json()) as Status);
    } catch {
      /* the feed reports the connection */
    }
  }

  function stream() {
    if (disposed || untracked(conn) === "unauthorized") return;
    const ws = new WebSocket(wsUrl(cfg.url, cfg.token));
    socket = ws;
    ws.onopen = () => {
      failures = 0;
      conn.set("live");
    };
    ws.onmessage = (m: { data: unknown }) => {
      try {
        events.update((evs) => merge(evs, [JSON.parse(String(m.data)) as HubEvent]));
      } catch {
        return;
      }
      loadStatus();
    };
    ws.onclose = () => {
      if (disposed) return;
      if (++failures >= OFFLINE_AFTER && untracked(conn) !== "unauthorized") conn.set("offline");
      retry = setTimeout(async () => {
        await loadFeed();
        stream();
      }, 3000);
    };
  }

  /** Uploads one image the owner attaches; resolves with its media path ("/media/…"). */
  async function upload(a: Attachment): Promise<string> {
    const fd = new FormData();
    fd.append("file", a.file, a.name);
    const r = await fetch(`${cfg.url}/api/uploads`, { method: "POST", headers: { Authorization: headers.Authorization }, body: fd });
    if (r.status === 401) conn.set("unauthorized");
    if (!r.ok) throw new Error(`Image upload failed (${r.status})`);
    return ((await r.json()) as { url: string }).url;
  }

  const pendingMessages = new Map<string, string>(), messageUploads = new Map<string, string[]>();
  const stopReviews = signal(new Map<string, { intent: StopReviewIntent; preview?: StopReviewPreview }>());
  const taskDrafts = new Map<string, Signal<string>>();
  const archiveRestores = signal(new Map<string, { request: ArchiveRestoreRequest; preview: ArchivePreview }>());
  const taskForms = signal(new Map<string, TaskFormState>());
  const savedEntries = signal<PendingEntry[]>([]), savedReady = signal(false), savedLoading = signal(false), savedError = signal("");
  const scope = intentScope(cfg.url, cfg.token), pendingStore = createPendingStore(createIntentStorage(scope), scope);
  const savedAt = (kind: PendingEntry["kind"], key: string) => savedEntries().find((entry) => entry.kind === kind && entry.key === key)?.at ?? new Date().toISOString();
  function restorePending(entries: PendingEntry[]) {
    const tasks = new Map(taskForms()), archives = new Map(archiveRestores()), stops = new Map(stopReviews());
    const retained = (kind: PendingEntry["kind"], key: string, id: string) => entries.some((entry) => entry.kind === kind && entry.key === key && entry.request.request_id === id);
    for (const [key, state] of tasks) if (state.pending() && !retained("task", key, state.pending()!.request_id)) clearTaskRequest(state, key);
    for (const [key, state] of archives) if (!retained("archive", key, state.request.request_id)) archives.delete(key);
    for (const [key, state] of stops) if (!retained("stop", key, state.intent.request_id)) stops.delete(key);
    for (const entry of entries) {
      // Requests discovered during a reload stay in Saved requests without replacing an open unsent draft.
      if (savedReady() && !(entry.kind === "task" ? tasks.get(entry.key)?.pending() : entry.kind === "archive" ? archives.has(entry.key) : stops.has(entry.key))) continue;
      if (entry.kind === "task") {
        const previous = tasks.get(entry.key);
        const state = previous ?? newTaskFormState();
        if (!previous?.pending() || previous.pending()!.request_id !== entry.request.request_id) {
          fillTaskRunDraft(state.draft, entry.request.settings); state.instructions.set(entry.request.instructions);
          state.preview.set(entry.preview); state.pending.set(entry.request); state.result.set(undefined); state.initialized = true;
        }
        if (entry.known_id || "id" in entry.request) state.knownId.set(entry.known_id ?? (entry.request as TaskReopenRequest).id);
        tasks.set(entry.key, state);
      } else if (entry.kind === "archive") {
        if (archives.get(entry.key)?.request.request_id !== entry.request.request_id) archives.set(entry.key, { request: entry.request, preview: entry.preview });
      } else if (entry.kind === "stop" && stops.get(entry.key)?.intent.request_id !== entry.request.request_id) stops.set(entry.key, { intent: entry.request, preview: entry.preview });
    }
    taskForms.set(tasks); archiveRestores.set(archives); stopReviews.set(stops);
  }
  async function reloadSaved() {
    if (savedLoading() || disposed) return false;
    savedLoading.set(true);
    try {
      const entries = await pendingStore.load();
      if (disposed) return false;
      savedEntries.set(entries); restorePending(entries); savedError.set(""); return true;
    } catch (error) { if (!disposed) savedError.set(String((error as Error).message ?? error)); return false; }
    finally { savedLoading.set(false); savedReady.set(true); }
  }
  async function keepPending(entry: PendingEntry) {
    if (disposed || !savedReady() || savedLoading()) return false;
    try {
      await pendingStore.put(entry);
      if (disposed) return false;
      savedEntries.set(pendingStore.entries()); savedError.set(""); return true;
    } catch (error) { savedError.set(String((error as Error).message ?? error)); return false; }
  }
  async function dropPending(kind: PendingEntry["kind"], key: string, requestId: string) {
    if (disposed || savedLoading()) return false;
    try {
      await pendingStore.remove(kind, key, requestId);
      if (disposed) return false;
      savedEntries.set(pendingStore.entries()); savedError.set(""); return true;
    } catch (error) { savedError.set(String((error as Error).message ?? error)); return false; }
  }
  async function resetSaved() {
    if (disposed || savedLoading()) return false;
    savedLoading.set(true);
    try {
      await pendingStore.reset();
      if (disposed) return false;
      for (const [key, state] of taskForms()) if (state.pending()) clearTaskRequest(state, key);
      archiveRestores.set(new Map()); stopReviews.set(new Map()); savedEntries.set([]); savedError.set(""); return true;
    } catch (error) { savedError.set(String((error as Error).message ?? error)); return false; }
    finally { savedLoading.set(false); savedReady.set(true); }
  }
  async function send(text: string, replyTo: string | null, files: Attachment[] = [], thread = false, messageKey?: string) {
    const intent = JSON.stringify([text, replyTo, thread, files.map((file) => file.name)]);
    const key = messageKey ?? pendingMessages.get(intent) ?? newRequestKey();
    pendingMessages.set(intent, key);
    const attachments = messageUploads.get(key) ?? [];
    messageUploads.set(key, attachments);
    for (let index = attachments.length; index < files.length; index++) attachments.push(await upload(files[index]!));
    const r = await fetch(`${cfg.url}/api/messages`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": key },
      body: JSON.stringify({ text, ...(replyTo ? { reply_to: replyTo } : {}), ...(attachments.length ? { attachments } : {}), ...(thread ? { thread } : {}) }),
    });
    if (r.status === 401) conn.set("unauthorized");
    const raw = await r.json().catch(() => null);
    const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    if (!r.ok) throw Object.assign(new Error(String(data.error ?? `Send failed (${r.status})`)), {
      saved_locally: data.saved_locally === true,
      id: typeof data.id === "string" && /^(?:T-[A-Z]?\d{4,}|PL-[A-Z]?\d+)$/.test(data.id) ? data.id : undefined,
    });
    if (typeof data.id !== "string" || !data.id || typeof data.ts !== "string" || data.from !== "owner" || data.kind !== "owner" || typeof data.text !== "string")
      throw new Error("Couldn't confirm delivery. Retry to check the same request.");
    if (pendingMessages.get(intent) === key) pendingMessages.delete(intent);
    messageUploads.delete(key);
    const ev = data as unknown as HubEvent;
    events.update((evs) => merge(evs, [ev]));
    loadStatus();
  }

  async function settings(patch?: Record<string, unknown>, requestKey?: string): Promise<SettingsView> {
    const r = await api(patch ? "PUT" : "GET", "/api/settings", patch, requestKey);
    if (!r.ok) throw new Error(String(r.data.error ?? `Couldn't ${patch ? "save" : "load"} settings (${r.status})`));
    if (!settingsSnapshot(r.data)) throw new Error("Connect the main machine to load team settings, then reopen Settings.");
    return r.data;
  }

  /** A JSON call of the hub's API: never throws (status 0 when unreachable); a 401 ends the session. */
  const formTickets = new Map<string, string>();
  const learningAttempts = new Map<string, string>();
  const controlKeys = new Map<string, string>();
  const discardPolicyConfirmation = (patch: Record<string, unknown>, requestKey: string) => {
    if (patch.tool_policy_version === 1 || patch.autonomy_policy_version === 1) formTickets.delete(JSON.stringify(["PUT", "/api/settings", patch, requestKey]));
  };
  function learningRun(host: string, request: LearningRunRequest, discard = false) {
    const path = `/api/machines/${encodeURIComponent(host)}/learning/${discard ? "discard" : "run"}`, identity = JSON.stringify(["POST", path, request]);
    const previous = learningAttempts.get(identity);
    if (previous) formTickets.delete(JSON.stringify(["POST", path, request, previous]));
    const key = newRequestKey(); learningAttempts.set(identity, key);
    return api("POST", path, request, key);
  }
  async function api(method: string, path: string, body?: unknown, requestKey?: string): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
    if (disposed) return { ok: false, status: 0, data: { error: "This connection was closed. Open the saved request after reconnecting." } };
    const machine = /^\/api\/machines\/[^/]+\/(?:accounts(?:\/|$)|project-folder-check$|learning(?:\/|$))/.test(path) || path.startsWith("/api/machine-requests/");
    const keyBody = machine && path.endsWith("/code") ? { id: (body as { id?: string } | undefined)?.id } : body;
    const key = JSON.stringify(requestKey ? [method, path, keyBody, requestKey] : [method, path, keyBody]);
    let ticket = formTickets.get(key);
    const controlKey = method === "POST" && path === "/api/tasks/cancel" ? requestKey ?? controlKeys.get(key) ?? newRequestKey() : undefined;
    if (controlKey) controlKeys.set(key, controlKey);
    const confirmation = machine ? "/api/machine-requests/" : "/api/ui-requests/";
    const pendingNote = (error: string) => ({ error, pending: !!ticket, ...(machine && ticket ? { confirmation: `${confirmation}${ticket}` } : {}) });
    try {
      for (let attempt = 0; attempt < 30; attempt++) {
        if (disposed) return { ok: false, status: 0, data: { error: "This connection was closed. Check the saved request after reconnecting." } };
        const r = ticket
          ? await fetch(`${cfg.url}${confirmation}${ticket}`, { headers })
          : await fetch(`${cfg.url}${path}`, method === "GET" ? { headers } : { method, headers: { ...headers, ...(controlKey ? { "Idempotency-Key": controlKey } : {}) }, body: JSON.stringify(body ?? {}) });
        if (r.status === 401) conn.set("unauthorized");
        let data: Record<string, unknown> = {};
        try { data = ((await r.json()) ?? {}) as Record<string, unknown>; } catch { /* no body */ }
        if (ticket && r.status >= 500 && r.headers.get("X-Noop-Confirmed") !== "1")
          return { ok: false, status: r.status, data: pendingNote(machine ? "Connection lost while confirming. Try again to check the same request." : "Connection lost while confirming. Try saving again to check the same request.") };
        if (r.status !== 202 || typeof data.ticket !== "string" || !/^[a-f0-9-]{36}$/.test(data.ticket)) {
          const learning = machineLearningPath(path);
          if (method === "POST" && (learning?.action === "run" || learning?.action === "discard") && r.ok) {
            const entry = savedEntries().find((e) => e.kind === "learning" && e.key === learning.host && e.request.request_id === (body as { request_id?: string })?.request_id);
            if (entry?.kind !== "learning" || !(learning.action === "run" && learningReceipt(data, entry.key, entry.request, entry.preview, entry.known_id) || learningRelease(data, entry.key, entry.request, entry.known_id)))
              return { ok: false, status: 502, data: { ...pendingNote("Couldn't confirm this learning run. Check the saved run before authorizing another one."), uncertain: true } };
          }
          const policyKind = (body as { tool_policy_version?: number })?.tool_policy_version === 1 ? "tools" : (body as { autonomy_policy_version?: number })?.autonomy_policy_version === 1 ? "autonomy" : undefined;
          if (method === "PUT" && path === "/api/settings" && policyKind && r.ok) {
            const requested = (body as Record<string, { preference?: string[] | null; agents?: Record<string, string[] | AutonomyLevel | null>; reset?: string[] }>)[policyKind === "tools" ? "clis" : "autonomy"]!;
            const reset = requested.reset?.[0], agent = reset?.startsWith("agents.") ? reset.slice(7) : Object.keys(requested.agents ?? {})[0];
            const snapshot = settingsSnapshot(data) ? data : undefined, capability = readToolPolicyView(snapshot?.effective.tool_policy);
            const member = snapshot?.effective.agents.find((a) => a.id === agent);
            const policy = policyKind === "tools" ? agent ? capability && readToolPolicy(member?.tool_policy) : capability?.team
              : snapshot?.effective.autonomy_policy_version === 1 ? readAutonomyPolicy(member?.autonomy_policy) : null;
            const wanted = reset ? policy?.file_default : agent ? requested.agents?.[agent] : requested.preference;
            const matches = policy && !policy.invalid && (reset ? policy.source !== "ui" : policy.source === "ui")
              && JSON.stringify(policy.configured) === JSON.stringify(wanted)
              && (policyKind !== "autonomy" || policy.configured !== null || policy.effective === snapshot?.effective.autonomy);
            if (!matches) return { ok: false, status: 502, data: pendingNote(`Couldn't confirm this ${policyKind === "tools" ? "task tool" : "member autonomy"} setting. Retry the same selection or reopen Settings to reload confirmed policy.`) };
          }
          if (method === "POST" && path === "/api/tasks/cancel" && r.ok) {
            const control = body as { id: string; done?: boolean; run_id?: string };
            if (r.status !== 200 || data.ok !== true || data.id !== control.id || data.result !== (control.done ? "done" : "cancelled") || control.run_id !== undefined && data.run_id !== control.run_id)
              return { ok: false, status: 502, data: { ...pendingNote("Could not confirm this task change. Check the same request before trying another run."), uncertain: true } };
          }
          if (method === "POST" && /^\/api\/plans\/[^/]+\/cancel$/.test(path) && r.ok) {
            const plan = data.plan as PlanInfo | undefined, cleanup = data.cleanup as { remaining?: unknown; pending?: unknown; unresolved?: unknown } | undefined;
            if (r.status !== 200 || data.ok !== true || data.id !== path.split("/")[3] || plan?.id !== data.id || plan?.status !== "cancelled" || hasPendingStops(plan?.pending_stops)
              || cleanup?.remaining !== 0 || !Array.isArray(cleanup.pending) || cleanup.pending.length || !Array.isArray(cleanup.unresolved) || cleanup.unresolved.length)
              return { ok: false, status: 502, data: { ...pendingNote("Couldn't confirm this plan cancellation. Update the main machine and refresh its progress."), uncertain: true } };
          }
          if (method === "POST" && (path === "/api/tasks/stops/retry" || /^\/api\/plans\/[^/]+\/retry-stops$/.test(path)) && r.ok) {
            const cleanup = data.cleanup as { operation_id?: unknown; remaining?: unknown; pending?: unknown; unresolved?: unknown } | undefined;
            const requested = body as { id?: string; operation_id: string };
            const ownerId = requested.id ?? path.split("/")[3], owner = (requested.id ? data.task : data.plan) as (TaskInfo & PlanInfo) | undefined;
            if (r.status !== 200 || data.ok !== true || data.id !== ownerId || owner?.id !== ownerId || cleanup?.operation_id !== requested.operation_id
              || (requested.id ? !["done", "cancelled", "failed"].includes(owner?.state ?? "") || hasPendingStops(owner?.stops) || !!owner?.stops_error : owner?.status !== "cancelled" || hasPendingStops(owner?.pending_stops))
              || cleanup.remaining !== 0 || !Array.isArray(cleanup.pending) || cleanup.pending.length || !Array.isArray(cleanup.unresolved) || cleanup.unresolved.length)
              return { ok: false, status: 502, data: pendingNote("Couldn't confirm cleanup. Retry to check the same cleanup request.") };
          }
          if (method === "POST" && path === "/api/stops/resolve" && r.ok) {
            const requested = body as StopReviewIntent, review = readStopReviewAudit(data.review), cleanup = data.cleanup as { operation_id?: unknown; remaining?: unknown; pending?: unknown; unresolved?: unknown } | undefined;
            const owner = (requested.owner.kind === "task" ? data.task : data.plan) as { id?: unknown } | undefined;
            if (r.status !== 200 || data.ok !== true || data.id !== requested.owner.id || data.operation_id !== requested.operation_id || data.request_id !== requested.request_id
              || data.review_id !== requested.request_id || data.target_id !== requested.target_id || data.action !== requested.action || owner?.id !== requested.owner.id
              || (data.owner as StopOwner | undefined)?.kind !== requested.owner.kind || (data.owner as StopOwner | undefined)?.id !== requested.owner.id
              || !review || review.owner?.kind !== requested.owner.kind || review.owner.id !== requested.owner.id || review.operation_id !== requested.operation_id || review.request_id !== requested.request_id
              || review.target_id !== requested.target_id || review.action !== requested.action || review.reason !== requested.reason || review.preview_digest !== requested.preview_digest || review.review_id !== data.review_id
              || cleanup?.operation_id !== requested.operation_id || !Number.isInteger(cleanup.remaining) || !Array.isArray(cleanup.pending) || !Array.isArray(cleanup.unresolved)
              || cleanup.remaining !== cleanup.pending.length + cleanup.unresolved.length
              || !readPendingStops({ operation_id: requested.operation_id, requested_at: review.at, done: false, pending: cleanup.pending, unresolved: cleanup.unresolved }))
              return { ok: false, status: 502, data: { ...pendingNote("Couldn't confirm this cleanup review. Retry the same decision before making another choice."), uncertain: true } };
          }
          if (method === "POST" && path === "/api/archive/restore" && r.ok) {
            const requested = body as ArchiveRestoreRequest, result = readArchiveRestoreResult(data), cached = savedEntries().find((entry) => entry.kind === "archive" && entry.key === requested.key);
            const expected = archiveRestores().get(requested.key)?.preview.entry ?? (cached?.kind === "archive" ? cached.preview.entry : undefined);
            if (r.status !== 200 || data.ok !== true || !result || result.key !== requested.key || result.digest !== requested.digest || result.request_id !== requested.request_id
              || expected && (result.kind !== expected.kind || result.id !== expected.id))
              return { ok: false, status: 502, data: { ...pendingNote("Couldn't confirm this restoration. Check the saved restore before starting another request."), uncertain: true } };
          }
          if (method === "POST" && ["/api/tasks/create", "/api/tasks/reopen"].includes(path) && r.ok) {
            const requested = body as TaskCreateRequest | TaskReopenRequest, result = readTaskFormResult(data), action = path.endsWith("/create") ? "create" : "reopen";
            const cached = savedEntries().find((entry) => entry.kind === "task" && entry.request.request_id === requested.request_id), expectedId = cached?.kind === "task" ? cached.known_id : undefined;
            if (r.status !== 200 || data.ok !== true || !result || result.action !== action || result.request_id !== requested.request_id
              || "id" in requested && result.id !== requested.id || expectedId && result.id !== expectedId)
              return { ok: false, status: 502, data: { ...pendingNote("Couldn't confirm this task request. Check the same request before starting another one."), uncertain: true } };
          }
          if (controlKey && !r.ok && (data.uncertain === true || data.saved_locally === true))
            return { ok: false, status: r.status, data: { ...data, pending: true } };
          formTickets.delete(key);
          controlKeys.delete(key);
          if (ticket) for (const [pendingKey, pendingTicket] of formTickets) if (pendingTicket === ticket) { formTickets.delete(pendingKey); controlKeys.delete(pendingKey); }
          return { ok: r.ok, status: r.status, data };
        }
        ticket = data.ticket;
        formTickets.set(key, ticket);
        if (attempt > 0) await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      }
      return { ok: false, status: 202, data: pendingNote(`Still waiting for ${machine ? "the selected machine" : "the main machine"} to confirm. Try again to check the same request; it will not be submitted twice.`) };
    } catch {
      return { ok: false, status: 0, data: pendingNote(ticket ? "Connection lost while confirming. Try again to check the same request." : "Couldn't reach the server") };
    }
  }

  async function logout() {
    try {
      await fetch(`${cfg.url}/api/auth/logout`, { method: "POST", headers });
    } catch {
      /* forgotten locally either way */
    }
  }

  void reloadSaved();
  loadFeed().then(stream);
  loadStatus();
  const timer = setInterval(loadStatus, 15000);
  const dispose = () => {
    disposed = true;
    clearInterval(timer);
    clearTimeout(retry);
    socket?.close();
  };
  return { events, status, conn, loaded, send, settings, api, learningRun, discardPolicyConfirmation, stopReviews, taskDrafts, archiveRestores, taskForms, savedEntries, savedReady, savedLoading, savedError, savedAt, reloadSaved, keepPending, dropPending, resetSaved, refreshStatus: loadStatus, logout, dispose, cfg };
}
type Hub = ReturnType<typeof createHub>;

function toggleTheme() {
  const next = colorScheme() === "dark" ? "light" : "dark";
  setColorScheme(next);
  Storage.setItem(KEYS.theme, next);
}

// ---------------------------------------------------------------- small pieces (the gallery's idioms)

/** A key as a small badge: `1`, `Enter`, `⌘K`. */
function Kbd(props: { k: string; on?: string }) {
  return (
    <View
      style={{
        minWidth: 22,
        height: 22,
        paddingHorizontal: 6,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 5,
        borderWidth: 1,
        borderColor: props.on ? alpha(props.on, 0.35) : colors.border,
        backgroundColor: props.on ? "transparent" : colors.raised,
      }}
    >
      <Text style={{ fontSize: 12.5, fontWeight: "500", color: props.on ?? colors.muted, fontVariant: ["tabular-nums"] }}>{props.k}</Text>
    </View>
  );
}

/** A quiet icon button of the toolbars and the sidebar (the gallery's ToolButton, at 36 pt). */
function ToolButton(props: { icon: IconName; label: string; shortcut?: string; on?: boolean; onPress: () => void; testID?: string; noTooltip?: boolean; compact?: boolean }) {
  return (
    <View
      onPress={props.onPress}
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={props.on === undefined ? undefined : { selected: props.on }}
      tooltip={props.noTooltip ? undefined : <Tip label={props.label} shortcut={props.shortcut} />}
      hoverStyle={hovered()}
      activeStyle={{ backgroundColor: alpha(colors.text, 0.09) }}
      focusStyle={focusRing()}
      style={{ width: touch ? 44 : 32, height: touch ? 44 : 32, alignItems: "center", justifyContent: "center", borderRadius: radius.control, borderCurve: "continuous", borderWidth: 1, borderColor: "transparent" }}
    >
      <Icon name={props.icon} size={18} tint={props.on ? colors.accent : colors.muted} />
    </View>
  );
}

type BtnKind = "primary" | "secondary" | "ghost" | "dashed" | "danger";

/** Shared edge for controls and grouped settings surfaces. */
const surfaceEdge = () => colors.line;

/** A labelled button: the gallery's raised / accent-filled look, 38 pt (44 on touch). */
function Btn(props: {
  label: string;
  kind?: BtnKind;
  icon?: IconName;
  kbd?: string;
  note?: string;
  busy?: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID?: string;
  accessibilityLabel?: string;
  grow?: boolean;
}) {
  const kind = () => props.kind ?? "secondary";
  const fg = () => (kind() === "primary" ? colors.onAccent : kind() === "danger" ? colors.danger : kind() === "dashed" || kind() === "ghost" ? colors.muted : colors.text);
  const look = (): ViewStyle =>
    kind() === "primary"
      ? { backgroundColor: colors.accentFill, borderColor: "transparent" }
      : kind() === "danger"
        ? { backgroundColor: tints.danger, borderColor: alpha(colors.danger, 0.3) }
        : kind() === "ghost"
          ? { backgroundColor: "transparent", borderColor: "transparent" }
          : kind() === "dashed"
            ? { backgroundColor: "transparent", borderColor: colors.fieldBorder, borderStyle: "dashed" }
            : { backgroundColor: colors.surface, borderColor: surfaceEdge() };
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ disabled: !!props.disabled }}
      onPress={() => !props.disabled && !props.busy && props.onPress()}
      hoverStyle={props.disabled ? undefined : kind() === "primary" ? { opacity: 0.92 } : hovered()}
      activeStyle={props.disabled ? undefined : kind() === "primary" ? { opacity: 0.85 } : { backgroundColor: alpha(colors.text, 0.09) }}
      focusStyle={focusRing()}
      style={{
        minHeight: size.control,
        maxWidth: "100%",
        flexShrink: 1,
        flexGrow: props.grow ? 1 : 0,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        paddingHorizontal: 14,
        paddingVertical: 6,
        borderRadius: radius.control,
        borderCurve: "continuous",
        borderWidth: 0.5,
        opacity: props.disabled ? 0.45 : 1,
        transitionProperty: "background-color, border-color, opacity",
        transitionDuration: 120,
        ...look(),
      }}
    >
      <If when={props.kbd}>
        <Kbd k={props.kbd!} on={kind() === "primary" ? colors.onAccent : undefined} />
      </If>
      <If when={props.busy}>
        <Spinner size={14} tint={fg()} />
      </If>
      <If when={!props.busy && props.icon}>
        <Icon name={props.icon!} size={16} tint={fg()} />
      </If>
      <Text style={{ flexShrink: 1, textAlign: "center", fontSize: 15, lineHeight: 21, fontWeight: kind() === "primary" ? "600" : "500", color: fg() }}>{props.label}</Text>
      <If when={props.note}>
        <Text style={{ fontSize: size.tiny, color: kind() === "primary" ? alpha(colors.onAccent, 0.7) : colors.faint }}>{props.note}</Text>
      </If>
    </View>
  );
}

/**
 * A floating surface, for the composer and the sidebar: Apple's Liquid Glass where it is drawn (iOS 26, macOS 26), a
 * blur elsewhere. Linux and Android before 12 draw no backdrop, so they stay opaque there, or what is behind would show
 * through the text on it.
 */
const glass = (tint: string, cornerRadius: number): ViewStyle => ({
  borderRadius: cornerRadius,
  borderCurve: "continuous",
  borderWidth: 1,
  borderColor: alpha(colors.text, 0.1),
  boxShadow: "0 8px 28px rgba(0,0,0,0.1)",
  ...(platform.os === "linux" || (platform.os === "android" && Number(platform.version) < 31)
    ? { backgroundColor: tint }
    : { backgroundColor: alpha(tint, 0.55), glassEffect: "regular" as const, backdropFilter: "blur(20px)" }),
});

/** The floating surface of a message composer, which the conversation scrolls under. */
const composerGlass = (active = false): ViewStyle => ({
  ...glass(colors.field, 24),
  ...(platform.os === "ios" ? { backgroundColor: alpha(colors.field, 0.25) } : {}),
  boxShadow: "0 4px 16px rgba(0,0,0,0.06)",
  borderWidth: platform.os === "ios" || platform.os === "macos" ? 0 : 1,
  borderColor: alpha(colors.text, active ? 0.22 : 0.1),
  transitionProperty: "border-color",
  transitionDuration: 120,
});

/** Links use a quiet, underlined accent shared by the app's themes. */
const linkColor = () => token("link");

/** The icon-only send button of a message composer: a circle, the same size and icon scale as the voice button beside it. */
function SendButton(props: { disabled: boolean; onPress: () => void; testID: string }) {
  return (
    <View
      testID={props.testID}
      role="button"
      accessibilityLabel="Send"
      accessibilityState={{ disabled: props.disabled }}
      onPress={() => !props.disabled && props.onPress()}
      tooltip={touch ? undefined : <Tip label="Send" shortcut="Enter" />}
      hoverStyle={props.disabled ? undefined : { opacity: 0.9 }}
      style={{
        width: touch ? 44 : 36,
        height: touch ? 44 : 36,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: touch ? 22 : 18,
      }}
    >
      <View style={{ width: touch ? 32 : 28, height: touch ? 32 : 28, borderRadius: touch ? 16 : 14, alignItems: "center", justifyContent: "center", backgroundColor: colors.accentFill }}>
        <Icon name="arrow-up" size={touch ? 18 : 16} tint={colors.onAccent} />
      </View>
    </View>
  );
}

function Dot(props: { tone: "on" | "run" | "queue" | "wait" | "off" | "bad" }) {
  const color = () => ({ on: colors.up, run: colors.up, queue: colors.info, wait: colors.warn, off: colors.faint, bad: colors.danger })[props.tone];
  return <View style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, backgroundColor: color() }} />;
}

/** A tag in the gallery's Badge style: a tone's tint behind its color. */
function Badge(props: { label: string; tone?: "accent" | "warn" | "info" | "neutral" | "danger" }) {
  const tone = props.tone ?? "neutral";
  const fg = () => (tone === "neutral" ? colors.muted : tone === "accent" ? colors.accent : colors[tone]);
  const bg = () => (tone === "neutral" ? colors.raised : tints[tone]);
  return (
    <View style={{ height: 22, paddingHorizontal: 8, justifyContent: "center", borderRadius: 6, backgroundColor: bg() }}>
      <Text style={{ fontSize: 12.5, fontWeight: "600", color: fg() }}>{props.label}</Text>
    </View>
  );
}

/** The app's mark: a dark square with a live dot (the hub). */
function Mark(props: { size?: number }) {
  const s = props.size ?? 24;
  return (
    <View style={{ width: s, height: s, borderRadius: s * 0.28, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: s * 0.38, height: s * 0.38, borderRadius: s, backgroundColor: colors.surface }} />
    </View>
  );
}

/** Opens a task's page from a T-0000 in any text (set by the channel). */
let taskLink: (id: string) => void = () => {};
let planLink: (id: string) => void = () => {};

/** A task's state from the hub's status (set by the channel), for the chips' dots. */
let taskState: (id: string) => string | undefined = () => undefined;

/** The app's syntax in messages (`extensions`, `pattern`): task ids and decision / proposal ids, shown by `renderCustom`. */
const EXTENSIONS: MarkdownExtension[] = [
  // ids minted on a non-primary host carry its letter (T-M0001, D-H0002)
  { name: "task", pattern: "\\bT-[A-Z]?\\d{4}\\b" },
  { name: "item", pattern: "\\b[DP]-[A-Z]?\\d{4}\\b" },
  { name: "plan", pattern: "\\bPL-[A-Z]?\\d{4}\\b" },
];
const GH = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)\/?$/;

/** A bare GitHub PR or issue link reads as "nsh#747": still a plain link, not a chip (GFM autolinks bare URLs). */
function ghInlines(inlines: TextViewInline[]): TextViewInline[] {
  return inlines.map((i): TextViewInline => {
    if (i.type === "link") {
      const m = i.url.match(GH);
      const bare = i.content.length === 1 && i.content[0].type === "text" && i.content[0].text.replace(/\/$/, "") === i.url.replace(/\/$/, "");
      return m && bare ? { ...i, content: [{ type: "text", text: `${m[2]}#${m[4]}` }] } : i;
    }
    return "content" in i && Array.isArray(i.content) ? ({ ...i, content: ghInlines(i.content) } as TextViewInline) : i;
  });
}
function ghBlocks(blocks: TextViewBlock[]): TextViewBlock[] {
  return blocks.map((b): TextViewBlock => {
    const x = { ...b } as Record<string, unknown>;
    if (Array.isArray(x.content)) x.content = ghInlines(x.content as TextViewInline[]);
    if (Array.isArray(x.children)) x.children = ghBlocks(x.children as TextViewBlock[]);
    if (Array.isArray(x.items)) x.items = (x.items as { children: TextViewBlock[] }[]).map((it) => ({ ...it, children: ghBlocks(it.children) }));
    return x as TextViewBlock;
  });
}

/** Repositories the channel has linked so far, by name ("nsh" → "longbridge/nsh"; set by the channel). */
let knownRepos: () => Map<string, string> = () => new Map();

/** Every repository a GitHub link in `text` names, by lower-cased name. */
function reposIn(text: string, into = new Map<string, string>()): Map<string, string> {
  for (const m of text.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/\d+/g)) into.set(m[2].toLowerCase(), `${m[1]}/${m[2]}`);
  return into;
}

const REF = /(^|[^\w\/\[#&])(?:([A-Za-z][\w.-]*)( ?))?#(\d+)\b/g;

/**
 * A "#746" is a GitHub PR or issue: "nsh #747" / "NSH#747" links to that repository when the channel has linked it
 * before; a bare "#747" to the one repository the message, or what it is about (`context`: a card's options, the
 * thread it belongs to), names. Code spans are left alone.
 */
function linkRepoRefs(text: string, context = ""): string {
  const known = reposIn(`${text}\n${context}`, new Map(knownRepos()));
  if (!known.size) return text;
  // the repositories in play: linked ones, and "name#N" naming a known one
  const named = new Set<string>([...reposIn(`${text}\n${context}`).values()]);
  for (const m of `${text}\n${context}`.matchAll(REF)) {
    const slug = m[2] && known.get(m[2].toLowerCase());
    if (slug) named.add(slug);
  }
  const only = named.size === 1 ? [...named][0] : null;
  const url = (slug: string, n: string) => `https://github.com/${slug}/issues/${n}`;
  return text.split(/(`[^`\n]*`)/).map((part, i) => (i % 2 ? part : part.replace(
    REF,
    (all, pre: string, name: string | undefined, sp: string, n: string) => {
      const slug = name && known.get(name.toLowerCase());
      if (slug) return `${pre}[${name}${sp}#${n}](${url(slug, n)})`;
      if (!only || (name && !sp && !/^(pr|issue)s?$/i.test(name))) return all;
      return `${pre}${name ? name + sp : ""}[#${n}](${url(only, n)})`;
    },
  ))).join("");
}

/** Hub text keeps its line breaks: single newlines become hard breaks, outside code fences. */
function hubMarkdown(text: string): string {
  return text
    .split(/(^```[\s\S]*?^```)/m)
    .map((part, i) => (i % 2 ? part : part
      // single newlines are hard breaks, except around list items (a "\\" there shows up literally)
      .replace(/([^\n])\n(?!\n|\s*(?:[-*+]|\d+[.)])\s)/g, (m0, c, off, all) => /^\s*(?:[-*+]|\d+[.)])\s/.test(all.slice(all.lastIndexOf("\n", off) + 1, off + 1)) ? `${c}\n` : `${c}\\\n`)
      // Bare URLs stop at CJK / full-width punctuation and spaces (so "pull/1" inside a Chinese sentence links pull/1 only).
      .replace(/(?<![(<\[`])\bhttps?:\/\/[^\s<>()\[\]`\u3000-\u303f\uff00-\uffef\u2018-\u201f\u4e00-\u9fff]+[^\s<>()\[\]`.,;:!?'"\u3000-\u303f\uff00-\uffef\u2018-\u201f\u4e00-\u9fff]/g, "<$&>")))
    .join("");
}

/** Texts inside a pressable chip: a pointer, not the I-beam selectable texts force (per view on Linux). */
const chipText = { cursor: "pointer", userSelect: "none" } as const;
/** A message's first line, without markdown marks, for a one-line quote. */
const firstLine = (t: string) => (t.split("\n").find((l) => l.trim()) ?? "").replace(/^\s*(#+|>)\s*/, "").replace(/[*_`]/g, "").trim().slice(0, 80);
const chipFrame: ViewStyle = {
  cursor: "pointer", verticalAlign: "middle", flexDirection: "row", alignItems: "center", gap: 5, marginHorizontal: 2, height: 20,
  borderWidth: 1, borderColor: colors.border, backgroundColor: alpha(colors.text, 0.05),
};
const chipHover: ViewStyle = { borderColor: colors.fieldBorder, backgroundColor: alpha(colors.text, 0.09) };

function Custom(props: { node: TextViewCustomNode; small: boolean }) {
  const n = props.node;
  const fs = props.small ? 12 : 13;
  if (n.name === "task") {
    const st = () => STATE_OF()[taskState(n.text!) ?? ""];
    return (
      <View role="link" testID={`task-chip-${n.text}`} accessibilityLabel={`Task ${n.text}`} onPress={() => taskLink(n.text!)}
        hoverStyle={chipHover} style={{ ...chipFrame, paddingHorizontal: 7, borderRadius: 999 }}>
        <If when={st()}>
          <View style={{ cursor: "pointer", width: 6, height: 6, borderRadius: 3, backgroundColor: st()?.[1] ?? colors.muted }} />
        </If>
        <Text style={{ ...chipText, fontFamily: MONO, fontSize: fs, lineHeight: 16, color: colors.text }}>{n.text}</Text>
      </View>
    );
  }
  if (n.name === "plan") {
    return (
      <View role="link" testID={`plan-chip-${n.text}`} accessibilityLabel={`Plan ${n.text}`} onPress={() => planLink(n.text!)}
        hoverStyle={chipHover} style={{ ...chipFrame, paddingHorizontal: 7, borderRadius: 999 }}>
        <Text style={{ ...chipText, fontFamily: MONO, fontSize: fs, lineHeight: 16, color: colors.text }}>{n.text}</Text>
      </View>
    );
  }
  return (
    <View style={{ verticalAlign: "middle", height: 20, justifyContent: "center", marginHorizontal: 2, paddingHorizontal: 6, borderRadius: 5, backgroundColor: alpha(colors.text, 0.06) }}>
      <Text style={{ fontFamily: MONO, fontSize: fs, lineHeight: 16, color: colors.muted }}>{n.text}</Text>
    </View>
  );
}

/** Message text: the hub's Markdown through `TextView` (selectable across paragraphs), links opened by the system, the app's chips inline. */
function Rich(props: { text: string; muted?: boolean; quiet?: boolean; context?: string }) {
  const small = !!(props.muted || props.quiet);
  const fontSize = props.quiet ? 14 : props.muted ? size.small : size.text;
  const lineHeight = small ? 21 : size.line;
  const doc = () => {
    const d = TextView.parse(hubMarkdown(linkRepoRefs(props.text, props.context)), { math: false, html: false }, EXTENSIONS);
    return { ...d, blocks: ghBlocks(d.blocks) };
  };
  return (
    <TextView
      document={doc()}
      selectable
      onLinkPress={({ url }) => { if (/^(https?|mailto):/i.test(url)) void openUrl(url).catch(() => {}); }}
      renderCustom={(node) => <Custom node={node} small={small} />}
      styles={{
        root: { gap: 8, fontSize, lineHeight, color: small ? colors.muted : colors.text },
        code: { fontFamily: MONO, fontSize: small ? 13 : 14.5, color: colors.text, backgroundColor: alpha(colors.text, 0.07) },
        emphasis: { fontStyle: "normal", fontWeight: "600" },
        link: { color: linkColor(), textDecorationColor: token("link-underline") },
      }}
    />
  );
}

function Media(props: { hub: Hub; path: string }) {
  const src = mediaUrl(props.hub.cfg.url, props.hub.cfg.token, props.path);
  const ratio = signal(16 / 10);
  const zoomed = signal(false);
  const frame: ViewStyle = { borderRadius: radius.inset, backgroundColor: colors.inset };
  if (isVideo(props.path)) return <Video src={src} controls paused style={{ ...frame, borderWidth: 1, borderColor: colors.border, width: "100%", maxWidth: 480, aspectRatio: 16 / 9 }} />;
  // a thumbnail that keeps the timeline readable; press it to see the full image
  const THUMB = 240;
  const size = () => (ratio() >= 1 ? { width: THUMB, height: THUMB / ratio() } : { width: THUMB * ratio(), height: THUMB });
  const gone = signal(false); // past the media retention (or otherwise unavailable)
  return (
    <If
      when={!gone()}
      else={
        <View testID="media-gone" style={{ ...frame, width: THUMB, height: 72, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontSize: 13.5, color: colors.faint }}>Image expired</Text>
        </View>
      }
    >
      <View accessibilityLabel="View full image" onPress={() => zoomed.set(true)} style={{ cursor: "pointer" }}>
        <Image
          src={src}
          onLoad={({ size }) => size.width && size.height && ratio.set(size.width / size.height)}
          onError={() => gone.set(true)}
          style={{ ...frame, ...size(), objectFit: "cover" }}
        />
      </View>
      <Dialog
        open={zoomed()}
        animation="fade"
        onOpenChange={({ open }) => !open && zoomed.set(false)}
        backdropClass="bg-scrim"
        style={{ flex: 1, padding: 24, pointerEvents: "box-none" }}
      >
        <View accessibilityLabel="Close full image" onPress={() => zoomed.set(false)} style={{ flex: 1, alignItems: "center", justifyContent: "center", cursor: "zoom-out" }}>
          <Image src={src} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        </View>
      </Dialog>
    </If>
  );
}

// ---------------------------------------------------------------- timeline

/** A message the owner sent that the hub has not confirmed yet: it reads as sent unless delivery fails. */
type Outgoing = { id: string; messageKey: string; ts: string; text: string; ref: string | null; files: Attachment[]; state: "held" | "sending" | "failed"; error?: string; saved_locally?: boolean; savedId?: string };

/** Each agent's own color and mark, the same everywhere it appears (stable by its id). */
const MARKS = ["★", "◆", "▲", "●", "✦", "☾", "✿", "♪"];
/** From this window width on, the app lays out for a desktop or tablet rather than a phone. */
const WIDE = 860;

function persona(from: string): { tint: string; mark: string } {
  const id = from.split("@")[0].toLowerCase();
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { tint: token(`agent-${(h % 8) + 1}` as "agent-1"), mark: MARKS[(h >>> 3) % MARKS.length] };
}

function Avatar(props: { from: string; small?: boolean; testID?: string }) {
  const hubbed = isHub(props.from);
  const p = persona(props.from);
  const box = props.small ? 22 : 36;
  return (
    <View
      testID={props.testID}
      accessibilityLabel={displayName(props.from)}
      style={{
        width: box,
        height: box,
        borderRadius: box / 2,
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: hubbed ? colors.raised : alpha(p.tint, 0.16),
      }}
    >
      <If when={hubbed} else={
        <>
          <Text style={{ fontSize: props.small ? 12 : 16, fontWeight: "700", color: p.tint }}>{displayName(props.from).slice(0, 1).toUpperCase()}</Text>
          <If when={!props.small}>
            <View style={{ position: "absolute", right: -3, bottom: -3, width: 17, height: 17, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: colors.background }}>
              <Text style={{ fontSize: 10, lineHeight: 12, color: p.tint }}>{p.mark}</Text>
            </View>
          </If>
        </>
      }>
        <View style={{ width: props.small ? 8 : 12, height: props.small ? 8 : 12, borderRadius: 6, backgroundColor: colors.muted }} />
      </If>
    </View>
  );
}

/** The label of an option button: the option's own text when the hub gives one ("B: Upgrade"). */
function optionText(e: HubEvent, c: string): string {
  if (c === "all" || c === "none") return choiceLabel(c);
  const full = (e.options ?? []).find((o) => new RegExp(`^\\s*${c}\\s*([:：.、)]|\\s)`).test(o));
  // a button can't hold a link: a GitHub PR / issue URL reads as "nsh#747"
  return full ? full.trim().replace(/https:\/\/github\.com\/[\w.-]+\/([\w.-]+)\/(?:pull|issues)\/(\d+)\/?/g, "$1#$2") : choiceLabel(c);
}

type Proposal = { n: string; title: string; agent: string; note: string };
/** The items of an approval batch, from either message format ("1. [agent] title (source)" or "1. Title (agent)"). */
function proposalsOf(text: string): Proposal[] {
  const out: Proposal[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\\\s*$/, "").replace(/\*\*/g, "").trim();
    const m = line.match(/^(\d+)[.、]\s*(.+)$/);
    if (!m) continue;
    let rest = m[2], agent = "", note = "";
    const a = rest.match(/^\[([\w-]+)\]\s*/);
    if (a) { agent = a[1]; rest = rest.slice(a[0].length); }
    const src = rest.match(/\s*[(（]((?:routine|followup|approved)[^)）]*)[)）]\s*$/);
    if (src) {
      rest = rest.slice(0, src.index);
      const [kind, ref] = src[1].split(":");
      note = kind === "routine" ? "Routine" : kind === "followup" && ref ? `Follow-up to ${ref}` : "";
    }
    const who = rest.match(/\s*[(（]([\w-]+)[)）]\s*$/);
    if (!agent && who) { agent = who[1]; rest = rest.slice(0, who.index); }
    rest = rest.replace(/\s*·\s*\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s*$/, "").trim();
    out.push({ n: m[1], title: rest, agent, note });
  }
  return out;
}

/** An approval batch as a checklist: tick what may start, then approve. */
function ProposalList(props: { event: HubEvent; selection: Map<string, Signal<Set<string>>>; done: boolean; onAnswer: (ref: string, choice: string) => void; onReply: (ref: string) => void }) {
  const e = props.event;
  const items = proposalsOf(e.text);
  let picked = props.selection.get(e.id);
  if (!picked) { picked = signal<Set<string>>(new Set()); props.selection.set(e.id, picked); }
  const selection = picked;
  const toggle = (n: string) => selection.update((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });
  const answer = (c: string) => props.onAnswer(e.ref!, c);
  return (
    <>
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 }}>
        <Text style={{ fontSize: size.small, color: colors.muted }}>{`The team wants to do ${items.length === 1 ? "this" : `these ${items.length}`}. Tick the ones to start:`}</Text>
      </View>
      <View style={{ paddingHorizontal: 8, paddingBottom: 8 }}>
        <Each of={items}>
          {(it) => {
            const on = () => selection().has(it().n);
            return (
              <View
                role="checkbox"
                accessibilityState={{ checked: on() }}
                accessibilityLabel={it().title}
                testID={`proposal-${e.ref}-${it().n}`}
                onPress={props.done ? undefined : () => toggle(it().n)}
                hoverStyle={props.done ? undefined : { backgroundColor: alpha(colors.text, 0.04) }}
                style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 8, paddingVertical: 8, borderRadius: 8, cursor: props.done ? "default" : "pointer" }}
              >
                <View style={{ width: 20, height: 20, borderRadius: 6, borderWidth: on() ? 0 : 1.5, borderColor: colors.fieldBorder, backgroundColor: on() ? colors.accentFill : "transparent", alignItems: "center", justifyContent: "center" }}>
                  <If when={on()}><Icon name="check" size={14} tint={colors.onAccent} /></If>
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text style={{ numberOfLines: 2, fontSize: size.text, lineHeight: 22, color: colors.text, cursor: "pointer" }}>{it().title}</Text>
                  <Text style={{ fontSize: size.tiny, color: colors.faint, cursor: "pointer" }}>{[it().agent && displayName(it().agent), it().note].filter(Boolean).join(" · ")}</Text>
                </View>
              </View>
            );
          }}
        </Each>
      </View>
      <If when={!props.done}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 16 }}>
          <Btn testID={`approve-${e.ref}`} label={selection().size ? `Approve selected (${selection().size})` : "Approve selected"} kind="primary" disabled={!selection().size}
            onPress={() => answer([...selection()].sort((a, b) => +a - +b).join(","))} />
          <Btn testID={`opt-${e.ref}-all`} label="Approve all" kind="secondary" onPress={() => answer("all")} />
          <Btn testID={`opt-${e.ref}-none`} label="None" kind="ghost" onPress={() => answer("none")} />
          <View style={{ flex: 1 }} />
          <Btn testID={`other-${e.ref}`} label="Other instructions…" kind="dashed" onPress={() => props.onReply(e.ref!)} />
        </View>
      </If>
    </>
  );
}

/** An answer to a card, as plain words: "P-0002 6,7,8" → "Approve 6, 7, 8". */
/** The answer that sets a question aside (the hub's decisions.IGNORE). */
const IGNORE = "Ignore";

function answerText(t: string): string {
  const [, ref, rest] = t.match(/^((?:[DP]-[A-Z]?\d{4}|L-\d{4,})) (.+)$/) ?? [, "", t];
  const a = rest.trim();
  if (ref.startsWith("P-")) {
    if (/^all$/i.test(a)) return "Approve all";
    if (/^none$/i.test(a)) return "None";
    if (/^\d+(\s*[,，]\s*\d+)*$/.test(a)) return `Approve ${a.split(/\s*[,，]\s*/).join(", ")}`;
  }
  return a === IGNORE ? IGNORE : `Chose ${a}`;
}

/** The first line of a card's text, as plain words: what an answer replies to. */
function askLine(text: string): string {
  return (text.split("\n").find((l) => l.trim()) ?? "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*`_]/g, "").replace(/\\$/, "").trim();
}

/** A message's quick actions under it (like ChatGPT's): copy its text, reply to what it is about. Shown on hover
 * on a desktop, always on a phone (no hover there). */
function MsgActions(props: { text: string; show: () => boolean; onReply?: () => void; align?: "flex-start" | "flex-end"; id: string }) {
  const copied = signal(false);
  let t: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(t));
  const copy = () => {
    void Clipboard.writeText(props.text.trim()).then(() => {
      copied.set(true);
      clearTimeout(t);
      t = setTimeout(() => copied.set(false), 1500);
    }, () => {});
  };
  const btn = () => ({ width: touch ? 44 : 32, height: touch ? 44 : 32, borderRadius: radius.control, borderCurve: "continuous" as const, alignItems: "center" as const, justifyContent: "center" as const, cursor: "pointer" as const });
  return (
    <View style={{ flexDirection: "row", alignSelf: props.align ?? "flex-start", gap: 2, height: touch ? 44 : 32, marginLeft: props.align === "flex-end" ? 0 : -6, opacity: props.show() || copied() ? 1 : 0, transitionProperty: "opacity", transitionDuration: 120 }}>
      <View role="button" testID={`copy-${props.id}`} accessibilityLabel={copied() ? "Copied" : "Copy"} onPress={copy} hoverStyle={hovered()} style={btn()}>
        <Icon name={copied() ? "check" : "copy"} size={18} tint={colors.muted} />
      </View>
      <If when={props.onReply}>
        <View role="button" testID={`reply-${props.id}`} accessibilityLabel="Reply" onPress={() => props.onReply?.()} hoverStyle={hovered()} style={btn()}>
          <Icon name="reply" size={18} tint={colors.muted} />
        </View>
      </If>
    </View>
  );
}

function OwnerBubble(props: { hub: Hub; event: HubEvent; out?: Outgoing; onRetry?: () => void; onRecall?: () => void; onRef?: (ref: string) => void; onInspect?: (id: string) => void }) {
  const e = props.event;
  // an answer sent from the sidebar or a card ("D-0015 Ignore") names its card in the text, not in `ref`
  const ref = e.ref ?? e.text.match(/^((?:[DP]-[A-Z]?\d{4}|L-\d{4,})) \S/)?.[1];
  const over = signal(false);
  // a reply to an agent's message about a task quotes that message (the last one about it before this)
  const said = () => [...props.hub.events()].reverse().find((x) => x.ref === ref && x.ts <= e.ts && x.kind !== "owner" && !isHub(x.from));
  const asked = () => (ref ? askLine(props.hub.events().find((x) => x.ref === ref && isAsk(x))?.text ?? "") || (props.hub.status()?.decisions.find((d) => d.id === ref)?.question ?? "")
    || (/^T-/.test(ref) && said() ? `${displayName(said()!.from)}: ${firstLine(said()!.text)}` : "") : "");
  return (
    <View style={{ flexDirection: "row", justifyContent: "flex-end", paddingVertical: 8 }} onMouseEnter={() => over.set(true)} onMouseLeave={() => over.set(false)}>
      <View style={{ maxWidth: "82%", alignItems: "flex-end", gap: 4 }}>
        {/* what this answers, quoted above the bubble (press: back to the card) */}
        <If when={ref}>
          <View
            role="link"
            testID={`reply-to-${ref}`}
            onPress={() => props.onRef?.(ref!)}
            hoverStyle={{ opacity: 1 }}
            style={{ cursor: "pointer", opacity: 0.85, flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%", paddingLeft: 8, paddingRight: 4, borderLeftWidth: 2, borderLeftColor: colors.fieldBorder }}
          >
            <Text style={{ ...chipText, fontFamily: MONO, fontSize: 12, color: colors.muted }}>{ref}</Text>
            <If when={asked()}>
              <Text style={{ ...chipText, flexShrink: 1, numberOfLines: 1, fontSize: 13, color: colors.faint }}>{asked()}</Text>
            </If>
          </View>
        </If>
        <If when={e.attachments?.length}>
          <View testID="owner-images" style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6, opacity: props.out ? 0.65 : 1 }}>
            <Each of={e.attachments ?? []}>{(a) => <Media hub={props.hub} path={a()} />}</Each>
          </View>
        </If>
        <If when={e.text.trim() || e.ref}>
        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: 11,
            borderRadius: 18,
            borderBottomRightRadius: 6,
            backgroundColor: tints.accent,
            gap: 4,
          }}
        >
          {/^(?:[DP]-[A-Z]?\d{4}|L-\d{4,}) \S/.test(e.text) && !e.text.includes("\n")
            ? <Text style={{ fontSize: size.text, lineHeight: size.line, color: colors.text, userSelect: "text" }}>{answerText(e.text)}</Text>
            : <Rich text={e.text} />}
        </View>
        </If>
        <If
          when={props.out?.state === "failed"}
          else={
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <If when={e.text.trim()}>
                <MsgActions id={e.id} text={/^(?:[DP]-[A-Z]?\d{4}|L-\d{4,}) \S/.test(e.text) && !e.text.includes("\n") ? answerText(e.text) : e.text} show={() => touch || over()} align="flex-end" />
              </If>
              {/* only while it can still be taken back; the row keeps its height when this goes */}
              <If when={props.out?.state === "held"}>
                <View role="button" testID="recall-send" accessibilityLabel="Unsend" onPress={() => props.onRecall?.()} hoverStyle={hovered()} style={{ height: 28, paddingHorizontal: 6, borderRadius: 6, justifyContent: "center", cursor: "pointer" }}>
                  <Text style={{ fontSize: size.tiny, fontWeight: "600", color: colors.muted }}>Unsend</Text>
                </View>
              </If>
              <Text style={{ fontSize: size.tiny, color: colors.faint }}>{timeOf(e.ts)}</Text>
            </View>
          }
        >
          <View style={{ gap: 6 }}>
            <If when={props.out?.error}><Text testID="send-error" style={{ fontSize: 13, lineHeight: 18, color: colors.danger }}>{props.out!.error}</Text></If>
            <If when={props.out?.savedId}><Btn testID="send-inspect" label={`Inspect ${props.out!.savedId}`} kind="ghost" onPress={() => props.onInspect?.(props.out!.savedId!)} /></If>
            <View role="button" onPress={props.onRetry} accessibilityLabel={props.out?.saved_locally ? "Check same request" : "Retry sending"} style={{ flexDirection: "row", gap: 6 }}>
              <Text style={{ fontSize: size.tiny, color: colors.danger }}>{props.out?.saved_locally ? "Synchronization unconfirmed" : "Send failed"}</Text>
              <Text style={{ fontSize: size.tiny, fontWeight: "600", color: colors.danger }}>{props.out?.saved_locally ? "Check same request" : "Retry"}</Text>
            </View>
          </View>
        </If>
      </View>
    </View>
  );
}

function Message(props: {
  hub: Hub;
  event: HubEvent;
  answered: () => Set<string>;
  /** The pending ask the keyboard acts on. */
  target: () => string | null;
  onAnswer: (ref: string, choice: string) => void;
  onReply: (ref: string, note?: string) => void;
  selection?: Map<string, Signal<Set<string>>>;
}) {
  const e = props.event;
  const selection = props.selection ?? new Map<string, Signal<Set<string>>>();
  const ask = isAsk(e);
  // an agent's message about a task can be replied to: the reply goes to that task
  const replyable = !ask && !isHub(e.from) && !!e.ref && /^T-\d{4,}$/.test(e.ref);
  const over = signal(false);
  const tag = TAGS[e.kind];
  // what the message is about, for its bare "#746": the card's options, the task's title, the thread it belongs to
  const about = () => {
    if (!e.ref) return (e.options ?? []).join("\n");
    const s = props.hub.status();
    const task = [...(s?.active ?? []), ...(s?.recent ?? [])].find((t) => t.id === e.ref);
    return [...(e.options ?? []), task?.title ?? "", ...props.hub.events().filter((x) => x.ref === e.ref && x.id !== e.id).map((x) => x.text)].join("\n");
  };
  const body = (
    <View selectable style={{ gap: 10 }}>
      <Rich text={ask ? e.text.replace(/\n*^Recommendation:.*$/m, "").trimEnd() : e.text} muted={e.kind === "system"} context={about()} />
      <If when={e.attachments?.length}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          <Each of={e.attachments ?? []}>{(a) => <Media hub={props.hub} path={a()} />}</Each>
        </View>
      </If>
    </View>
  );
  const done = () => !!e.ref && props.answered().has(e.ref);
  const targeted = () => ask && !done() && props.target() === e.ref;
  const rec = recommended(e);
  // a phone has no width to spare: the avatar sits in the name's row, and the message takes the whole column
  const wide = () => windowSize().width >= WIDE;
  if (isHub(e.from) && !ask && e.kind === "system" && !e.attachments?.length)
    return (
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, paddingVertical: 4, paddingLeft: wide() ? 50 : 0 }}>
        <Text style={{ fontSize: size.tiny, color: colors.faint, fontVariant: ["tabular-nums"] }}>{timeOf(e.ts)}</Text>
        <View selectable style={{ flex: 1, minWidth: 0 }}><Rich text={e.text} quiet /></View>
      </View>
    );
  return (
    <View style={{ flexDirection: "row", gap: 14, paddingVertical: 10 }} onMouseEnter={() => over.set(true)} onMouseLeave={() => over.set(false)}>
      <If when={wide()}><Avatar testID={`avatar-column-${e.id}`} from={e.from} /></If>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 22 }}>
          <If when={!wide()}><Avatar testID={`avatar-inline-${e.id}`} from={e.from} small /></If>
          <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>{displayName(e.from)}</Text>
          <Text style={{ fontSize: size.tiny, color: colors.faint, fontVariant: ["tabular-nums"] }}>{timeOf(e.ts)}</Text>
          {tag && !ask ? <Badge label={tag} /> : null}
        </View>
        {ask ? (
          <View
            style={{
              marginTop: 6,
              borderRadius: radius.card,
              backgroundColor: colors.surface,
              opacity: done() ? 0.62 : 1,
              overflow: "hidden",
              transitionProperty: "opacity",
              transitionDuration: 160,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 12 }}>
              <Badge label={tag ?? "Needs you"} tone={done() ? "neutral" : "warn"} />
              <Text style={{ fontFamily: MONO, fontSize: 13, color: colors.muted }}>{e.ref}</Text>
              <View style={{ flex: 1 }} />
              <If when={done()}>
                <Text style={{ fontSize: 13, color: colors.up }}>✓ Replied</Text>
              </If>
            </View>
            {e.kind === "proposals" && proposalsOf(e.text).length ? (
              <ProposalList event={e} selection={selection} done={done()} onAnswer={props.onAnswer} onReply={props.onReply} />
            ) : (
            <>
            <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 14 }}>{body}</View>
            {/* one option per line: options are sentences, side by side they read as a jumble */}
            <View style={{ alignItems: "flex-start", gap: 8, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 16 }}>
              <Each of={choicesOf(e).slice(0, 12)}>
                {(c, i) => (
                  <Btn
                    testID={`opt-${e.ref}-${c()}`}
                    label={optionText(e, c())}
                    kind="secondary"
                    note={rec === c() ? "Recommended" : undefined}
                    onPress={() => props.onAnswer(e.ref!, c())}
                  />
                )}
              </Each>
              <Btn testID={`other-${e.ref}`} label="Other instructions…" kind="dashed" onPress={() => props.onReply(e.ref!)} />
              <If when={e.ref!.startsWith("D-") && !done()}>
                <Btn testID={`ignore-${e.ref}`} label="Ignore" kind="dashed" onPress={() => props.onAnswer(e.ref!, IGNORE)} />
              </If>
            </View>
            </>
            )}
          </View>
        ) : (
          body
        )}
        <If when={e.text.trim()}>
          <MsgActions id={e.id} text={e.text} show={() => touch || over()} onReply={e.ref && !(ask && !done()) ? () => props.onReply(e.ref!, replyable ? `${displayName(e.from)}: ${firstLine(e.text)}` : undefined) : undefined} />
        </If>
      </View>
    </View>
  );
}

/** A task's state as the sidebar's dot: only what needs attention gets a color. */
const TONE: Record<string, "on" | "run" | "queue" | "wait" | "off" | "bad"> = { active: "run", blocked: "wait", failed: "bad", done: "off", inbox: "queue", waiting: "wait", nohost: "wait", parked: "wait" };

/** A task's state: its label, color and mark. */
const STATE_OF = (): Record<string, [string, string, string]> => ({
  active: ["In progress", colors.up, "●"], inbox: ["Queued", colors.info, "○"], waiting: ["Waiting on subtasks", colors.warn, "○"], nohost: ["Waiting for machine", colors.warn, "○"], parked: ["Waiting on result", colors.warn, "○"],
  blocked: ["Needs your decision", colors.warn, "!"], failed: ["Failed", colors.danger, "✕"], done: ["Done", colors.faint, "✓"], cancelled: ["Cancelled", colors.faint, "✕"],
});

/** A progress step's icon and color. */
const STEP_OF = (): Record<string, [IconName, string]> => ({
  chat: ["chat", colors.muted], start: ["play", colors.info], done: ["check", colors.up], fail: ["close", colors.danger],
  decision: ["pause", colors.warn], retry: ["replace", colors.muted], followup: ["plus", colors.muted],
  delegated: ["layers", colors.info], judge: ["sliders", colors.muted], edit: ["document", colors.muted],
});

/** "11-02 16:34", or "16:34" today. */
function clock(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  const today = new Date().toDateString() === d.toDateString();
  return `${today ? "" : `${p(d.getMonth() + 1)}-${p(d.getDate())} `}${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "3 minutes" since an ISO time (to now, or to `end`). */
function since(iso?: string, end?: string): string {
  if (!iso) return "";
  const m = Math.max(0, Math.round(((end ? Date.parse(end) : Date.now()) - Date.parse(iso)) / 60000));
  return m < 1 ? "just now" : m < 60 ? plural(m, "minute") : m < 1440 ? plural(Math.floor(m / 60), "hour") : plural(Math.floor(m / 1440), "day");
}

const HISTORY_PAGE = 50;

/** All tasks: every task the team has, newest first, a page at a time. */
function TaskHistory(props: { hub: Hub; wide: boolean; isCurrent: () => boolean; onTask: (id: string) => void }) {
  const tasks = signal<TaskInfo[]>([]);
  const total = signal<number | null>(null);
  const error = signal("");
  const loading = signal(false);
  const query = signal("");
  const creating = signal(false);
  const startTask = () => {
    const saved = props.hub.taskForms().get("create");
    if (saved?.result() && !saved.pending()) props.hub.taskForms.update((all) => { const next = new Map(all); next.delete("create"); return next; });
    creating.set(true);
  };
  let asked = 0; // the newest request; an older answer that lands late is dropped
  async function load(reset: boolean) {
    const mine = ++asked;
    loading.set(true);
    const offset = reset ? 0 : untracked(tasks).length;
    const r = await props.hub.api("GET", `/api/tasks?limit=${HISTORY_PAGE}&offset=${offset}&q=${encodeURIComponent(untracked(query).trim())}`);
    if (mine !== asked) return;
    loading.set(false);
    if (!r.ok) { error.set(r.status ? `Couldn't load (${r.status})` : "can't reach the server"); return; }
    error.set("");
    const page = (r.data.tasks as TaskInfo[] | undefined) ?? [];
    tasks.set(reset ? page : [...untracked(tasks), ...page]);
    total.set(Number(r.data.total ?? 0));
  }
  void load(true);
  return (
    <Scroll testID="task-history" style={{ flex: 1 }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", gap: 12, paddingHorizontal: props.wide ? 32 : 16, paddingVertical: 20 }}>
        <Btn testID="task-new" label="New task" kind="primary" onPress={startTask} />
        <Input
          testID="task-search"
          value={query()}
          onChange={({ value }) => { query.set(value); void load(true); }}
          placeholder="Search by ID, title or member"
          class="placeholder:text-faint"
          style={{ height: 38, paddingHorizontal: 12, fontSize: 15, color: colors.text, borderRadius: radius.control, borderWidth: 1, borderColor: colors.fieldBorder, backgroundColor: colors.surface }}
        />
        <If when={error()}><Text style={{ fontSize: 14, color: colors.danger }}>{error()}</Text></If>
        <If when={total() === 0 && !loading()}><Text style={{ fontSize: 14, color: colors.faint }}>No matching tasks</Text></If>
        <View>
          <Each of={tasks()} key={(t) => t.id}>
            {(t) => (
              <View
                role="button"
                accessibilityLabel={`${t().id} ${t().title}`}
                onPress={() => props.onTask(t().id)}
                hoverStyle={hovered()}
                style={{ minHeight: size.row, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, marginHorizontal: -10, borderRadius: 7 }}
              >
                <Dot tone={TONE[t().state ?? ""] ?? "off"} />
                <Text style={{ fontFamily: MONO, fontSize: 12.5, color: colors.faint }}>{t().id}</Text>
                <Text style={{ flex: 1, fontSize: 14.5, color: colors.text, numberOfLines: 1 }}>{t().title}</Text>
                <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{`${STATE_OF()[t().state ?? ""]?.[0] ?? ""} · ${clock(t().updated ?? "")}`}</Text>
              </View>
            )}
          </Each>
        </View>
        <If when={total() !== null && tasks().length < total()!}>
          <View style={{ alignSelf: "flex-start" }}>
            <Btn testID="task-more" label={loading() ? "Loading…" : `Load more (${total()! - tasks().length} left)`} kind="secondary" disabled={loading()} onPress={() => void load(false)} />
          </View>
        </If>
      </View>
      <If when={creating()}><TaskForm hub={props.hub} isCurrent={props.isCurrent} onClose={() => creating.set(false)} onOpen={(id) => { creating.set(false); props.onTask(id); }} /></If>
    </Scroll>
  );
}

const PLANS_LOCAL_ONLY = "Update the hub and main machine to manage plans";
/** Plans change as their steps run: keep asking while the page is open. */
function poll(fn: () => void, ms = 4000) {
  fn();
  const timer = setInterval(fn, ms);
  cleanup(() => clearInterval(timer));
}

/** Plans: every plan with its progress, and a new one from a goal. */
function PlansPage(props: { hub: Hub; settings: Settings; wide: boolean; onPlan: (id: string) => void }) {
  const plans = signal<PlanInfo[] | null>(null);
  const error = signal("");
  props.settings.load();
  poll(() => void props.hub.api("GET", "/api/plans").then((r) => {
    if (r.ok) { plans.set((r.data.plans as PlanInfo[] | undefined) ?? []); error.set(""); }
    else error.set(r.status === 404 ? PLANS_LOCAL_ONLY : r.status ? `Couldn't load (${r.status})` : "can't reach the server");
  }));
  const goal = signal(""), project = signal(""), agent = signal("lead"), note = signal(""), busy = signal(false), savedPlan = signal("");
  const eff = () => props.settings.view()?.effective;
  const create = async () => {
    busy.set(true);
    note.set("");
    const r = await props.hub.api("POST", "/api/plans", { goal: goal(), project: project() || undefined, agent: agent() });
    busy.set(false);
    if (!r.ok) {
      if (r.data.saved_locally && (r.data.plan as PlanInfo | undefined)?.id) savedPlan.set((r.data.plan as PlanInfo).id);
      return note.set(r.status === 404 ? PLANS_LOCAL_ONLY : String(r.data.error ?? "Couldn't reach the server"));
    }
    goal.set("");
    props.onPlan((r.data.plan as PlanInfo).id);
  };
  return (
    <Scroll testID="plans-page" style={{ flex: 1 }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", gap: 24, paddingHorizontal: props.wide ? 32 : 16, paddingVertical: 20 }}>
        <Group title="New plan" hint="Say what you want to achieve. A member drafts the steps, and nothing runs until you approve them.">
          <View style={{ gap: 12, padding: 16 }}>
            <TextArea label="Goal" testID="plan-goal" height={96} value={goal()} onChange={(v) => { goal.set(v); note.set(""); }} placeholder="e.g. Add a dark mode to the website, including the settings page and emails" />
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <Dropdown
                testID="plan-project"
                label="Project"
                value={eff()?.projects?.find((p) => p.id === project())?.name ?? "None"}
                options={[{ id: "", label: "None", testID: "plan-project-none" }, ...(eff()?.projects ?? []).map((p) => ({ id: p.id, label: p.name, testID: `plan-project-${p.id}` }))]}
                selected={project()}
                onPick={(id) => project.set(id)}
              />
              <Dropdown
                testID="plan-agent"
                label="Drafted by"
                value={eff()?.agents.find((a) => a.id === agent())?.title ?? agent()}
                options={(eff()?.agents ?? []).map((a) => ({ id: a.id, label: a.title ?? a.id, testID: `plan-agent-${a.id}` }))}
                selected={agent()}
                onPick={(id) => agent.set(id)}
              />
              <View style={{ flex: 1 }} />
              <Btn label="Draft the steps" kind="primary" disabled={!goal().trim() || busy() || !!savedPlan()} busy={busy()} onPress={() => void create()} testID="plan-create" />
            </View>
            <If when={savedPlan()}><Btn testID="plan-open-saved" label="Open the plan saved on the main machine" kind="ghost" onPress={() => props.onPlan(savedPlan())} /></If>
            <If when={note()}><Text testID="plan-note" style={{ fontSize: 13.5, lineHeight: 19, color: colors.danger }}>{note()}</Text></If>
          </View>
        </Group>
        <If when={error()}><Text testID="plans-error" style={{ fontSize: 14, color: colors.danger }}>{error()}</Text></If>
        <If when={plans()?.length}>
          <View>
            <Each of={plans() ?? []} key={(p) => p.id}>
              {(p) => (
                <View
                  role="button"
                  testID={`plan-${p().id}`}
                  accessibilityLabel={`${p().id} ${p().goal}`}
                  onPress={() => props.onPlan(p().id)}
                  hoverStyle={hovered()}
                  style={{ minHeight: size.row, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, marginHorizontal: -10, borderRadius: 7 }}
                >
                  <Dot tone={planTone(p().status)} />
                  <Text style={{ fontFamily: MONO, fontSize: 12.5, color: colors.faint }}>{p().id}</Text>
                  <Text style={{ flex: 1, fontSize: 14.5, color: colors.text, numberOfLines: 1 }}>{p().goal.split("\n")[0]}</Text>
                  <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{`${PLAN_STATUS[p().status]}${p().steps.length ? ` · ${p().steps.filter((s) => s.status === "done" || s.status === "skipped").length}/${p().steps.length}` : ""}`}</Text>
                </View>
              )}
            </Each>
          </View>
        </If>
      </View>
    </Scroll>
  );
}

const planTone = (s: PlanInfo["status"]): "run" | "wait" | "off" | "bad" | "on" => (s === "running" || s === "drafting" ? "run" : s === "review" || s === "paused" ? "wait" : s === "done" ? "on" : "off");
const STEP_TONE: Record<PlanStepInfo["status"], "run" | "off" | "bad" | "on" | "queue"> = { pending: "queue", running: "run", done: "on", stopped: "bad", skipped: "off" };
const STEP_LABEL: Record<PlanStepInfo["status"], string> = { pending: "Not started", running: "Running", done: "Done", stopped: "Stopped", skipped: "Skipped" };
type DraftStep = { key: number; title: string; details: string; agent: string; checkpoint: boolean };

/** One plan: its goal, its steps with where each stands, and what you can do next. */
function PlanPage(props: { hub: Hub; settings: Settings; id: string; wide: boolean; onTask: (id: string) => void; onGone: () => void }) {
  const plan = signal<PlanInfo | null>(null);
  const error = signal(""), syncWarning = signal("");
  const busy = signal(false);
  const cancelUnconfirmed = signal(false);
  const cleanupAttempt = signal<PendingStops | undefined>(undefined);
  const stops = () => pendingStopsView(plan()?.pending_stops) ?? cleanupAttempt();
  const stopError = () => pendingStopsError(plan()?.pending_stops) ?? (cancelUnconfirmed() ? "The plan cancellation is not confirmed. Update the main machine and refresh its progress." : undefined);
  const cleanupPending = () => hasPendingStops(plan()?.pending_stops) || !!cleanupAttempt() || cancelUnconfirmed();
  props.settings.load();
  const agents = () => props.settings.view()?.effective.agents ?? [];
  const agentTitle = (id: string) => agents().find((a) => a.id === id)?.title ?? id;
  const projectName = (id?: string) => props.settings.view()?.effective.projects?.find((p) => p.id === id)?.name ?? id;
  const continuationIssue = () => {
    const p = plan(), settings = props.settings.view();
    if (!p || !settings) return "";
    if (!settings.effective.agents.some((agent) => agent.id === p.agent)) return `Restore or add member ${p.agent} before continuing this plan.`;
    if (p.project && !settings.effective.projects?.some((project) => project.id === p.project)) return `Restore or connect project ${p.project} before continuing this plan.`;
    return "";
  };
  /** The steps being edited; null when not editing. Polling leaves them alone. */
  const draft = signal<DraftStep[] | null>(null);
  let nextKey = 1;
  const editable = (p: PlanInfo): DraftStep[] => p.steps.filter((s) => s.status === "pending").map((s) => ({ key: nextKey++, title: s.title, details: s.details, agent: s.agent, checkpoint: s.checkpoint }));
  const continuing = signal(false), instructions = signal("");
  let seen: PlanInfo["status"] | undefined;
  const take = (p: PlanInfo) => {
    if (p.status === "review" && seen !== "review") draft.set(editable(p)); // a fresh draft opens for editing
    if (p.status !== "review" && seen === "review") draft.set(null);
    seen = p.status;
    const attempted = cleanupAttempt(), latest = readPendingStops(p.pending_stops);
    if (attempted && latest?.operation_id === attempted.operation_id) cleanupAttempt.set(latest);
    plan.set(p);
  };
  poll(() => void props.hub.api("GET", `/api/plans/${props.id}`).then((r) => {
    if (r.ok) { take(r.data.plan as PlanInfo); if (!busy()) error.set(syncWarning()); }
    else if (!busy()) error.set(r.status === 404 ? "This plan isn't here any more, or the hub doesn't have plans" : r.status ? `Couldn't load (${r.status})` : "can't reach the server");
  }));
  const act = async (method: string, path: string, body?: unknown) => {
    busy.set(true);
    error.set("");
    const r = await props.hub.api(method, `/api/plans/${props.id}${path}`, body);
    busy.set(false);
    if (!r.ok) {
      const message = String(r.data.error ?? "Couldn't reach the server");
      if (r.data.saved_locally) {
        syncWarning.set(message);
        if (r.data.plan) take(r.data.plan as PlanInfo);
        if (path === "/continue") continuing.set(false);
      }
      if (path === "/cancel" || path === "/retry-stops") cleanupAttempt.set(stopAttempt(r.data, stops()));
      if (path === "/cancel" && r.data.uncertain) cancelUnconfirmed.set(true);
      error.set(message); return false;
    }
    syncWarning.set("");
    if (path === "/cancel" || path === "/retry-stops") cancelUnconfirmed.set(false);
    if (path === "/retry-stops") cleanupAttempt.set(undefined);
    if (r.data.plan) take(r.data.plan as PlanInfo);
    return true;
  };
  const sendable = () => (draft() ?? []).filter((s) => s.title.trim()).map(({ title, details, agent, checkpoint }) => ({ title, details, agent, checkpoint }));
  const saveDraft = () => act("PUT", "", { steps: sendable() });
  const approve = async () => { if ((await saveDraft()) && (await act("POST", "/approve"))) draft.set(null); };
  const saveEdits = async () => { if (await saveDraft()) draft.set(null); };
  const change = (key: number, patch: Partial<DraftStep>) => draft.update((d) => (d ?? []).map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const move = (key: number, by: number) => draft.update((d) => {
    const list = [...(d ?? [])], i = list.findIndex((s) => s.key === key), j = i + by;
    if (i < 0 || j < 0 || j >= list.length) return list;
    [list[i], list[j]] = [list[j]!, list[i]!];
    return list;
  });
  const submitContinue = async () => {
    if (await act("POST", "/continue", { instructions: instructions() })) { instructions.set(""); continuing.set(false); draft.set(null); }
  };
  const cancelPlan = async () => {
    if (busy()) return;
    busy.set(true);
    const capability = await props.hub.api("GET", "/api/stops/capabilities");
    busy.set(false);
    if (!capability.ok || capability.data.family_stops !== 1) { error.set("Connect or update the main machine to confirm task-family stops."); return; }
    const r = await AlertDialog.show({
      title: "Cancel this plan?",
      description: "A running step is stopped and no further steps start. Work already done stays in the project.",
      actions: [{ id: "keep", label: "Keep it", role: "cancel" }, { id: "cancel", label: "Cancel plan", role: "destructive" }],
    });
    if (r.action === "cancel") await act("POST", "/cancel");
  };
  const remove = async () => {
    const r = await AlertDialog.show({
      title: "Remove this plan?",
      description: "It moves to Archive. Its tasks and any work done stay as they are. You can restore its history later.",
      actions: [{ id: "keep", label: "Keep it", role: "cancel" }, { id: "remove", label: "Remove", role: "destructive" }],
    });
    if (r.action === "remove" && (await act("DELETE", ""))) props.onGone();
  };
  const stopped = () => plan()?.steps.find((s) => s.status === "stopped");
  const canEdit = () => { const s = plan()?.status; return s === "running" || s === "paused"; };
  const finishedSteps = () => (plan()?.steps ?? []).filter((s) => s.status !== "pending" || !draft());
  return (
    <Scroll testID="plan-page" style={{ flex: 1 }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", gap: 20, paddingHorizontal: props.wide ? 32 : 16, paddingVertical: 20 }}>
        <If when={plan()} else={<Text style={{ fontSize: 14, color: error() ? colors.danger : colors.faint }}>{error() || "Loading…"}</Text>}>
          {(p) => (
            <>
              <View style={{ gap: 8 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Dot tone={planTone(p().status)} />
                  <Text testID="plan-status" style={{ fontSize: 13.5, fontWeight: "600", color: colors.muted }}>{PLAN_STATUS[p().status]}</Text>
                  <If when={p().project}><Text style={{ fontSize: 13.5, color: colors.faint }}>{`· ${projectName(p().project)}`}</Text></If>
                </View>
                <Text testID="plan-goal-text" style={{ fontSize: 18, lineHeight: 26, fontWeight: "600", color: colors.text }}>{p().goal}</Text>
                <Each of={p().notes} key={(n) => n}>
                  {(n) => <Text style={{ fontSize: 14, lineHeight: 20, color: colors.muted }}>{`Then: ${n()}`}</Text>}
                </Each>
                <If when={p().reason}>
                  <Text testID="plan-reason" style={{ fontSize: 14, lineHeight: 20, color: stopped() || p().status === "review" ? colors.danger : colors.muted }}>{p().reason}</Text>
                </If>
                <If when={error()}><Text testID="plan-error" style={{ fontSize: 14, lineHeight: 20, color: colors.danger }}>{error()}</Text></If>
                <If when={continuationIssue()}><Text testID="plan-dependency-warning" style={{ fontSize: 13, lineHeight: 19, color: colors.warn }}>{continuationIssue()}</Text></If>
              </View>

              <RemainingStops hub={props.hub} owner={{ kind: "plan", id: props.id }} batch={stops()} error={stopError()} busy={busy()} onRetry={(operation_id) => { if (stops()?.operation_id === operation_id) void act("POST", "/retry-stops", { operation_id }); else error.set("The cleanup operation changed. Review its latest progress before retrying."); }} onRefresh={() => void props.hub.api("GET", `/api/plans/${props.id}`).then((r) => { if (r.ok) take(r.data.plan as PlanInfo); else error.set(String(r.data.error ?? "Couldn't refresh this plan")); })}
                onReviewed={(data, saved) => {
                  const batch = stopAttempt(data, stops());
                  if ((data.plan as PlanInfo | undefined)?.id === props.id) take(data.plan as PlanInfo);
                  cleanupAttempt.set(saved ? undefined : batch);
                  const message = saved ? "" : String(data.error ?? "Review saved locally; synchronization is unconfirmed.");
                  syncWarning.set(message); error.set(message);
                  if (saved) cancelUnconfirmed.set(false);
                }} />
              <StopReviewHistory reviews={plan()?.stop_reviews ?? readPendingStops(plan()?.pending_stops)?.reviews ?? cleanupAttempt()?.reviews ?? []} />

              <If when={p().status === "drafting"}>
                <Text testID="plan-drafting" style={{ fontSize: 14, color: colors.muted }}>{`${agentTitle(p().agent)} is drafting the steps. You'll be notified when they're ready to review.`}</Text>
              </If>

              <If when={finishedSteps().length}>
                <Group title="Steps" hint={p().status === "running" && p().project ? "Other tasks can still run in this folder at the same time." : undefined}>
                  <Each of={finishedSteps()} key={(s) => s.id}>
                    {(s, i) => (
                      <View testID={`step-${s().id}`} style={{ flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: i() === 0 ? 0 : 0.5, borderTopColor: surfaceEdge() }}>
                        <View style={{ paddingTop: 7 }}><Dot tone={STEP_TONE[s().status]} /></View>
                        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                          <Text style={{ fontSize: 15, lineHeight: 21, fontWeight: "500", color: s().status === "skipped" ? colors.faint : colors.text }}>{s().title}</Text>
                          <Text style={{ fontSize: 13, color: colors.faint }}>{`${agentTitle(s().agent)} · ${STEP_LABEL[s().status]}${s().checkpoint ? " · Pauses after this step" : ""}`}</Text>
                          <If when={s().result}><Text style={{ fontSize: 13.5, lineHeight: 19, color: colors.muted, numberOfLines: 4 }}>{s().result}</Text></If>
                        </View>
                        <If when={s().task}>
                          <Btn label={s().task!} kind="ghost" onPress={() => props.onTask(s().task!)} testID={`step-task-${s().id}`} />
                        </If>
                      </View>
                    )}
                  </Each>
                </Group>
              </If>

              <If when={draft()}>
                <Group title={p().status === "review" ? "Steps to approve" : "Steps still to come"} hint="Edit, reorder, reassign or remove them. They run one at a time, in this order.">
                  <Each of={draft() ?? []} key={(s) => s.key}>
                    {(s, i) => (
                      <View testID={`draft-step-${i()}`} style={{ gap: 8, padding: 14, borderTopWidth: i() === 0 ? 0 : 0.5, borderTopColor: surfaceEdge() }}>
                        <Field label={`Step ${i() + 1 + (plan()?.steps.filter((x) => x.status !== "pending").length ?? 0)}`} value={s().title} onChange={(v) => change(s().key, { title: v })} testID={`draft-title-${i()}`} />
                        <TextArea label="Details" height={72} value={s().details} onChange={(v) => change(s().key, { details: v })} testID={`draft-details-${i()}`} />
                        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                          <Dropdown
                            testID={`draft-agent-${i()}`}
                            label="Member"
                            value={agentTitle(s().agent)}
                            options={agents().map((a) => ({ id: a.id, label: a.title ?? a.id, testID: `draft-agent-${i()}-${a.id}` }))}
                            selected={s().agent}
                            onPick={(id) => change(s().key, { agent: id })}
                          />
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                            <Toggle testID={`draft-checkpoint-${i()}`} label="Pause after this step" value={s().checkpoint} onChange={(on) => change(s().key, { checkpoint: on })} />
                            <Text style={{ fontSize: 13.5, color: colors.muted }}>Pause after</Text>
                          </View>
                          <View style={{ flex: 1 }} />
                          <ToolButton icon="arrow-up" label="Move up" onPress={() => move(s().key, -1)} />
                          <ToolButton icon="arrow-down" label="Move down" onPress={() => move(s().key, 1)} />
                          <ToolButton icon="trash" label="Remove step" onPress={() => draft.update((d) => (d ?? []).filter((x) => x.key !== s().key))} testID={`draft-remove-${i()}`} />
                        </View>
                      </View>
                    )}
                  </Each>
                  <SetRow first={!(draft() ?? []).length} label="Add a step" tone="accent" leading={<Icon name="plus" size={16} tint={colors.info} />} onPress={() => draft.update((d) => [...(d ?? []), { key: nextKey++, title: "", details: "", agent: plan()?.agent ?? "lead", checkpoint: false }])} testID="draft-add" />
                </Group>
              </If>

              <If when={continuing()}>
                <View style={{ gap: 10 }}>
                  <TextArea label="What should happen next?" testID="plan-instructions" height={96} value={instructions()} onChange={(v) => instructions.set(v)} placeholder="e.g. Also cover the mobile navigation" hint="The planner proposes the remaining steps, and you approve them. A running step carries on meanwhile." />
                  <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
                    <Btn label="Never mind" kind="ghost" onPress={() => continuing.set(false)} testID="plan-continue-cancel" />
                    <Btn label="Draft next steps" kind="primary" disabled={!instructions().trim() || busy() || !!continuationIssue()} onPress={() => void submitContinue()} testID="plan-continue-send" />
                  </View>
                </View>
              </If>

              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                <If when={p().status === "review"}>
                  <Btn label="Approve and start" kind="primary" disabled={busy() || !sendable().length} onPress={() => void approve()} testID="plan-approve" />
                </If>
                <If when={p().status === "running"}><Btn label="Pause" kind="secondary" disabled={busy()} onPress={() => void act("POST", "/pause")} testID="plan-pause" /></If>
                <If when={p().status === "paused" && !stopped()}><Btn label="Resume" kind="primary" disabled={busy()} onPress={() => void act("POST", "/resume")} testID="plan-resume" /></If>
                <If when={stopped() && p().status === "paused"}>
                  <>
                    <Btn label="Retry step" kind="primary" disabled={busy()} onPress={() => void act("POST", "/retry")} testID="plan-retry" />
                    <Btn label="Skip step" kind="secondary" disabled={busy()} onPress={() => void act("POST", "/skip")} testID="plan-skip" />
                  </>
                </If>
                <If when={canEdit() && !draft()}>
                  <Btn label="Edit steps" kind="secondary" onPress={() => draft.set(editable(plan()!))} testID="plan-edit" />
                </If>
                <If when={canEdit() && draft()}>
                  <>
                    <Btn label="Save steps" kind="primary" disabled={busy()} onPress={() => void saveEdits()} testID="plan-edit-save" />
                    <Btn label="Discard edits" kind="ghost" onPress={() => draft.set(null)} testID="plan-edit-cancel" />
                  </>
                </If>
                <If when={p().status !== "drafting" && !continuing() && !cleanupPending()}>
                  <Btn label="Continue with instructions" kind="secondary" disabled={busy() || !!continuationIssue()} onPress={() => continuing.set(true)} testID="plan-continue" />
                </If>
                <View style={{ flex: 1 }} />
                <If when={p().status === "done" || p().status === "cancelled"}><Btn label="Remove" kind="ghost" disabled={busy() || cleanupPending()} onPress={() => void remove()} testID="plan-remove" /></If>
                <If when={p().status !== "done" && p().status !== "cancelled"}><Btn label="Cancel plan" kind="ghost" disabled={busy()} onPress={() => void cancelPlan()} testID="plan-cancel" /></If>
              </View>
            </>
          )}
        </If>
      </View>
    </Scroll>
  );
}

function taskRunDraft(task: TaskInfo) {
  return { requirements: signal(task.requires ?? task.needs ?? ""), host: signal(task.learning_host ?? task.target_host ?? "any"), cli: signal(task.configured_cli ?? "auto"),
    agent: signal(task.agent), priority: signal(task.priority ?? "normal"), title: signal(task.title), prefer: signal(task.prefer ?? ""), weight: signal(task.weight ?? "normal"),
    project: signal(task.project || (task.repo ? "__current__" : "")), advanced: signal(false) };
}
type TaskRunDraft = ReturnType<typeof taskRunDraft>;
function taskRunCatalog(hub: Hub) {
  const effective = signal<SettingsView["effective"] | undefined>(undefined), error = signal("");
  let generation = 0;
  cleanup(() => { generation++; });
  async function load() {
    const mine = ++generation;
    const r = await hub.api("GET", "/api/settings");
    if (mine !== generation) return;
    const value = r.data.effective as SettingsView["effective"] | undefined;
    if (r.ok && value && Array.isArray(value.agents) && value.agents.every((a) => a && typeof a.id === "string" && (a.clis === undefined || Array.isArray(a.clis) && a.clis.every((c) => typeof c === "string")))
      && (value.projects === undefined || Array.isArray(value.projects) && value.projects.every((p) => p && [p.id, p.name, p.host, p.path].every((v) => typeof v === "string") && (p.requires === undefined || Array.isArray(p.requires) && p.requires.every((c) => typeof c === "string"))))
      && (value.enabled_clis === undefined || Array.isArray(value.enabled_clis) && value.enabled_clis.every((c) => typeof c === "string"))) { effective.set(value); error.set(""); }
    else error.set(String(r.data.error ?? "Couldn't load members and projects. Reconnect and reload settings before starting work."));
  }
  void load();
  return { effective, error, load };
}
type TaskRunCatalog = ReturnType<typeof taskRunCatalog>;
function matchingTaskHosts(hub: Hub, draft: TaskRunDraft, catalog: TaskRunCatalog, learningHost?: string, learningError?: string) {
  const effective = catalog.effective(), enabled = effective?.enabled_clis ?? DEFAULT_PROVIDERS;
  const member = effective?.agents.find((a) => a.id === draft.agent()), project = effective?.projects?.find((p) => p.id === draft.project());
  if (learningError || effective && !member || draft.project() && draft.project() !== "__current__" && !project || learningHost && project && project.host !== learningHost) return [];
  const host = learningHost ?? draft.host();
  return (hub.status()?.hosts ?? []).filter((h) => !member?.paused && !member?.tool_policy?.invalid && !h.stats?.diskError && h.online !== false && h.enabled !== false && (host === "any" || host === h.host)
    && (draft.cli() === "auto" ? (member?.clis ?? enabled).some((c) => enabled.includes(c) && h.caps.includes(`cli:${c}`)) : enabled.includes(draft.cli()) && h.caps.includes(`cli:${draft.cli()}`))
    && [...draft.requirements().split(","), ...(project?.requires ?? [])].map((r) => r.trim()).filter(Boolean).every((r) => r.split("|").some((c) => h.caps.includes(c.trim()))));
}
function learningPlacementIssue(draft: TaskRunDraft, catalog: TaskRunCatalog, learningHost?: string, learningError?: string, repoHost?: string, repo?: string) {
  if (learningError) return learningError;
  if (!learningHost) return "";
  const project = catalog.effective()?.projects?.find((p) => p.id === draft.project());
  if (project && project.host !== learningHost || draft.project() === "__current__" && (!repo || repoHost !== learningHost))
    return `This folder belongs to another machine. Choose None or a project on ${learningHost}; the private learning history stays there.`;
  return "";
}
function TaskRunFields(props: { hub: Hub; draft: TaskRunDraft; catalog: TaskRunCatalog; repo?: string; repoHost?: string; taskProject?: string; learningHost?: string; learningError?: string; savedHost?: string }) {
  const { requirements, host, cli, agent, priority, title, prefer, weight, project, advanced } = props.draft;
  const enabled = () => props.catalog.effective()?.enabled_clis ?? DEFAULT_PROVIDERS;
  const projects = () => props.catalog.effective()?.projects ?? [], agents = () => props.catalog.effective()?.agents ?? [];
  const selectedProject = () => projects().find((p) => p.id === project()), selectedAgent = () => agents().find((a) => a.id === agent());
  const projectChoices = () => projects().filter((p) => !props.learningHost || p.host === props.learningHost);
  const sourceMachine = () => [...(props.hub.status()?.hosts ?? []), ...(props.hub.status()?.offline_hosts ?? [])].find((h) => h.host === props.learningHost);
  const learningIssue = () => learningPlacementIssue(props.draft, props.catalog, props.learningHost, props.learningError, props.repoHost, props.repo);
  const folderHost = () => selectedProject()?.host ?? (project() === "__current__" ? props.repoHost : undefined);
  const os = () => requirements().split(",").map((x) => x.trim()).find((x) => /^os:/.test(x)) ?? "";
  const chooseOS = (value: string) => requirements.set([...requirements().split(",").map((x) => x.trim()).filter((x) => x && !x.startsWith("os:")), value].filter(Boolean).join(","));
  const eligible = () => matchingTaskHosts(props.hub, props.draft, props.catalog, props.learningHost, props.learningError);
  return <View style={{ gap: 12 }}>
    <Text role="header" style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>Run settings</Text>
    <If when={props.learningHost} else={!props.learningError ? <Text style={{ fontSize: 13, lineHeight: 19, color: colors.muted }}>Choose an available OS if this work can run there. Platform-specific builds still need their original OS. A local project folder must exist on the machine you choose.</Text> : undefined}>
      <Text testID="task-learning-host" style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{`Learning source: ${props.learningHost} · ${!sourceMachine() || sourceMachine()?.online === false ? "Offline" : sourceMachine()?.enabled === false ? "Paused for new tasks" : "Online"}`}</Text>
      <Text style={{ fontSize: 13, lineHeight: 19, color: colors.muted }}>This task uses private history and a prepared collection on its source machine. Changing its run settings cannot move that history to another machine.</Text>
      <If when={props.savedHost && props.savedHost !== props.learningHost}><Text testID="task-learning-repair" style={{ fontSize: 13, lineHeight: 19, color: colors.warn }}>{`The saved target is ${props.savedHost}. Saving returns this learning task to ${props.learningHost}.`}</Text></If>
    </If>
    <If when={props.learningError}><Text testID="task-learning-error" style={{ fontSize: 13, lineHeight: 19, color: colors.warn, userSelect: "text" }}>{learningIssue()}</Text></If>
    <View disabled={!!props.learningError} style={{ gap: 12 }}>
    <Field testID="task-title" label="Title" value={title()} onChange={(v) => title.set(v)} />
    <Dropdown testID="task-project" label="Project" value={selectedProject()?.name ?? (project() === "__current__" ? "Current folder" : project() || "None")} selected={project()}
      options={[{ id: "", label: "None", testID: "task-project-none" }, ...(props.repo && !props.taskProject && (!props.learningHost || props.repoHost === props.learningHost) ? [{ id: "__current__", label: "Current folder", detail: props.repo, testID: "task-project-current" }] : []), ...projectChoices().map((p) => ({ id: p.id, label: p.name, detail: `${p.host} · ${p.path}`, testID: `task-project-${p.id}` }))]}
      onPick={(id) => { project.set(id); host.set(props.learningHost ?? (id === "__current__" ? props.repoHost ?? "any" : projects().find((p) => p.id === id)?.host ?? "any")); }} />
    <If when={selectedProject() || project() === "__current__"}><Text style={{ fontSize: 13, color: colors.muted }}>{`Folder: ${selectedProject()?.path ?? props.repo}. ${props.learningHost ? "Choose None to detach this folder; learning stays on its source machine." : "Choose None to use a different machine."}`}</Text></If>
    <If when={!props.learningHost && !props.learningError && folderHost() && folderHost() !== host()}><Btn testID="task-folder-machine" label={`Use folder's current machine (${folderHost()})`} kind="secondary" onPress={() => host.set(folderHost()!)} /></If>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Dropdown testID="task-os" label="OS" value={({ "os:macos": "macOS", "os:linux": "Linux", "os:windows": "Windows" } as Record<string, string>)[os()] ?? (os() || "Any OS")} selected={os()} onPick={chooseOS}
        options={[{ id: "", label: "Any OS", testID: "task-os-any" }, ...["macos", "linux", "windows"].map((o) => ({ id: `os:${o}`, label: o === "macos" ? "macOS" : o === "linux" ? "Linux" : "Windows", testID: `task-os-${o}` }))]} />
      <If when={!props.learningHost && !props.learningError}><Dropdown testID="task-machine" label="Machine" value={host() === "any" ? "Any matching machine" : host()} selected={host()} onPick={(v) => { host.set(v); if (selectedProject() && selectedProject()!.host !== v || project() === "__current__" && v !== props.repoHost) project.set(""); }}
        options={[{ id: "any", label: "Any matching machine", testID: "task-machine-any" }, ...[...(props.hub.status()?.hosts ?? []), ...(props.hub.status()?.offline_hosts ?? [])].map((h) => ({ id: h.host, label: h.host, testID: `task-machine-${h.host}`, detail: h.online === false ? "Offline" : h.enabled === false ? "Paused for new tasks" : h.stats?.diskError ? "Disk monitoring unavailable" : h.os ?? h.caps.find((c) => c.startsWith("os:")) }))]} /></If>
      <Dropdown testID="task-agent" label="Member" value={agent()} selected={agent()} onPick={(v) => agent.set(v)}
        options={agents().map((a) => ({ id: a.id, label: a.title ?? a.id, testID: `task-agent-${a.id}` }))} />
      <Dropdown testID="task-cli" label="CLI" value={cli()} selected={cli()} onPick={(v) => cli.set(v)} options={["auto", ...PROVIDER_IDS].map((id) => ({ id, label: id, testID: `task-cli-${id}`, detail: id !== "auto" && !enabled().includes(id) ? "Disabled in AI tools & onboarding" : undefined }))} />
      <Dropdown testID="task-priority" label="Priority" value={priority()} selected={priority()} onPick={(v) => priority.set(v)} options={["urgent", "high", "normal", "low"].map((id) => ({ id, label: id, testID: `task-priority-${id}` }))} />
    </View>
    <Field testID="task-requires" label="Required capabilities" value={requirements()} onChange={(v) => requirements.set(v)} hint="Comma-separated, e.g. docker, cli:cargo. Leave empty when no special capability is needed." />
    <Btn testID="task-advanced" label={advanced() ? "Hide advanced run settings" : "Advanced run settings"} kind="ghost" onPress={() => advanced.set(!advanced())} />
    <If when={advanced()}>
      <Field testID="task-prefer" label="Preferred capabilities" value={prefer()} onChange={(v) => prefer.set(v)} hint={props.learningHost ? `A soft preference on ${props.learningHost}; it does not move this learning task.` : "A soft preference, e.g. os:macos or gpu. Other machines can still run the task when a preferred machine is unavailable."} />
      <Dropdown testID="task-weight" label="Resource use" value={weight()} selected={weight()} onPick={(v) => weight.set(v)} options={[{ id: "normal", label: "Normal", testID: "task-weight-normal" }, { id: "heavy", label: "Heavy", detail: "Waits for spare resources for benchmarks or full builds", testID: "task-weight-heavy" }]} />
    </If>
    </View>
    <If when={!props.learningError}><Text testID="task-matches" style={{ fontSize: 13, lineHeight: 19, color: !learningIssue() && eligible().length ? colors.muted : colors.warn }}>{learningIssue() || (cli() !== "auto" && !enabled().includes(cli()) ? `${providerLabel(cli())} is disabled for execution. Choose another tool or enable it in Settings → AI tools & onboarding.`
      : selectedAgent()?.paused ? "This member is paused. Choose another member or enable its AI tools in Settings."
      : selectedAgent()?.tool_policy?.invalid ? "This member's task tool setting is invalid. Fix it in Settings → Members before running work."
      : cli() === "auto" && !enabled().length ? "AI execution is disabled for the team. Enable tools in Settings → AI tools & onboarding."
      : cli() === "auto" && selectedAgent()?.clis?.length === 0 ? "No enabled default task tools for this member. Choose an explicit task tool or change Settings → Members."
      : eligible().length ? `Matching machines: ${eligible().map((h) => h.host).join(", ")}` : props.learningHost ? !sourceMachine() || sourceMachine()?.online === false
        ? `The learning source machine ${props.learningHost} is offline. This task will wait for it; another machine cannot use its private history.`
        : `${props.learningHost} cannot run these settings yet. Change the tool or required capabilities, or repair that machine. The task stays on its learning source.`
        : "No connected machine is accepting tasks with these settings. Change them, resume a paused machine, or connect a matching machine.")}</Text></If>
  </View>;
}

function TaskPlacement(props: { hub: Hub; task: TaskInfo }) {
  const draft = taskRunDraft(props.task), catalog = taskRunCatalog(props.hub);
  const { requirements, host, cli, agent, priority, title, prefer, weight, project } = draft;
  const busy = signal(false), note = signal("");
  const invalidMember = () => catalog.effective()?.agents.find((a) => a.id === agent())?.tool_policy?.invalid === true;
  const learningIssue = () => learningPlacementIssue(draft, catalog, props.task.learning_host, props.task.learning_host_error, props.task.target_host, props.task.repo);
  async function save() {
    if (invalidMember() || learningIssue()) return;
    busy.set(true); note.set("");
    try {
      const r = await props.hub.api("POST", "/api/tasks/configure", { id: props.task.id, requires: requirements(), host: props.task.learning_host ?? host(), cli: cli(), agent: agent(), priority: priority(), title: title(), prefer: prefer(), weight: weight(), ...(project() === "__current__" ? {} : { project: project() }) });
      const result = r.data.data as { ok?: boolean; error?: string; queued?: boolean } | undefined;
      if (!r.ok || r.data.ok === false || result?.ok === false) note.set(String(result?.error ?? r.data.error ?? "Couldn't save task settings"));
      else note.set(result?.queued ? "Settings submitted. Waiting for the main machine to apply them." : props.task.learning_host ? `Settings saved. This learning task waits for ${props.task.learning_host} to accept its run settings.` : "Settings saved. The task will run when a matching machine has capacity.");
    } catch (e) { note.set(String((e as Error).message ?? e)); }
    finally { busy.set(false); }
  }
  return <View testID="task-placement" style={{ marginTop: 18, gap: 12, padding: 14, borderRadius: radius.inset, backgroundColor: colors.surface }}>
    <TaskRunFields hub={props.hub} draft={draft} catalog={catalog} repo={props.task.repo} repoHost={props.task.target_host} taskProject={props.task.project} learningHost={props.task.learning_host} learningError={props.task.learning_host_error} savedHost={props.task.target_host} />
    <Btn testID="task-placement-save" label="Save run settings" kind="primary" busy={busy()} disabled={busy() || invalidMember() || !!learningIssue()} onPress={() => void save()} />
    <If when={note()}><Text testID="task-placement-note" style={{ fontSize: 13, color: colors.text }}>{note()}</Text></If>
  </View>;
}

type TaskFormState = {
  draft: TaskRunDraft; instructions: Signal<string>; preview: Signal<TaskReopenPreview | undefined>;
  pending: Signal<TaskCreateRequest | TaskReopenRequest | undefined>; result: Signal<TaskFormResult | undefined>;
  knownId: Signal<string>; initialized: boolean;
};
function newTaskFormState(instructions = ""): TaskFormState {
  return { draft: taskRunDraft({ id: "", title: "", agent: "lead" }), instructions: signal(instructions), preview: signal(undefined), pending: signal(undefined), result: signal(undefined), knownId: signal(""), initialized: false };
}
function clearTaskRequest(state: TaskFormState, key: string) {
  state.pending.set(undefined); state.result.set(undefined); state.knownId.set(key === "create" ? "" : key);
}
function fillTaskRunDraft(draft: TaskRunDraft, settings: TaskRunSettings) {
  draft.title.set(settings.title); draft.agent.set(settings.agent); draft.cli.set(settings.cli); draft.host.set(settings.host); draft.requirements.set(settings.requires);
  draft.priority.set(settings.priority); draft.prefer.set(settings.prefer); draft.weight.set(settings.weight); draft.project.set(settings.project);
}

/** Keep the exact authorization and draft when a modal or page is closed during confirmation. */
function TaskForm(props: { hub: Hub; id?: string; isCurrent: () => boolean; onClose: () => void; onOpen: (id: string) => void }) {
  const formKey = props.id ?? "create", saved = props.hub.taskForms().get(formKey);
  const state = saved ?? newTaskFormState(props.id ? props.hub.taskDrafts.get(props.id)?.() ?? "" : "");
  if (!saved && props.id) state.knownId.set(props.id);
  if (!saved) props.hub.taskForms.update((all) => new Map(all).set(formKey, state));
  const { draft, instructions, preview, pending, result, knownId } = state;
  const catalog = taskRunCatalog(props.hub), busy = signal(false), note = signal(""), noteOk = signal(false), stale = signal(false);
  let generation = 0;
  cleanup(() => { generation++; });
  async function loadPreview() {
    if (!props.id || pending() || busy()) return;
    const mine = ++generation;
    busy.set(true); note.set(""); noteOk.set(false);
    const r = await props.hub.api("POST", "/api/tasks/reopen-preview", { id: props.id });
    if (mine !== generation) return;
    busy.set(false);
    const value = readTaskReopenPreview(r.data);
    if (!r.ok || value?.id !== props.id) { stale.set(true); note.set(r.status === 404 ? "Update the hub and main machine, then refresh this task to reopen it." : String(r.data.error ?? "Couldn't verify this task for reopening.")); return; }
    preview.set(value); stale.set(false);
    if (!state.initialized) { fillTaskRunDraft(draft, value.settings); state.initialized = true; }
  }
  const settings = (): TaskRunSettings => {
    const project = catalog.effective()?.projects?.find((p) => p.id === draft.project());
    return { title: draft.title(), agent: draft.agent(), cli: draft.cli(), host: preview()?.learning_host ?? draft.host(), requires: draft.requirements(), priority: draft.priority() as TaskRunSettings["priority"],
      prefer: draft.prefer(), weight: draft.weight() as TaskRunSettings["weight"], project: draft.project(),
      ...(project ? { project_guard: { host: project.host, path: project.path, requires: project.requires ?? [] } } : {}) };
  };
  const selectionIssue = () => {
    const learning = learningPlacementIssue(draft, catalog, preview()?.learning_host, preview()?.learning_host_error, preview()?.settings.host, preview()?.repo);
    if (learning) return learning;
    const effective = catalog.effective();
    if (catalog.error() || !effective) return catalog.error() || "Loading members and projects…";
    const member = effective.agents.find((a) => a.id === draft.agent());
    if (!member) return "Choose an available member before starting this task.";
    if (member.paused) return "This member is paused. Choose another member or enable its AI tools in Settings.";
    if (member.tool_policy?.invalid) return "This member's task tool setting is invalid. Fix it in Settings → Members before running work.";
    if (draft.cli() !== "auto" && !(effective.enabled_clis ?? DEFAULT_PROVIDERS).includes(draft.cli())) return "Choose an enabled AI tool before starting this task.";
    const project = effective.projects?.find((p) => p.id === draft.project());
    if (draft.project() && draft.project() !== "__current__" && !project) return "Choose a current project, or select None to detach the missing project.";
    const host = preview()?.learning_host ?? draft.host();
    if (draft.project() === "__current__" && host !== preview()?.settings.host || project && project.host !== host) return "The folder's machine changed. Use its current machine, or select None to use another machine.";
    return "";
  };
  async function send(request: TaskCreateRequest | TaskReopenRequest) {
    if (busy()) return;
    const previous = pending();
    if (previous && previous.request_id !== request.request_id) return;
    busy.set(true); note.set(""); noteOk.set(false);
    try {
      const entry: PendingEntry = { kind: "task", key: formKey, at: props.hub.savedAt("task", formKey), request, ...(props.id ? { preview: preview() } : {}), ...(knownId() ? { known_id: knownId() } : {}) };
      if (!await props.hub.keepPending(entry)) { note.set(props.hub.savedError() || "Wait for saved requests to finish loading before submitting."); return; }
      pending.set({ ...request, confirm_only: undefined });
      const r = await props.hub.api("POST", props.id ? "/api/tasks/reopen" : "/api/tasks/create", request);
      if (pending()?.request_id !== request.request_id) return;
      const value = readTaskFormResult(r.data), action = props.id ? "reopen" : "create";
      const valid = value?.request_id === request.request_id && value.action === action && (!props.id || value.id === props.id) && (!knownId() || value.id === knownId());
      if (r.data.request_id === request.request_id && r.data.action === action && typeof r.data.id === "string" && /^T-[\w-]*\d{4}$/.test(r.data.id) && (!props.id || r.data.id === props.id) && (!knownId() || r.data.id === knownId())) knownId.set(r.data.id);
      if (r.ok && valid) {
        result.set(value); knownId.set(value.id);
        if (!await props.hub.dropPending("task", formKey, request.request_id)) { note.set("Task request confirmed, but its local recovery copy could not be cleared. Reload saved requests and check it again."); return; }
        pending.set(undefined); noteOk.set(true);
        note.set(value.replayed ? "Earlier task request confirmed. Open the task to check its current run." : props.id ? "Task reopened with these run settings." : "Task created with these run settings.");
        if (props.id && props.hub.taskDrafts.get(props.id)?.() === instructions()) props.hub.taskDrafts.get(props.id)?.set("");
        void props.hub.refreshStatus(); return;
      }
      if (knownId()) await props.hub.keepPending({ ...entry, known_id: knownId() });
      if (r.data.saved_locally && valid) result.set(value);
      note.set(r.status === 404 && !request.confirm_only ? "Update the hub and main machine to create and reopen tasks from this form." : String(r.data.error ?? "Couldn't confirm this task request. Check the saved request before starting another one."));
      if (!(r.status === 0 || r.status === 202 || r.status >= 500 || r.data.saved_locally || r.data.pending || r.data.uncertain) && !request.confirm_only && await props.hub.dropPending("task", formKey, request.request_id)) { pending.set(undefined); stale.set(!!props.id); }
    } finally { busy.set(false); }
  }
  async function submit() {
    if (busy() || pending() || result() || selectionIssue() || props.id && (!preview()?.can_reopen || stale())) return;
    const request = { request_id: crypto.randomUUID(), instructions: instructions(), settings: settings(), ...(props.id ? { id: props.id, preview_digest: preview()!.digest } : {}) };
    if (!(props.id ? validTaskReopenRequest(request) : validTaskCreateRequest(request))) { noteOk.set(false); note.set("Enter instructions and a one-line title (up to 120 characters), and check the run settings before submitting."); return; }
    await send(request);
  }
  async function fresh() {
    if (busy()) return;
    if (pending()) {
      const answer = await AlertDialog.show({ title: "Start a fresh task request?", description: props.id ? "The earlier request may still finish. Inspect or confirm it first. A fresh preview will check the task again before reopening." : "The earlier task may still be created. Inspect or confirm it first to avoid duplicate work. Starting fresh authorizes another task.",
        actions: [{ id: "keep", label: "Keep pending request", role: "cancel" }, { id: "fresh", label: props.id ? "Refresh preview" : "Start fresh" }] });
      if (answer.action !== "fresh") return;
      if (!await props.hub.dropPending("task", formKey, pending()!.request_id)) { noteOk.set(false); note.set(props.hub.savedError()); return; }
    }
    pending.set(undefined); result.set(undefined); note.set(""); noteOk.set(false); stale.set(!!props.id); knownId.set(props.id ?? "");
    busy.set(true);
    await catalog.load();
    busy.set(false);
    if (props.id) await loadPreview();
  }
  async function openTask() {
    const id = knownId(); if (!id || busy()) return;
    const mine = ++generation;
    busy.set(true);
    const r = await props.hub.api("GET", `/api/tasks/get?id=${encodeURIComponent(id)}`);
    busy.set(false);
    if (mine !== generation || !props.isCurrent()) return;
    if (!r.ok || r.data.id !== id) { noteOk.set(false); note.set(String(r.data.error ?? "This task isn't currently available. Check the same saved request before starting another one.")); return; }
    props.onOpen(id);
  }
  if (props.id && !pending() && !result()) void loadPreview();
  return <Dialog testID="task-form" open onOpenChange={({ open }) => { if (!open && !busy()) props.onClose(); }} animation="fade" backdropClass="bg-scrim" style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "box-none" }}>
    <View style={{ width: "100%", maxWidth: 680, maxHeight: "100%", borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "center", height: 56, paddingLeft: 20, paddingRight: 10, borderBottomWidth: .5, borderBottomColor: surfaceEdge() }}>
        <Text role="header" style={{ flex: 1, fontSize: 17, fontWeight: "600", color: colors.text }}>{props.id ? `Reopen ${props.id}` : "New task"}</Text>
        <Btn testID="task-form-close" label="Close" kind="ghost" disabled={busy()} onPress={props.onClose} />
      </View>
      <Scroll style={{ flexShrink: 1 }}><View style={{ padding: 20, gap: 14 }}>
        <Text style={{ fontSize: 14, lineHeight: 20, color: colors.muted }}>{props.id ? "Keep this task's ID and history. New instructions start another attempt with the run settings below." : "Choose instructions and run settings together before the task enters the queue."}</Text>
        <If when={preview()}>{(value) => <>
          <Text testID="task-form-state" style={{ fontSize: 13, color: colors.muted }}>{`Previous state: ${STATE_OF()[value().state]?.[0] ?? value().state}`}</Text>
          <Each of={[...value().conflicts, ...value().warnings]}>{(warning) => <Text testID="task-form-warning" style={{ fontSize: 13, lineHeight: 19, color: colors.warn }}>{warning()}</Text>}</Each>
        </>}</If>
        <View disabled={busy() || !!pending() || !!result() || !!props.hub.savedError() || props.hub.savedLoading() || !!props.id && !preview() || !!preview()?.learning_host_error} style={{ gap: 14 }}>
          <TextArea testID="task-form-instructions" label={props.id ? "New instructions" : "Instructions"} value={instructions()} onChange={(v) => instructions.set(v)} height={110} placeholder="Describe the work to run" />
          <TaskRunFields hub={props.hub} draft={draft} catalog={catalog} repo={preview()?.repo} repoHost={preview()?.settings.host} taskProject={preview()?.settings.project === "__current__" ? undefined : preview()?.settings.project} learningHost={preview()?.learning_host} learningError={preview()?.learning_host_error} />
        </View>
        <If when={selectionIssue() && !pending() && !result()}><Text testID="task-form-selection-error" style={{ fontSize: 13, lineHeight: 19, color: colors.warn }}>{selectionIssue()}</Text></If>
        <If when={!pending() && !result()}><Btn testID="task-form-submit" kind="primary" label={matchingTaskHosts(props.hub, draft, catalog, preview()?.learning_host, preview()?.learning_host_error).length ? props.id ? "Reopen task" : "Create task" : props.id ? preview()?.learning_host ? `Reopen and wait for ${preview()!.learning_host}` : "Reopen and wait for a matching machine" : "Queue until a matching machine is available"}
          disabled={busy() || !!props.hub.savedError() || props.hub.savedLoading() || !!selectionIssue() || !instructions().trim() || !draft.title().trim() || !!props.id && (!preview()?.can_reopen || stale())} busy={busy()} onPress={() => void submit()} /></If>
        <If when={pending()}>{(request) => <View style={{ gap: 8 }}>
          <Btn testID="task-form-confirm" label="Check saved task request" kind="primary" disabled={busy()} busy={busy()} onPress={() => void send({ ...request(), confirm_only: true })} />
          <Btn testID="task-form-retry" label="Retry same request" disabled={busy()} onPress={() => void send(request())} />
        </View>}</If>
        <If when={note()}><Text testID="task-form-note" style={{ fontSize: 13, lineHeight: 19, color: noteOk() ? colors.up : colors.danger }}>{note()}</Text></If>
        <Each of={result()?.warnings ?? []}>{(warning) => <Text style={{ fontSize: 13, color: colors.warn }}>{warning()}</Text>}</Each>
        <If when={knownId() && (pending() || result())}><Btn testID="task-form-open" label={pending() ? "Inspect current task" : "Open task"} kind="secondary" disabled={busy()} onPress={() => void openTask()} /></If>
        <Btn testID="task-form-refresh" label={props.id ? "Refresh task preview and settings" : pending() || result() ? "Start a fresh task request" : "Reload members and projects"} kind="ghost" disabled={busy()} onPress={() => void fresh()} />
      </View></Scroll>
    </View>
  </Dialog>;
}

/** A local empty batch still needs a checked retry when its final synchronization failed. */
function stopAttempt(data: Record<string, unknown>, previous?: PendingStops): PendingStops | undefined {
  const cleanup = data.cleanup as { operation_id?: unknown; pending?: unknown; unresolved?: unknown } | undefined;
  return readPendingStops(data.stops) ?? readPendingStops((data.plan as PlanInfo | undefined)?.pending_stops)
    ?? readPendingStops((data.task as TaskInfo | undefined)?.stops)
    ?? (previous && cleanup?.operation_id === previous.operation_id ? readPendingStops({ ...previous, pending: cleanup.pending, unresolved: cleanup.unresolved }) : previous);
}

type StopReviewIntent = StopResolveRequest;

function RemainingStops(props: { hub: Hub; owner: StopOwner; batch?: PendingStops; error?: string; busy: boolean; onRetry: (operation_id: string) => void; onRefresh: () => void; onReviewed: (data: Record<string, unknown>, saved: boolean) => void }) {
  const ownerKey = `${props.owner.kind}:${props.owner.id}`;
  const intent = computed(() => props.hub.stopReviews().get(ownerKey)?.intent);
  const reviewing = signal<string | undefined>(undefined), loadedPreview = signal<StopReviewPreview | undefined>(undefined);
  const preview = () => intent() ? props.hub.stopReviews().get(ownerKey)?.preview : loadedPreview();
  const reviewBusy = signal(false), reviewError = signal(""), previewRejected = signal(false), reason = signal("");
  let generation = 0;
  const close = () => { if (!reviewBusy()) { generation++; reviewing.set(undefined); if (!intent()) loadedPreview.set(undefined); } };
  async function inspect(id: string) {
    if (intent()) { reviewing.set(intent()!.target_id); return; }
    const batch = props.batch;
    if (!batch || reviewBusy() || props.busy) return;
    const request = ++generation;
    reviewing.set(id); loadedPreview.set(undefined); reviewError.set(""); previewRejected.set(false);
    reviewBusy.set(true);
    const r = await props.hub.api("POST", "/api/stops/review", { owner: props.owner, operation_id: batch.operation_id, target_id: id });
    if (request !== generation) return;
    const value = readStopReviewPreview(r.data);
    if (r.ok && value && value.owner.id === props.owner.id && value.owner.kind === props.owner.kind && value.operation_id === batch.operation_id && value.target_id === id) loadedPreview.set(value);
    else reviewError.set(r.status === 404 ? "Update the main machine to review saved cleanup requests." : String(r.data.error ?? "Couldn't load this cleanup review. Refresh before making a decision."));
    reviewBusy.set(false);
  }
  async function submit(request: StopReviewIntent) {
    if (reviewBusy()) return;
    if (intent() && intent()!.request_id !== request.request_id) { reviewError.set("Confirm the pending cleanup review before making another decision."); return; }
    const captured = preview();
    reviewBusy.set(true); reviewError.set("");
    if (!await props.hub.keepPending({ kind: "stop", key: ownerKey, at: props.hub.savedAt("stop", ownerKey), request, preview: captured })) { reviewBusy.set(false); reviewError.set(props.hub.savedError() || "Wait for saved requests to finish loading before submitting."); return; }
    props.hub.stopReviews.update((saved) => new Map(saved).set(ownerKey, { intent: request, preview: captured }));
    const r = await props.hub.api("POST", "/api/stops/resolve", request);
    if (intent()?.request_id !== request.request_id) { reviewBusy.set(false); return; }
    if (r.ok || r.data.saved_locally) props.onReviewed(r.data, r.ok);
    if (r.ok) {
      if (!await props.hub.dropPending("stop", ownerKey, request.request_id)) { reviewBusy.set(false); reviewError.set("Decision confirmed, but its local recovery copy could not be cleared. Reload saved requests and retry the same decision."); return; }
      props.hub.stopReviews.update((saved) => { const next = new Map(saved); if (next.get(ownerKey)?.intent.request_id === request.request_id) next.delete(ownerKey); return next; });
      reviewBusy.set(false);
      close();
      if (request.action === "include" && Number((r.data.cleanup as { remaining?: number } | undefined)?.remaining) > 0) props.onRetry(request.operation_id);
      return;
    }
    reviewError.set(String(r.data.error ?? "Couldn't save this cleanup review."));
    if (!(r.status === 0 || r.status === 202 || r.status >= 500 || r.data.pending || r.data.uncertain || r.data.saved_locally)) {
      if (!await props.hub.dropPending("stop", ownerKey, request.request_id)) { reviewBusy.set(false); reviewError.set(`${reviewError()} The saved decision is kept until local storage recovers.`); return; }
      loadedPreview.set(captured); reason.set(request.reason); previewRejected.set(r.status === 409);
      props.hub.stopReviews.update((saved) => { const next = new Map(saved); if (next.get(ownerKey)?.intent.request_id === request.request_id) next.delete(ownerKey); return next; });
    }
    reviewBusy.set(false);
  }
  async function decide(action: StopReviewIntent["action"]) {
    const value = preview(), text = reason().trim();
    if (!value || reviewBusy() || intent() || previewRejected() || !text || text.length > 500 || action === "include" && !value.can_include) return;
    const request: StopReviewIntent = { owner: value.owner, operation_id: value.operation_id, target_id: value.target_id, preview_digest: value.preview_digest, action, reason: text, request_id: crypto.randomUUID() };
    if (!validStopResolveRequest(request)) { reviewError.set("Enter a reason of 1–500 characters on one line."); return; }
    const confirmation = await AlertDialog.show({
      title: `${action === "include" ? "Include" : "Exclude"} ${value.target_id} ${action === "include" ? "in" : "from"} cleanup?`,
      description: action === "include" ? "This authorizes cleanup of the selected task and the related work shown in this review. A changed task requires a fresh review. Your reason is recorded."
        : "This removes the task from future cleanup retries. An earlier stop request may still finish. The task may keep running, and this cleanup can finish without stopping it. Your reason is recorded.",
      actions: [{ id: "back", label: "Back", role: "cancel" }, { id: "confirm", label: action === "include" ? "Include reviewed task" : "Exclude from cleanup", ...(action === "exclude" ? { role: "destructive" as const } : {}) }],
    });
    if (confirmation.action === "confirm") await submit(request);
  }
  const count = () => (props.batch?.pending.length ?? 0) + (props.batch?.unresolved.length ?? 0);
  return <><If when={props.batch || props.error}>
    <View testID="stop-progress" style={{ marginTop: 12, padding: 14, borderRadius: radius.inset, borderWidth: 0.5, borderColor: colors.border, backgroundColor: tints.warn, gap: 10 }}>
      <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>{props.error ? "Stop request needs review" : count() ? `${count()} remaining stop${count() === 1 ? "" : "s"}` : "Confirm cleanup synchronization"}</Text>
      <Text style={{ fontSize: 13, lineHeight: 19, color: colors.muted }}>{props.error || count() ? "These requests keep the original runs. Newer runs need a separate confirmation." : "Confirm that the team has received the cleanup result and recorded reviews."}</Text>
      <If when={props.error}><Text testID="stop-data-error" style={{ fontSize: 13, lineHeight: 19, color: colors.danger }}>{props.error}</Text></If>
      <Each of={props.batch?.pending ?? []} key={(target) => `${target.id}:${target.run_id}`}>
        {(target) => <View style={{ gap: 3 }}>
          <Btn testID={`stop-target-${target().id}`} label={`${target().id} · ${target().host}`} kind="ghost" onPress={() => taskLink(target().id)} />
          <Text style={{ fontFamily: MONO, fontSize: 11, color: colors.faint, userSelect: "text" }}>{`Run ${target().run_id}`}</Text>
          <If when={target().error}><Text style={{ fontSize: 13, lineHeight: 18, color: colors.danger }}>{target().error}</Text></If>
          <Btn testID={`stop-review-${target().id}`} label="Review this stop" kind="secondary" disabled={props.busy || reviewBusy() || !!intent()} onPress={() => { reason.set(""); void inspect(target().id); }} />
        </View>}
      </Each>
      <Each of={props.batch?.unresolved ?? []} key={(target) => target.id}>
        {(target) => <View style={{ gap: 3 }}>
          <Btn testID={`stop-unresolved-${target().id}`} label={`Inspect ${target().id}`} kind="ghost" onPress={() => taskLink(target().id)} />
          <Text style={{ fontSize: 13, lineHeight: 18, color: colors.danger }}>{target().error}</Text>
          <Btn testID={`stop-review-${target().id}`} label="Review this stop" kind="secondary" disabled={props.busy || reviewBusy() || !!intent()} onPress={() => { reason.set(""); void inspect(target().id); }} />
        </View>}
      </Each>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <If when={props.batch && !props.error}><Btn testID="stop-retry" label={count() ? "Retry remaining stops" : "Confirm cleanup"} kind="secondary" disabled={props.busy || reviewBusy()} busy={props.busy} onPress={() => { const batch = props.batch; if (batch) props.onRetry(batch.operation_id); }} /></If>
        <Btn testID="stop-refresh" label="Refresh progress" kind="ghost" disabled={props.busy || reviewBusy()} onPress={props.onRefresh} />
      </View>
    </View>
  </If>
  <If when={intent() && reviewing() === undefined}><Btn testID="stop-review-resume" label="Review saved decision" kind="secondary" onPress={() => { const request = intent(); if (request) reviewing.set(request.target_id); }} /></If>
  <Dialog testID="stop-review-dialog" open={reviewing() !== undefined} onOpenChange={({ open }) => { if (!open) close(); }} animation="fade" backdropClass="bg-scrim" style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "box-none" }}>
    <View style={{ width: "100%", maxWidth: 620, maxHeight: "100%", borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 20, paddingRight: 10, height: 56, borderBottomWidth: .5, borderBottomColor: surfaceEdge() }}>
        <Text style={{ flex: 1, fontSize: 17, fontWeight: "600", color: colors.text }}>{`Review ${reviewing() ?? ""}`}</Text>
        <Btn testID="stop-review-close" label="Close" kind="ghost" disabled={reviewBusy()} onPress={close} />
      </View>
      <Scroll style={{ flexShrink: 1 }}><View style={{ gap: 14, padding: 20 }}>
        <If when={preview()} else={<Text style={{ fontSize: 14, color: colors.muted }}>{reviewBusy() ? "Loading review…" : "Refresh to inspect the current task state."}</Text>}>
          {(value) => <>
            <If when={value().target.kind === "pending"}><Text style={{ fontSize: 12, lineHeight: 18, color: colors.faint, userSelect: "text" }}>{`Saved request: ${value().target.host} · run ${value().target.run_id}`}</Text></If>
            <Text testID="stop-review-state" style={{ fontSize: 14, lineHeight: 21, color: colors.text }}>{`Current state: ${value().current.state}`}</Text>
            <Each of={value().current.records} key={(record) => `${record.state}:${record.host}:${record.run_id}`}>
              {(record) => <View style={{ gap: 4 }}>
                <Text style={{ fontSize: 14, lineHeight: 20, color: colors.text }}>{record().title}</Text>
                <Text style={{ fontSize: 13, lineHeight: 19, color: colors.muted }}>{[record().state, record().host].filter(Boolean).join(" · ")}</Text>
                <If when={record().run_id}><Text testID="stop-review-run" style={{ fontFamily: MONO, fontSize: 11, color: colors.faint, userSelect: "text" }}>{`Run ${record().run_id}`}</Text></If>
              </View>}
            </Each>
            <If when={value().related?.length}><View style={{ gap: 8 }}>
              <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{`${value().related!.length} related task${value().related!.length === 1 ? "" : "s"} in this review`}</Text>
              <Each of={value().related ?? []} key={(related) => related.id}>
                {(related) => <View testID={`stop-review-related-${related().id}`} style={{ gap: 3 }}>
                  <Text style={{ fontSize: 13, color: colors.text }}>{`${related().id} · ${related().current.state}`}</Text>
                  <Each of={related().current.records} key={(record) => `${record.state}:${record.host}:${record.run_id}`}>
                    {(record) => <Text style={{ fontSize: 12, lineHeight: 18, color: colors.muted, userSelect: "text" }}>{[record().title, record().host, record().run_id ? `Run ${record().run_id}` : undefined].filter(Boolean).join(" · ")}</Text>}
                  </Each>
                </View>}
              </Each>
            </View></If>
            <If when={value().include_reason}><Text style={{ fontSize: 13, lineHeight: 19, color: colors.warn }}>{value().include_reason}</Text></If>
            <View disabled={!!intent() || reviewBusy()}><Field testID="stop-review-reason" label="Reason for this review" value={intent()?.reason ?? reason()} onChange={(text) => reason.set(text)} hint="Required, up to 500 characters on one line. This stays in the cleanup review history." /></View>
            <If when={!intent()}><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Btn testID="stop-review-include" label="Include reviewed task" kind="primary" disabled={reviewBusy() || previewRejected() || !value().can_include || !reason().trim() || reason().trim().length > 500} onPress={() => void decide("include")} />
              <Btn testID="stop-review-exclude" label="Exclude from cleanup" kind="danger" disabled={reviewBusy() || previewRejected() || !reason().trim() || reason().trim().length > 500} onPress={() => void decide("exclude")} />
            </View></If>
          </>}
        </If>
        <If when={reviewError()}><Text testID="stop-review-error" style={{ fontSize: 13, lineHeight: 19, color: colors.danger }}>{reviewError()}</Text></If>
        <If when={intent()}><View style={{ gap: 8 }}><Text style={{ color: colors.warn, fontSize: 13, lineHeight: 19 }}>Retrying may apply your original decision if it was not saved. It keeps the original target and reason, and does not choose a newer run.</Text><Btn testID="stop-review-check" label="Retry same decision" kind="secondary" busy={reviewBusy()} disabled={reviewBusy() || props.hub.savedLoading() || !!props.hub.savedError()} onPress={() => { const request = intent(); if (request) void submit(request); }} /></View></If>
        <If when={!intent()}><Btn testID="stop-review-refresh" label="Refresh review" kind="ghost" disabled={reviewBusy()} onPress={() => { const id = reviewing(); if (id) void inspect(id); }} /></If>
      </View></Scroll>
    </View>
  </Dialog></>;
}

function StopReviewHistory(props: { reviews: StopReviewAudit[] }) {
  return <If when={props.reviews.length}><View testID="stop-review-history" style={{ marginTop: 14, gap: 10, padding: 14, borderWidth: .5, borderColor: colors.border, borderRadius: radius.inset }}>
    <Text role="header" style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>Cleanup reviews</Text>
    <Each of={props.reviews} key={(review) => review.review_id}>
      {(review) => <View testID={`stop-reviewed-${review().target_id}`} style={{ gap: 4 }}>
        <Text style={{ fontSize: 13.5, lineHeight: 20, color: review().action === "exclude" ? colors.warn : colors.text }}>{review().action === "exclude" ? `Excluded ${review().target_id} from cleanup. The task may continue running.` : `Included ${review().target_id} for cleanup.`}</Text>
        <Text style={{ fontSize: 13, lineHeight: 19, color: colors.muted, userSelect: "text" }}>{review().reason}</Text>
        <Text style={{ fontSize: 11, color: colors.faint }}>{review().at}</Text>
      </View>}
    </Each>
  </View></If>;
}

function TaskDetail(props: { hub: Hub; id: string; wide: boolean; isCurrent: () => boolean }) {
  // a task past the status snapshot's newest few is read on its own
  const older = signal<(TaskInfo & { decisions?: string[]; events?: HubEvent[] }) | null>(null);
  const detailSnapshot = signal<Status | null>(null);
  const missing = signal(false);
  const t = () => {
    const s = props.hub.status();
    const current = [...(s?.active ?? []), ...(s?.recent ?? [])].find((x) => x.id === props.id), detail = older();
    if (current?.state === "active" && current.run_id && detail?.run_id !== current.run_id) return current;
    if (detail?.id === props.id && detail.state && detailSnapshot() === s) return detail;
    if (current?.state === "active" && current.run_id && current.run_id === detail?.run_id && ["done", "cancelled", "failed"].includes(detail.state ?? "")) return detail;
    return current ?? detail ?? undefined;
  };
  const section = (title: string) => (
    <Text role="header" style={{ fontSize: 13, fontWeight: "600", color: colors.muted, marginTop: 24, marginBottom: 8 }}>{title}</Text>
  );
  const cancellable = () => ["active", "inbox", "nohost", "waiting", "parked", "blocked", "proposed"].includes(t()?.state ?? "");
  type Control = { key: string; done: boolean; queued?: true; expected?: { host: string; run_id: string } };
  const cancelling = signal(false), editingRun = signal(false), reopening = signal(false), actionError = signal(""), actionNotice = signal("");
  const pendingControl = signal<Control | null>(null);
  const cleanupBusy = signal(false), cleanupError = signal("");
  const cleanupAttempt = signal<PendingStops | undefined>(undefined);
  const stopState = () => older() ?? t();
  const stops = () => stopState()?.stops ?? cleanupAttempt();
  const stopError = () => stopState()?.stops_error;
  const stopOwner = () => stopState()?.stop_owner;
  const pendingReopen = () => props.hub.taskForms().get(props.id)?.pending();
  const startReopen = () => {
    const saved = props.hub.taskForms().get(props.id);
    if (saved?.result() && !saved.pending()) props.hub.taskForms.update((all) => { const next = new Map(all); next.delete(props.id); return next; });
    reopening.set(true);
  };
  async function retryStops(operation_id: string) {
    const batch = stops();
    if (!batch || cleanupBusy() || cancelling()) return;
    if (batch.operation_id !== operation_id) { cleanupError.set("The cleanup operation changed. Review its latest progress before retrying."); return; }
    cleanupBusy.set(true); cleanupError.set("");
    const r = await props.hub.api("POST", "/api/tasks/stops/retry", { id: props.id, operation_id: batch.operation_id });
    if (r.data.task) older.set(r.data.task as TaskInfo);
    if (!r.ok) { cleanupAttempt.set(stopAttempt(r.data, batch)); cleanupError.set(String(r.data.error ?? "Couldn't confirm the remaining stops")); }
    else { cleanupAttempt.set(undefined); pendingControl.set(null); actionError.set(""); }
    cleanupBusy.set(false);
    await refreshTask();
  }
  async function readTask() {
    const snapshot = props.hub.status();
    const r = await props.hub.api("GET", `/api/tasks/get?id=${encodeURIComponent(props.id)}`);
    if (r.ok && r.data.id !== props.id) return { ok: false, status: 502, data: { error: "Could not verify this task's identity. Refresh its details before changing it." } };
    if (r.ok) {
      const task = r.data as TaskInfo;
      older.set(task);
      detailSnapshot.set(snapshot);
      const attempted = cleanupAttempt();
      if (attempted && task.stops?.operation_id === attempted.operation_id) cleanupAttempt.set(task.stops);
      else if (attempted && !task.stops && !task.stops_error && ["done", "cancelled", "failed"].includes(task.state ?? ""))
        cleanupAttempt.set({ ...attempted, pending: [], unresolved: [] });
      const pending = pendingControl();
      if (pending && (task.state && !["active", "inbox", "nohost", "waiting", "parked", "blocked", "proposed"].includes(task.state)
        || pending.expected && task.run_id && task.run_id !== pending.expected.run_id || pending.queued && task.state === "active")) pendingControl.set(null);
    } else if (r.status === 404) missing.set(true);
    return r;
  }
  async function refreshTask() { await props.hub.refreshStatus(); return readTask(); }
  // Other devices and background recovery can change a terminal task's cleanup too.
  poll(() => { if (!cleanupBusy() && !cancelling()) void readTask(); });
  async function prepareControl(done: boolean): Promise<Control | null> {
    if (cancelling() || cleanupBusy()) return null;
    cancelling.set(true);
    const capability = await props.hub.api("GET", "/api/stops/capabilities");
    cancelling.set(false);
    if (!capability.ok || capability.data.family_stops !== 1) { actionError.set("Connect or update the main machine to confirm task-family stops."); return null; }
    let task = t();
    if (task?.state !== "active") return { done, queued: true, key: newRequestKey() };
    if (!validMachineHost(task.host) || !validRunId(task.run_id)) {
      const r = await refreshTask();
      if (r.ok) task = r.data as TaskInfo;
      if (!task || task.state !== "active" || !validMachineHost(task.host) || !validRunId(task.run_id)) {
        actionError.set("Refresh this task after updating its machine to use run-specific controls."); return null;
      }
    }
    return { done, key: newRequestKey(), expected: { host: task.host!, run_id: task.run_id! } };
  }
  async function endTask(control: Control) {
    if (cancelling()) return;
    cancelling.set(true); actionError.set(""); actionNotice.set("");
    const r = await props.hub.api("POST", "/api/tasks/cancel", { id: props.id, ...(control.done ? { done: true } : {}), ...(control.queued ? { queued: true } : {}), ...control.expected }, control.key);
    cancelling.set(false);
    if (!r.ok) {
      pendingControl.set(r.status === 0 || r.status === 202 || r.data.pending === true || r.data.uncertain === true || r.data.saved_locally === true ? control : null);
      if (r.data.saved_locally) cleanupAttempt.set(stopAttempt(r.data, stops()));
      actionError.set(String(r.data.error ?? `Could not ${control.done ? "finish" : "cancel"} this task. Try again.`));
      if (r.status === 409 || r.data.saved_locally) await refreshTask();
      return;
    }
    pendingControl.set(null);
    actionNotice.set(control.done ? "Marked done." : "Cancellation confirmed.");
    await refreshTask();
    const current = t();
    if (current?.state === "active" && current.run_id && (control.queued || current.run_id !== control.expected?.run_id))
      actionNotice.set("Earlier request confirmed. This task has a newer run; review it before taking another action.");
  }
  async function cancel() {
    const control = await prepareControl(false);
    if (!control) return;
    const running = t()?.state === "active";
    const r = await AlertDialog.show({
      title: `Cancel ${props.id}?`,
      description: running ? "The running agent will be stopped; changes it already made stay in the repo." : "This task will not run again.",
      actions: [
        { id: "keep", label: "Keep task", role: "cancel" },
        { id: "cancel", label: "Cancel task", role: "destructive" },
      ],
    });
    if (r.action !== "cancel") return;
    await endTask(control);
  }
  // the owner already finished it himself (merged by hand, …): end it as done, not cancelled
  async function finish() {
    const control = await prepareControl(true);
    if (!control) return;
    const r = await AlertDialog.show({
      title: `Mark ${props.id} as done?`,
      description: t()?.state === "active" ? "The running agent will be stopped and the task is recorded as done." : "The task is recorded as done and will not run again.",
      actions: [
        { id: "keep", label: "Back", role: "cancel" },
        { id: "done", label: "Mark done" },
      ],
    });
    if (r.action !== "done") return;
    await endTask(control);
  }
  // the task is its own conversation: what the owner and the team said about it, and a box to keep talking
  const saying = signal<HubEvent[]>([]);
  const talk = computed(() => {
    const refs = new Set([props.id, ...(older()?.decisions ?? []), ...(t()?.decision ? [t()!.decision!] : [])]);
    return merge(merge(older()?.events ?? [], props.hub.events()), saying()).filter((e) => !!e.ref && refs.has(e.ref) && (e.thread || !(isHub(e.from) && e.kind === "system")));
  });
  const settled = computed(() => answeredIds(talk()));
  const text = props.hub.taskDrafts.get(props.id) ?? signal("");
  props.hub.taskDrafts.set(props.id, text);
  const note = signal("");
  const hint = signal("");
  let said = 0;
  async function say() {
    const v = text().trim();
    if (!v) return;
    if (t()?.state === "cancelled") { note.set("Reopen this task with instructions and run settings before continuing."); return; }
    // reads as sent at once; only a failure brings the words back to the box, with the reason
    const id = `local:${++said}`;
    saying.update((l) => [...l, { id, ts: new Date().toISOString(), from: "owner", kind: "owner", ref: props.id, thread: true, text: v }]);
    text.set("");
    note.set("");
    try {
      await props.hub.send(v, props.id, [], true);
    } catch (e) {
      text.update((now) => (now.trim() ? `${v}\n${now}` : v));
      note.set(String((e as Error)?.message ?? e));
    }
    saying.update((l) => l.filter((x) => x.id !== id));
  }
  const composerHeight = signal(0);
  return (
    <View style={{ flex: 1 }}>
    <Scroll style={{ flex: 1 }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", paddingHorizontal: props.wide ? 32 : 16, paddingTop: 24, paddingBottom: composerHeight() + 24 }}>
        <If when={t()} else={<Text style={{ fontSize: 15, color: colors.muted }}>{missing() ? `Can't find ${props.id}.` : "Loading…"}</Text>}>
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Badge label={t()!.state === "nohost" ? `Waiting for a ${needsLabel(t()!.needs)}` : STATE_OF()[t()!.state ?? ""]?.[0] ?? t()!.state ?? ""} tone={t()!.state === "failed" ? "danger" : t()!.state === "blocked" ? "warn" : "neutral"} />
              <Text style={{ fontFamily: MONO, fontSize: 13, color: colors.muted }}>{t()!.id}</Text>
              <View style={{ flex: 1 }} />
              <If when={cancellable() && !cancelling() && !pendingControl() && !cleanupBusy() && !stops() && !stopError() && !stopOwner()}>
                <Btn testID="finish-task" label="Done" kind="ghost" icon="check" onPress={() => void finish()} />
                <Btn testID="cancel-task" label="Cancel task" kind="ghost" icon="close" onPress={() => void cancel()} />
              </If>
              <If when={cancelling()}>
                <Text style={{ fontSize: 13, color: colors.muted }}>Working…</Text>
              </If>
              <If when={pendingControl() && !cancelling() && !cleanupBusy() && !stops() && !stopError() && !stopOwner()}>
                <Btn testID="task-control-check" label="Check same request" kind="secondary" onPress={() => { const control = pendingControl(); if (control) void endTask(control); }} />
              </If>
            </View>
            <If when={actionError()}><Text testID="task-action-error" style={{ fontSize: 13, lineHeight: 19, color: colors.danger }}>{actionError()}</Text></If>
            <If when={actionError()}><Btn testID="task-control-refresh" label="Refresh task" kind="ghost" onPress={() => void refreshTask()} /></If>
            <If when={actionNotice()}><Text testID="task-action-notice" style={{ fontSize: 13, lineHeight: 19, color: colors.muted }}>{actionNotice()}</Text></If>
            <Text style={{ userSelect: "text", fontSize: 20, fontWeight: "600", color: colors.text }}>{t()!.title}</Text>
            <Text style={{ fontSize: 14, color: colors.muted }}>
              {[displayName(t()!.agent), t()!.host, t()!.model ?? t()!.cli,
                t()!.started ? `Started ${clock(t()!.started!)}` : "",
                t()!.state === "active" ? `Running for ${since(t()!.started)}` : t()!.finished ? `Took ${since(t()!.started, t()!.finished)}` : "",
                Number(t()!.attempt ?? 1) > 1 ? `Attempt ${t()!.attempt}` : ""].filter(Boolean).join(" · ")}
            </Text>
          </View>
          <RemainingStops hub={props.hub} owner={{ kind: "task", id: props.id }} batch={stops()} error={stopError()} busy={cleanupBusy() || cancelling()} onRetry={(operation_id) => void retryStops(operation_id)} onRefresh={() => void refreshTask()}
            onReviewed={(data, saved) => {
              const batch = stopAttempt(data, stops());
              if ((data.task as TaskInfo | undefined)?.id === props.id) older.set(data.task as TaskInfo);
              cleanupAttempt.set(saved ? undefined : batch);
              cleanupError.set(saved ? "" : String(data.error ?? "Review saved locally; synchronization is unconfirmed."));
              if (saved) { actionError.set(""); pendingControl.set(null); }
            }} />
          <StopReviewHistory reviews={stopState()?.stop_reviews ?? cleanupAttempt()?.reviews ?? []} />
          <If when={pendingReopen() || ["done", "failed", "cancelled"].includes(t()!.state ?? "")}>
            <Btn testID="task-reopen" label={pendingReopen() ? "Check task reopening" : "Reopen with run settings"} kind="secondary"
              disabled={cancelling() || cleanupBusy() || !pendingReopen() && (hasPendingStops(stops()) || !!stopError() || !!stopOwner())} onPress={startReopen} />
          </If>
          <If when={cleanupError()}><Text testID="stop-error" style={{ marginTop: 8, fontSize: 13, lineHeight: 19, color: colors.danger }}>{cleanupError()}</Text></If>
          <If when={stopOwner()}><View style={{ marginTop: 12, gap: 6 }}>
            <Text style={{ fontSize: 13, lineHeight: 19, color: colors.muted }}>This run is part of an earlier stop request.</Text>
            <Btn testID="stop-open-owner" label={`Open ${stopOwner()!.id}`} kind="ghost" onPress={() => { const owner = stopOwner(); if (owner?.kind === "plan") planLink(owner.id); else if (owner) taskLink(owner.id); }} />
          </View></If>
          <If when={t()!.state === "active" ? activityLine(t()!.activity) : null}>
            {(a) => (
              <Text testID="task-activity" style={{ marginTop: 10, fontSize: 13.5, lineHeight: 19, color: a().quiet ? colors.warn : colors.muted }}>{a().text}</Text>
            )}
          </If>
          <If when={t()!.state === "nohost"}>
            <View testID="task-nohost" style={{ marginTop: 16, paddingHorizontal: 14, paddingVertical: 11, borderRadius: radius.inset, backgroundColor: tints.warn }}>
              <Text style={{ fontSize: 14, lineHeight: 21, color: colors.text }}>
                {`No ${needsLabel(t()!.needs)} is online right now. Change the run settings below to use an available machine, or keep these requirements and it will start when a matching machine connects.`}
              </Text>
            </View>
          </If>
          <If when={t()!.request}>
            {section("Request")}
            <View selectable><Rich text={t()!.request ?? ""} context={t()!.title} /></View>
          </If>
          <If when={t()!.state === "inbox" || t()!.state === "nohost"}>
            <If when={t()!.state !== "nohost"}>
              <Btn testID="task-edit-run" label={editingRun() ? "Hide run settings" : "Edit run settings"} kind="ghost" onPress={() => editingRun.set(!editingRun())} />
            </If>
            <If when={t()!.state === "nohost" || editingRun()}><TaskPlacement hub={props.hub} task={t()!} /></If>
          </If>
          <If when={talk().length}>
            {section("Conversation")}
            <View testID="task-talk" style={{ gap: 14 }}>
              <Each of={talk()} key={(e) => e.id}>
                {(e) => isAsk(e()) ? (
                  <Message hub={props.hub} event={e()} answered={settled} target={() => null}
                    onAnswer={(ref, choice) => void props.hub.send(`${ref} ${choice}`, ref, [], true).catch((err) => note.set(String((err as Error)?.message ?? err)))}
                    onReply={() => hint.set("Write your instruction in the box below; it will be sent as the answer to this card.")} />
                ) : (
                  <View style={{ gap: 3 }}>
                    <Text style={{ fontSize: 13, color: colors.faint }}>
                      <Text style={{ fontWeight: "600", color: e().from === "owner" ? colors.accent : colors.muted }}>{e().from === "owner" ? "You" : displayName(e().from)}</Text>
                      {`  ${timeOf(e().ts)}`}
                    </Text>
                    <View selectable><Rich text={e().text} /></View>
                    <If when={e().attachments?.length}>
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                        <Each of={e().attachments ?? []}>{(a) => <Media hub={props.hub} path={a()} />}</Each>
                      </View>
                    </If>
                  </View>
                )}
              </Each>
            </View>
          </If>
          <If when={t()!.runs?.length}>
            {section("Result")}
            <View style={{ gap: 12 }}>
              <Each of={[...(t()!.runs ?? [])].reverse()}>
                {(r) => (
                  <View style={{ gap: 4 }}>
                    <Text style={{ fontSize: 13, color: colors.faint, fontVariant: ["tabular-nums"] }}>{`${r().ts.slice(5, 16).replace("T", " ")} · ${r().host} · ${r().status}`}</Text>
                    <Rich text={r().summary} context={`${t()!.title}\n${t()!.request ?? ""}`} />
                  </View>
                )}
              </Each>
            </View>
          </If>
          <If when={t()!.steps?.length}>
            {section("Progress")}
            <View selectable style={{ gap: 6 }}>
              <Each of={t()!.steps ?? []}>
                {(st) => (
                  <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
                    <Text style={{ width: 44, fontSize: 13.5, lineHeight: 21, color: colors.faint, fontVariant: ["tabular-nums"] }}>{st().time ?? ""}</Text>
                    <View style={{ width: 12, height: 21, alignItems: "center", justifyContent: "center" }}>
                      <Dot tone={st().kind === "done" ? "off" : st().kind === "fail" ? "bad" : st().kind === "decision" ? "wait" : "off"} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}><Rich text={st().text.replace(new RegExp(`^${t()!.id}\\b\\s*(→\\s*)?[:：]?\\s*`), "")} muted context={t()!.title} /></View>
                  </View>
                )}
              </Each>
            </View>
          </If>
        </If>
      </View>
    </Scroll>
    <If when={t() && (t()!.state !== "cancelled" || !!text().trim())}>
      <View
        onLayout={({ bounds }) => composerHeight.set(bounds.size.height)}
        style={{ position: "absolute", bottom: 0, width: "100%", maxWidth: size.column, alignSelf: "center", gap: 6, paddingHorizontal: props.wide ? 32 : 10, paddingTop: 4, paddingBottom: 12, pointerEvents: "box-none" }}
      >
        <If when={note()}>
          <Text style={{ fontSize: 13, color: colors.danger }}>{note()}</Text>
        </If>
        <If when={hint() && !note()}>
          <Text style={{ fontSize: 13, color: colors.muted }}>{hint()}</Text>
        </If>
        <If when={t()!.state === "cancelled"}><Text style={{ fontSize: 13, color: colors.muted }}>Your unsent draft is kept. Reopen this task to continue with it.</Text></If>
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, paddingLeft: 16, paddingRight: 8, paddingVertical: 8, ...composerGlass() }}>
          <Input
            testID="task-composer"
            disabled={t()!.state === "cancelled"}
            multiline
            value={text()}
            onChange={({ value }) => text.set(value)}
            submitBehavior={touch ? "newline" : "submit"}
            onSubmit={() => void say()}
            placeholder={`Continue in ${props.id}…`}
            class="placeholder:text-faint"
            style={{ flex: 1, minHeight: 36, maxHeight: 160, paddingVertical: 8, fontSize: 15, lineHeight: 21, color: colors.text, borderWidth: 0, backgroundColor: "transparent" }}
          />
          <SendButton testID="task-send" disabled={!text().trim() || t()!.state === "cancelled"} onPress={() => void say()} />
        </View>
      </View>
    </If>
    <If when={reopening()}><TaskForm hub={props.hub} id={props.id} isCurrent={props.isCurrent} onClose={() => reopening.set(false)} onOpen={() => { reopening.set(false); void refreshTask(); }} /></If>
    </View>
  );
}

/** A short horizontal meter: how full something is, 0..100. */
function Meter(props: { pct: number; tone?: "up" | "warn" | "danger" }) {
  const fill = () => ({ up: colors.up, warn: colors.warn, danger: colors.danger })[props.tone ?? "up"];
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.raised, overflow: "hidden" }}>
      <View style={{ width: `${Math.max(0, Math.min(100, props.pct))}%`, height: 6, borderRadius: 3, backgroundColor: fill() }} />
    </View>
  );
}

const ACCOUNT_STATE: Record<string, [string, "neutral" | "warn" | "danger"]> = { unknown: ["Not checked", "neutral"], ok: ["Signed in", "neutral"], cooldown: ["Cooling down", "warn"], login: ["Needs sign-in", "danger"] };

const ago = (iso?: string) => { const s = since(iso); return s === "just now" || !s ? s : `${s} ago`; };

function MachineSettings(props: { hub: Hub; host: string; onTask: (id: string) => void }) {
  const enabled = signal(true), limit = signal<number | null>(null), caps = signal("");
  const loaded = signal(false), busy = signal(false), note = signal(""), resources = signal(false);
  async function load() {
    const r = await props.hub.api("GET", `/api/machines/${encodeURIComponent(props.host)}`);
    if (!r.ok) return note.set(String(r.data.error ?? "Couldn't load machine settings"));
    enabled.set(r.data.enabled !== false);
    limit.set(typeof r.data.max_parallel === "number" ? r.data.max_parallel : null);
    caps.set(Array.isArray(r.data.caps) ? r.data.caps.join(", ") : "");
    loaded.set(true);
  }
  void load();
  async function save() {
    busy.set(true); note.set("");
    const r = await props.hub.api("PUT", `/api/machines/${encodeURIComponent(props.host)}`, {
      enabled: enabled(), max_parallel: limit(), caps: caps().split(",").map((c) => c.trim()).filter(Boolean),
    });
    busy.set(false);
    note.set(r.ok ? "Saved. This machine will apply these settings on its next sync. Running tasks keep going." : String(r.data.error ?? "Couldn't save machine settings"));
  }
  return <View testID="machine-settings" style={{ marginTop: 20, gap: 12, padding: 14, borderRadius: radius.inset, backgroundColor: colors.surface }}>
    <Text role="header" style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>Run settings</Text>
    <If when={loaded()} else={<Btn testID="machine-settings-reload" label="Load settings" disabled={busy()} onPress={() => void load()} />}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Toggle testID="machine-enabled" label="Accept new tasks" value={enabled()} onChange={(v) => { enabled.set(v); note.set(""); }} />
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={{ fontSize: 14, color: colors.text }}>Accept new tasks</Text>
          <Text style={{ fontSize: 13, lineHeight: 18, color: colors.muted }}>Turn off to finish current work without starting more tasks.</Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Toggle testID="machine-auto" label="Automatic parallelism" value={limit() === null} onChange={(v) => { limit.set(v ? null : 2); note.set(""); }} />
        <Text style={{ flex: 1, fontSize: 14, color: colors.text }}>Automatic parallelism</Text>
        <If when={limit() !== null}><ParallelInput value={limit() ?? 2} onChange={(v) => { limit.set(v); note.set(""); }} /></If>
      </View>
      <Field testID="machine-caps" label="Custom capabilities" value={caps()} onChange={(v) => { caps.set(v); note.set(""); }} hint="Labels such as docker, gpu or home, separated by commas. OS, architecture and installed tools are detected automatically." />
      <Btn testID="machine-settings-save" label="Save machine settings" kind="primary" busy={busy()} disabled={busy()} onPress={() => void save()} />
    </If>
    <Btn testID="machine-resources" label={resources() ? "Hide advanced settings" : "Edit resources and learning history"} kind="ghost" onPress={() => resources.set(!resources())} />
    <If when={resources()}><ConfigurationSettings hub={props.hub} machine={props.host} onTask={props.onTask} /></If>
    <If when={note()}><Text testID="machine-settings-note" style={{ fontSize: 13, lineHeight: 19, color: colors.text }}>{note()}</Text></If>
  </View>;
}

type MachineAccount = { cli: string; name: string; default: boolean; state: "unknown" | "ok" | "cooldown" | "login"; until?: string;
  login?: { id: string; url?: string; user_code?: string; needs_code: boolean; expires: string; status: string } };
type MachineAccountView = { host: string; providers: ProviderStatus[]; accounts: MachineAccount[] };

/** Commands and sign-in challenges stay bound to the selected machine. */
function MachineAccounts(props: { hub: Hub; host: string }) {
  const expanded = signal(false), view = signal<MachineAccountView | null>(null), busy = signal(false), note = signal("");
  const cli = signal("claude"), name = signal(""), codes = signal<Record<string, string>>({}), recovery = signal<string | null>(null);
  const endpoint = `/api/machines/${encodeURIComponent(props.host)}/accounts`;
  const key = (account: MachineAccount) => `${account.cli}-${encodeAccountSegment(account.name)}`;
  const pending = (account: MachineAccount) => !!account.login && ["starting", "waiting", "submitted"].includes(account.login.status);
  let timer: ReturnType<typeof setTimeout> | undefined, revision = 0, disposed = false;
  cleanup(() => { disposed = true; clearTimeout(timer); });
  function schedule() {
    clearTimeout(timer);
    if (!disposed && expanded() && view()?.accounts.some(pending)) timer = setTimeout(() => void load(true), 2000);
  }
  function accept(data: Record<string, unknown>) {
    if (data.host === props.host && Array.isArray(data.accounts) && Array.isArray(data.providers)) view.set(data as MachineAccountView);
  }
  async function load(silent = false) {
    if (busy() || disposed) return;
    const started = ++revision;
    if (!silent) { busy.set(true); note.set(""); }
    const r = await props.hub.api("GET", endpoint);
    if (!disposed && started === revision && expanded()) {
      if (r.ok) accept(r.data);
      else if (!silent) note.set(r.status === 404 ? "Update the hub and this machine to manage its AI accounts." : String(r.data.error ?? "Couldn't load accounts on this machine"));
    }
    if (!silent) busy.set(false);
    schedule();
  }
  async function perform(method: string, path: string, body?: unknown) {
    if (busy()) return;
    ++revision; clearTimeout(timer); busy.set(true); note.set("");
    const r = await props.hub.api(method, path, body);
    if (r.ok) { accept(r.data); recovery.set(null); note.set("Confirmed on this machine."); }
    else {
      const confirmation = r.data.confirmation;
      recovery.set(typeof confirmation === "string" && /^\/api\/machine-requests\/[a-f0-9-]{36}$/.test(confirmation) ? confirmation : null);
      note.set(method === "PUT" && r.status === 405 ? "Update this machine to change account priority or restore file defaults." : String(r.data.error ?? "This machine could not confirm the account action"));
    }
    busy.set(false); schedule();
  }
  const accountPath = (account: MachineAccount) => `${endpoint}/${account.cli}/${encodeAccountSegment(account.name)}`;
  const accountOrder = (provider: string) => (view()?.accounts ?? []).filter((account) => account.cli === provider).map((account) => account.name);
  function move(account: MachineAccount, direction: number) {
    const names = accountOrder(account.cli), from = names.indexOf(account.name), to = from + direction;
    if (from < 0 || to < 0 || to >= names.length) return;
    [names[from], names[to]] = [names[to]!, names[from]!];
    void perform("PUT", endpoint, { cli: account.cli, names });
  }

  async function remove(account: MachineAccount) {
    const result = await AlertDialog.show({ title: `Remove ${account.cli} account ${account.name}?`,
      description: "This removes it from Noop's account rotation on this machine. Credentials and running work stay intact. Removing the last account pauses this tool until you add an account or its default login.",
      actions: [{ id: "cancel", label: "Cancel", role: "cancel" }, { id: "remove", label: "Remove", role: "destructive" }] });
    if (result.action === "remove") await perform("DELETE", accountPath(account));
  }
  function toggle() {
    expanded.set(!expanded());
    if (expanded()) void load();
    else { ++revision; clearTimeout(timer); codes.set({}); note.set(""); }
  }
  return <View testID="machine-accounts" style={{ marginTop: 16, gap: 12 }}>
    <Btn testID="machine-accounts-open" label={expanded() ? "Hide AI account settings" : "Manage AI accounts and sign-in"} kind="ghost" disabled={busy()} onPress={toggle} />
    <If when={expanded()}><View style={{ gap: 14, padding: 14, borderRadius: radius.inset, backgroundColor: colors.surface }}>
      <Text role="header" style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>AI accounts on {props.host}</Text>
      <Text style={{ fontSize: 13, lineHeight: 18, color: colors.muted }}>Account choices and persistent credentials stay on this machine. Sign-in links and one-time codes use its private command channel. “Not checked” means no successful sign-in or authenticated run has been observed.</Text>
      <If when={view()}>{(current) => <>
        <Each of={current().providers} key={(provider) => provider.id}>{(provider) => <View style={{ gap: 8 }}>
          <Text style={{ color: colors.text, fontWeight: "600" }}>{provider().label}{provider().enabled ? "" : " · disabled for work"}</Text>
          <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18 }}>The first usable account is tried first. Move accounts to change their priority. File defaults restore this tool's configured accounts on this machine.</Text>
          <If when={!provider().available}><Text style={{ color: colors.warn, fontSize: 13 }}>{provider().reason ?? "This tool cannot launch on this machine."}</Text></If>
          <If when={!current().accounts.some((account) => account.cli === provider().id)}><Text testID={`accounts-empty-${provider().id}`} style={{ color: colors.warn, fontSize: 13 }}>No accounts selected. This tool is paused on this machine.</Text></If>
          <Each of={current().accounts.filter((account) => account.cli === provider().id)} key={key}>{(account) => <View testID={`account-${key(account())}`} style={{ gap: 8, padding: 10, borderWidth: 0.5, borderColor: colors.line, borderRadius: radius.control }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ flex: 1, color: colors.text }}>{account().name}{account().default ? " · normal CLI login" : ""}</Text>
              <Badge label={ACCOUNT_STATE[account().state]?.[0] ?? account().state} tone={ACCOUNT_STATE[account().state]?.[1] ?? "neutral"} />
            </View>
            <If when={account().until}><Text style={{ color: colors.muted, fontSize: 13 }}>Cooling down until {account().until}</Text></If>
            <If when={account().cli === "hermes"}><Text style={{ color: colors.muted, fontSize: 13 }}>Hermes authentication currently uses its native model setup on this machine.</Text></If>
            <If when={account().login}>{(login) => <View style={{ gap: 8 }}>
              <Text testID={`login-state-${key(account())}`} style={{ color: colors.muted, fontSize: 13 }}>{`Sign-in ${login().id}: ${login().status} · expires ${login().expires}`}</Text>
              <If when={pending(account()) && login().url && /^https:\/\//.test(login().url!)}><Btn testID={`login-open-${key(account())}`} label="Open sign-in page" kind="ghost" onPress={() => void openUrl(login().url!).catch(() => note.set("Couldn't open the sign-in page"))} /></If>
              <If when={pending(account()) && login().user_code}><View selectable><Text testID={`login-device-${key(account())}`} style={{ color: colors.text, fontFamily: MONO }}>Device code: {login().user_code}</Text></View></If>
              <If when={pending(account()) && login().needs_code && login().status === "waiting"}>
                <Field testID={`login-code-${key(account())}`} label="Authorization code from the sign-in page" masked value={codes()[key(account())] ?? ""} onChange={(value) => codes.update((all) => ({ ...all, [key(account())]: value }))} maxLength={8192} />
                <Btn testID={`login-submit-${key(account())}`} label="Submit authorization code" disabled={busy() || !codes()[key(account())]?.trim()} onPress={() => { const value = codes()[key(account())] ?? ""; codes.update((all) => ({ ...all, [key(account())]: "" })); void perform("POST", `${accountPath(account())}/code`, { id: login().id, code: value }); }} />
              </If>
              <If when={pending(account())}><Btn testID={`login-cancel-${key(account())}`} label="Cancel sign-in" kind="ghost" disabled={busy()} onPress={() => { codes.update((all) => ({ ...all, [key(account())]: "" })); void perform("POST", `${accountPath(account())}/cancel`, { id: login().id }); }} /></If>
            </View>}</If>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <If when={account().cli !== "hermes"}><Btn testID={`account-login-${key(account())}`} label="Sign in" disabled={busy() || !provider().available || pending(account())} onPress={() => void perform("POST", `${accountPath(account())}/login`, {})} /></If>
              <Btn testID={`account-remove-${key(account())}`} label="Remove from Noop" kind="ghost" disabled={busy() || pending(account())} onPress={() => void remove(account())} />
              <Btn testID={`account-up-${key(account())}`} label="Move up" kind="ghost" disabled={busy() || accountOrder(account().cli).indexOf(account().name) <= 0} onPress={() => move(account(), -1)} />
              <Btn testID={`account-down-${key(account())}`} label="Move down" kind="ghost" disabled={busy() || accountOrder(account().cli).indexOf(account().name) >= accountOrder(account().cli).length - 1} onPress={() => move(account(), 1)} />
            </View>
          </View>}</Each>
          <Btn testID={`accounts-defaults-${provider().id}`} label="Use file account defaults" kind="ghost" disabled={busy()} onPress={() => void perform("PUT", endpoint, { cli: provider().id, names: null })} />
        </View>}</Each>
        <Text role="header" style={{ color: colors.text, fontWeight: "600" }}>Add an account</Text>
        <Dropdown testID="account-provider" label="AI tool" selected={cli()} value={providerLabel(cli())} options={PROVIDER_IDS.map((id) => ({ id, label: providerLabel(id), testID: `account-provider-${id}` }))} onPick={(id) => cli.set(id)} />
        <Field testID="account-name" label="Account name" value={name()} onChange={(value) => name.set(value)} hint="Lowercase letters, numbers, dashes or underscores. Existing file account names keep their configured folders. Otherwise default selects the tool's normal login; new names get their own folder." maxLength={40} />
        <Btn testID="account-add" label="Add to account rotation" kind="primary" disabled={busy() || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name())} onPress={() => void perform("POST", endpoint, { cli: cli(), name: name() })} />
      </>}</If>
      <Btn testID="accounts-refresh" label={busy() ? "Waiting for this machine…" : "Refresh accounts"} kind="ghost" disabled={busy()} onPress={() => void load()} />
      <If when={recovery()}><Btn testID="accounts-confirm" label="Check the same pending action" disabled={busy()} onPress={() => void perform("GET", recovery()!)} /></If>
      <If when={note()}><Text testID="accounts-note" style={{ color: colors.muted, fontSize: 13, lineHeight: 18 }}>{note()}</Text></If>
    </View></If>
  </View>;
}

function MachineLearning(props: { hub: Hub; host: string; onTask: (id: string) => void; disabled?: boolean; refreshToken?: unknown }) {
  return <Each of={[props.host]} key={(host) => host}>{(host) => <MachineLearningHost hub={props.hub} host={host()} onTask={props.onTask} disabled={props.disabled} refreshToken={props.refreshToken} />}</Each>;
}
function MachineLearningHost(props: { hub: Hub; host: string; onTask: (id: string) => void; disabled?: boolean; refreshToken?: unknown }) {
  const status = signal<LearningStatus | undefined>(undefined), preview = signal<LearningPreview | undefined>(undefined), result = signal<LearningRunResult | undefined>(undefined);
  const busy = signal(false), note = signal(""), good = signal(false), unavailable = signal(false), knownId = signal("");
  let generation = 0, disposed = false;
  cleanup(() => { disposed = true; generation++; });
  const endpoint = `/api/machines/${encodeURIComponent(props.host)}/learning`;
  const pending = () => props.hub.savedEntries().find((entry): entry is Extract<PendingEntry, { kind: "learning" }> => entry.kind === "learning" && entry.key === props.host);
  const serverPending = () => status()?.pending;
  const pendingConflict = () => { const local = pending(), remote = serverPending(); return !!local && !!remote && (local.request.request_id !== remote.request_id || local.request.preview_digest !== remote.preview_digest
    || local.preview.turns !== remote.turns || local.preview.sessions !== remote.sessions || local.preview.truncated !== remote.truncated || JSON.stringify(local.preview.sources) !== JSON.stringify(remote.sources)
    || !!local.known_id && local.known_id !== remote.id); };
  const reviewed = () => pending()?.preview ?? preview(), taskId = () => pending()?.known_id ?? (knownId() || result()?.id || "");
  async function load(keepNote = false) {
    if (busy()) return;
    const mine = ++generation;
    busy.set(true); status.set(undefined); preview.set(undefined); if (!keepNote) { note.set(""); good.set(false); } unavailable.set(false);
    const r = await props.hub.api("GET", endpoint, undefined, newRequestKey());
    if (mine !== generation) return;
    const value = readLearningStatus(r.data);
    if (r.ok && value?.host === props.host) status.set(value);
    else { unavailable.set(r.status === 404 || r.status === 409); note.set(r.status === 404 || r.status === 409 ? "Update this machine, hub and app to preview and run learning here." : String(r.data.error ?? `Couldn't load learning status for ${props.host}. No other machine was selected.`)); }
    busy.set(false);
  }
  async function inspect() {
    const id = taskId(); if (!id || busy()) return;
    const mine = ++generation;
    busy.set(true); const r = await props.hub.api("GET", `/api/tasks/get?id=${encodeURIComponent(id)}`);
    if (mine !== generation) return;
    busy.set(false);
    if (!r.ok || r.data.id !== id) { good.set(false); note.set(String(r.data.error ?? "This learning task is no longer available. The saved receipt remains historical.")); return; }
    props.onTask(id);
  }
  async function review() {
    if (busy() || pending() || props.disabled || !status() || status()!.blocked_reason) return;
    const mine = ++generation;
    busy.set(true); preview.set(undefined); result.set(undefined); knownId.set(""); note.set(""); good.set(false);
    const r = await props.hub.api("POST", `${endpoint}/preview`, {}, newRequestKey());
    if (mine !== generation) return;
    const value = readLearningPreview(r.data);
    if (r.ok && value?.host === props.host) preview.set(value);
    else note.set(String(r.data.error ?? "Couldn't verify a count-only learning preview for this machine. Refresh status and try again."));
    busy.set(false);
  }
  async function run(mode: "run" | "check" | "retry" | "discard") {
    if (disposed || busy() || props.hub.savedLoading() || props.hub.savedError()) return;
    const started = generation;
    let entry = pending();
    if (!entry) {
      if (mode !== "run" || !preview() || !status() || status()!.blocked_reason || props.disabled) return;
      entry = { kind: "learning", key: props.host, at: props.hub.savedAt("learning", props.host), preview: preview()!, request: { request_id: crypto.randomUUID(), preview_digest: preview()!.preview_digest } };
    }
    if (mode === "retry" || mode === "discard") {
      const answer = await AlertDialog.show({ title: mode === "discard" ? "Release the uncertain collection?" : "Retry the same learning run?",
        description: mode === "discard" ? "This leaves tasks and current learning progress unchanged. A fresh preview may include the same history. It releases only this exact uncertain collection; it does not cancel a task."
          : "If the original run was not applied, this may collect the same reviewed history and queue its learning task on this machine. It keeps the original request and preview; it does not select newer history.",
        actions: [{ id: "back", label: "Back", role: "cancel" }, { id: "run", label: mode === "discard" ? "Release collection" : "Retry same run" }] });
      if (answer.action !== "run" || disposed || started !== generation || busy() || pending()?.request.request_id !== entry.request.request_id) return;
    }
    const mine = ++generation, current = entry;
    busy.set(true); note.set(""); good.set(false); let refreshAfter = false;
    try {
      if (!await props.hub.keepPending(current)) { note.set(props.hub.savedError() || "Load saved requests before starting learning."); return; }
      if (mine !== generation) return;
      const request = { ...current.request, ...(mode === "check" ? { confirm_only: true as const } : {}) };
      const r = await props.hub.learningRun(props.host, request, mode === "discard");
      if (mine !== generation || pending()?.request.request_id !== current.request.request_id) return;
      const value = learningReceipt(r.data, props.host, current.request, current.preview, current.known_id);
      const released = learningRelease(r.data, props.host, current.request, current.known_id);
      const id = value?.id ?? released?.id ?? learningTaskId(r.data, props.host, current.request, current.known_id);
      if (id) { knownId.set(id); if (!await props.hub.keepPending({ ...current, known_id: id })) { note.set(props.hub.savedError()); return; } }
      if (!r.ok || !value && !released) { note.set(String(r.data.error ?? "This learning run is unconfirmed. Check the saved run before starting another one.")); return; }
      result.set(value);
      if (!await props.hub.dropPending("learning", props.host, current.request.request_id)) { note.set("Learning run confirmed, but its local recovery copy could not be cleared. Reload saved requests and check the same run again."); return; }
      preview.set(undefined); good.set(true);
      note.set(released ? "The uncertain collection was released. Tasks and current learning progress were left unchanged. Review a fresh preview before another run."
        : mode === "check" || value!.replayed ? value!.id ? "Earlier learning run confirmed. Inspect the task to check its current state." : "Earlier learning run confirmed. It did not create a learning task."
        : value!.id ? `Learning task ${value!.id} queued on ${props.host} from ${value!.turns} owner turns in ${value!.sessions} provider sessions.` : `No new selected history on ${props.host}. No learning task was created.`);
      refreshAfter = true;
      void props.hub.refreshStatus();
    } finally { busy.set(false); if (refreshAfter && mine === generation) void load(true); }
  }
  async function adopt() {
    const remote = serverPending(); if (!remote || busy() || pendingConflict()) return;
    const entry: Extract<PendingEntry, { kind: "learning" }> = { kind: "learning", key: props.host, at: props.hub.savedAt("learning", props.host),
      request: { request_id: remote.request_id, preview_digest: remote.preview_digest },
      preview: { host: props.host, preview_digest: remote.preview_digest, sources: remote.sources, turns: remote.turns, sessions: remote.sessions, truncated: remote.truncated }, ...(remote.id ? { known_id: remote.id } : {}) };
    const mine = ++generation;
    busy.set(true); note.set(""); good.set(false);
    try {
      const saved = await props.hub.keepPending(entry); if (mine !== generation) return;
      if (!saved) note.set(props.hub.savedError() || "Reload saved requests before reviewing this collection.");
      else { knownId.set(remote.id ?? ""); preview.set(undefined); result.set(undefined); note.set("Saved collection reviewed. Check its saved run or explicitly release the uncertainty; no history was read and no task was queued."); }
    } finally { busy.set(false); }
  }
  async function forget() {
    const entry = pending(); if (!entry || disposed || busy()) return;
    const started = generation;
    const answer = await AlertDialog.show({ title: "Forget this saved learning run?", description: "This removes only this device's recovery copy. The earlier run may still finish. No learning task or collected history is undone.",
      actions: [{ id: "keep", label: "Keep saved run", role: "cancel" }, { id: "forget", label: "Forget saved run", role: "destructive" }] });
    if (answer.action !== "forget" || disposed || started !== generation || busy() || pending()?.request.request_id !== entry.request.request_id) return;
    const mine = ++generation;
    busy.set(true);
    try {
      const dropped = await props.hub.dropPending("learning", props.host, entry.request.request_id); if (mine !== generation) return;
      if (dropped) { knownId.set(""); result.set(undefined); preview.set(undefined); note.set(""); }
      else note.set(props.hub.savedError());
    } finally { busy.set(false); }
  }
  effect(() => { props.refreshToken; untracked(() => void load()); });
  return <View testID="learning-controls" style={{ gap: 10, marginTop: 20 }}>
    <Text role="header" style={{ color: colors.text, fontSize: 17, fontWeight: "600" }}>{`Learning on ${props.host}`}</Text>
    <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 19 }}>Status reads settings and saved collection receipts without reading histories. Preview reads selected local histories and reports counts, without advancing learning progress or creating a task. Run collects that reviewed history and queues a learning task on this machine.</Text>
    <If when={status()}>{(value) => <>
      <Text testID="learning-sources" style={{ color: colors.muted, fontSize: 13 }}>{`Selected sources: ${value().sources.map(providerLabel).join(", ") || "None"}`}</Text>
      <If when={value().blocked_reason}><Text testID="learning-blocked" style={{ color: colors.warn, fontSize: 13 }}>{value().blocked_reason}</Text></If>
      <If when={props.disabled}><Text style={{ color: colors.warn, fontSize: 13 }}>Save your settings before previewing or starting learning.</Text></If>
      <Btn testID="learning-preview" label="Preview selected history" disabled={busy() || !!pending() || props.disabled || !!value().blocked_reason} onPress={() => void review()} />
      <Btn testID="learning-run" label="Run reviewed learning" kind="primary" disabled={busy() || !!pending() || !preview() || props.disabled || !!value().blocked_reason || !props.hub.savedReady() || !!props.hub.savedError()} onPress={() => void run("run")} />
    </>}</If>
    <If when={serverPending()}>{(value) => <View testID="learning-server-pending" style={{ gap: 8 }}>
      <Text style={{ color: colors.warn, fontSize: 13, lineHeight: 19 }}>{`${props.host} reports an unfinished collection: ${value().turns} owner turns in ${value().sessions} provider sessions${value().truncated ? " (digest truncated)" : ""}.`}</Text>
      <Text style={{ color: colors.muted, fontSize: 13 }}>{`Saved sources: ${value().sources.map(providerLabel).join(", ") || "None"}`}</Text>
      <Text style={{ color: colors.muted, fontSize: 12.5, userSelect: "text" }}>{`Request ${value().request_id}${value().id ? ` · Task ${value().id}` : ""}`}</Text>
      <If when={pendingConflict()}><Text testID="learning-pending-conflict" style={{ color: colors.warn, fontSize: 13, lineHeight: 19 }}>A different local saved run already exists for this machine. Check it or explicitly forget its local copy before reviewing the machine's unfinished collection. Neither authorization was replaced.</Text></If>
      <Btn testID="learning-adopt" label="Review saved collection" disabled={busy() || pendingConflict() || props.hub.savedLoading() || !!props.hub.savedError()} onPress={() => void adopt()} />
    </View>}</If>
    <If when={reviewed()}>{(value) => <View testID="learning-preview-counts" style={{ gap: 4 }}>
      <Text style={{ color: colors.text, fontSize: 14 }}>{`${value().turns} owner turns · ${value().sessions} provider sessions · ${props.host}`}</Text>
      <Text style={{ color: colors.muted, fontSize: 13 }}>{`Reviewed sources: ${value().sources.map(providerLabel).join(", ") || "None"}`}</Text>
      <Text style={{ color: value().truncated ? colors.warn : colors.muted, fontSize: 13, lineHeight: 19 }}>{value().truncated ? "The prepared digest exceeded its limit; earlier collected content was omitted. Counts describe the full prepared collection." : "No digest truncation reported."}</Text>
    </View>}</If>
    <If when={pending()}><View style={{ gap: 8 }}>
      <Text testID="learning-pending" style={{ color: colors.warn, fontSize: 13 }}>This learning run is unconfirmed. Checking its saved result does not read history or create another task.</Text>
      <Btn testID="learning-check" label="Check saved run" kind="primary" disabled={busy() || props.hub.savedLoading() || !!props.hub.savedError()} onPress={() => void run("check")} />
      <Btn testID="learning-retry" label="Retry same learning run…" disabled={busy() || props.hub.savedLoading() || !!props.hub.savedError()} onPress={() => void run("retry")} />
      <Btn testID="learning-release" label="Release uncertain collection…" disabled={busy() || props.hub.savedLoading() || !!props.hub.savedError()} onPress={() => void run("discard")} />
      <Btn testID="learning-forget" label="Forget local copy…" kind="ghost" disabled={busy()} onPress={() => void forget()} />
    </View></If>
    <If when={taskId()}><Btn testID="learning-inspect" label="Inspect learning task" disabled={busy()} onPress={() => void inspect()} /></If>
    <Btn testID="learning-refresh" label="Refresh learning status" kind="ghost" disabled={busy()} onPress={() => void load()} />
    <If when={note()}><Text testID={unavailable() ? "learning-unsupported" : "learning-note"} style={{ color: good() ? colors.up : colors.warn, fontSize: 13, lineHeight: 19 }}>{note()}</Text></If>
  </View>;
}

function MachineDetail(props: { hub: Hub; host: string; wide: boolean; onTask: (id: string) => void }) {
  const h = () => [...(props.hub.status()?.hosts ?? []), ...(props.hub.status()?.offline_hosts ?? [])].find((x) => x.host === props.host);
  const section = (title: string) => (
    <Text role="header" style={{ fontSize: 13, fontWeight: "600", color: colors.muted, marginTop: 24, marginBottom: 8 }}>{title}</Text>
  );
  const stat = (label: string, value: string, pct: number, tone: "up" | "warn" | "danger") => (
    <View style={{ flex: 1, minWidth: 140, gap: 6, padding: 12, borderRadius: radius.control, borderWidth: 1, borderColor: colors.line }}>
      <Text style={{ fontSize: 13, color: colors.muted }}>{label}</Text>
      <Text style={{ fontSize: 17, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}>{value}</Text>
      <Meter pct={pct} tone={tone} />
    </View>
  );
  const load = () => loadOf(h()!);
  const memUsed = () => 100 - (h()!.stats?.memFreePct ?? 100);
  const diskUsed = () => h()!.stats?.diskError ? 0 : 100 - (h()!.stats?.diskFreePct ?? 100);
  const toneOf = (pct: number): "up" | "warn" | "danger" => (pct >= 90 ? "danger" : pct >= 70 ? "warn" : "up");
  const row = (id: string, title: string, right: string, mark?: JSX.Element) => (
    <View
      role="button"
      accessibilityLabel={`${id} ${title}`}
      onPress={() => props.onTask(id)}
      hoverStyle={hovered()}
      style={{ minHeight: size.row, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, marginHorizontal: -10, borderRadius: 7 }}
    >
      {mark}
      <Text style={{ fontFamily: MONO, fontSize: 12.5, color: colors.faint }}>{id}</Text>
      <Text style={{ flex: 1, fontSize: 14.5, color: colors.text, numberOfLines: 1 }}>{title}</Text>
      <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{right}</Text>
    </View>
  );
  return (
    <Scroll style={{ flex: 1 }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", paddingHorizontal: props.wide ? 32 : 16, paddingVertical: 24 }}>
        <If when={h()} else={<Text style={{ fontSize: 15, color: colors.muted }}>{`${props.host} is offline right now.`}</Text>}>
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Dot tone={h()!.online === false ? "off" : h()!.enabled === false ? "wait" : "on"} />
              <Text style={{ userSelect: "text", fontSize: 20, fontWeight: "600", color: colors.text }}>{h()!.host}</Text>
            </View>
            <Text style={{ fontSize: 14, color: colors.muted }}>
              {[h()!.online === false ? "Offline" : h()!.enabled === false ? "Paused for new tasks" : "Online", [h()!.os ?? osOf(h()!), h()!.arch].filter(Boolean).join(" "), h()!.seen ? `Last seen ${ago(h()!.seen)}` : "", `${h()!.busy ?? 0} running`].filter(Boolean).join(" · ")}
            </Text>
            <If when={h()!.providers?.length}>
              <View style={{ gap: 5 }}><Each of={h()!.providers ?? []} key={(provider) => provider.id}>{(provider) => <Text style={{ fontSize: 13, color: provider().available ? colors.muted : colors.warn }}>
                {`${provider().label}: ${provider().available ? "CLI available" : provider().reason ?? "Unavailable"}${provider().enabled ? "" : " · not selected for execution"}`}
              </Text>}</Each></View>
            </If>
            <If when={h()!.rev}>
              <RevLink host={h()!} />
            </If>
          </View>
          <MachineSettings hub={props.hub} host={props.host} onTask={props.onTask} />
          {section(h()!.online === false ? "Last reported resources" : "Resources")}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {stat("Load", `${load()}%${h()!.stats?.cores ? ` · ${h()!.stats!.cores} cores` : ""}`, load(), toneOf(load()))}
            {stat("Memory", h()!.stats?.memFreePct != null ? `${memUsed()}% used` : "Unknown", memUsed(), toneOf(memUsed()))}
            {stat("Disk", h()!.stats?.diskError ? "Unavailable" : `${h()!.stats?.diskFreeGB ?? "?"} GB free`, diskUsed(), h()!.stats?.diskError ? "warn" : toneOf(diskUsed()))}
          </View>
          <If when={h()!.stats?.diskPath}><Text testID="machine-disk-path" style={{ marginTop: 8, fontSize: 13, color: colors.muted }}>{`Monitoring: ${h()!.stats!.diskPath}`}</Text></If>
          <If when={h()!.stats?.diskError}><Text testID="machine-disk-error" style={{ marginTop: 8, fontSize: 13, lineHeight: 19, color: colors.warn }}>{`${h()!.stats!.diskError} New tasks wait until disk monitoring is available. Check this machine's resource configuration.`}</Text></If>
          <If when={h()!.clis?.length || h()!.accounts?.length}>
            {section("Tools and accounts")}
            <View style={{ gap: 8 }}>
              <If when={h()!.clis?.length}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  <Each of={h()!.clis ?? []}>{(c) => <Badge label={c()} />}</Each>
                </View>
              </If>
              <Each of={h()!.accounts ?? []}>
                {(a) => (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                    <Text style={{ flex: 1, fontSize: 14.5, color: colors.text }}>{`${a().cli} · ${a().name}`}</Text>
                    <Badge label={`${ACCOUNT_STATE[a().state]?.[0] ?? a().state}${a().until ? ` until ${a().until!.slice(11, 16)}` : ""}`} tone={ACCOUNT_STATE[a().state]?.[1] ?? "neutral"} />
                  </View>
                )}
              </Each>
            </View>
          </If>
          <MachineAccounts hub={props.hub} host={props.host} />
          <MachineLearning hub={props.hub} host={props.host} onTask={props.onTask} />
          {section("Running")}
          <If when={h()!.running?.length} else={<Text style={{ fontSize: 14, color: colors.faint }}>Idle</Text>}>
            <View>
              <Each of={h()!.running ?? []} key={(t) => t.id}>
                {(t) => row(t().id, t().title, [displayName(t().agent), since(t().started), activityLine(t().activity)?.text].filter(Boolean).join(" · "), <Dot tone="run" />)}
              </Each>
            </View>
          </If>
          {section("Recent")}
          <If when={h()!.recent?.length} else={<Text style={{ fontSize: 14, color: colors.faint }}>No finished tasks yet</Text>}>
            <View>
              <Each of={h()!.recent ?? []} key={(t) => t.id}>
                {(t) => row(t().id, t().title, t().finished ? ago(t().finished) : "",
                  <Text style={{ width: 14, fontSize: 13, color: STATE_OF()[t().state ?? ""]?.[1] ?? colors.faint }}>{STATE_OF()[t().state ?? ""]?.[2] ?? "·"}</Text>)}
              </Each>
            </View>
          </If>
        </If>
      </View>
    </Scroll>
  );
}

// ---------------------------------------------------------------- sidebar

function SideHeading(props: { title: string; count?: number | string; accent?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6 }}>
      <Text style={{ flex: 1, fontSize: 12, fontWeight: "600", color: colors.muted, letterSpacing: 0.4 }}>{props.title}</Text>
      <If when={props.count}>
        <If when={props.accent} else={<Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{String(props.count)}</Text>}>
          <View style={{ minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.accentFill }}>
            <Text style={{ fontSize: 12, fontWeight: "600", color: colors.onAccent }}>{String(props.count)}</Text>
          </View>
        </If>
      </If>
    </View>
  );
}

function SideEmpty(props: { text: string }) {
  return <Text style={{ fontSize: 13.5, color: colors.faint, paddingHorizontal: 20, paddingVertical: 6 }}>{props.text}</Text>;
}

/** A sidebar row: the gallery's SidebarRow, at 34 pt (44 on touch). */
function SideRow(props: { onPress?: () => void; selected?: boolean; title?: string; children: JSX.Element }) {
  return (
    <View
      onPress={props.onPress}
      role={props.onPress ? "button" : undefined}
      accessibilityLabel={props.title}
      tooltip={props.title && !props.onPress ? <Tip label={props.title} placement="right" /> : undefined}
      hoverStyle={props.onPress && !props.selected ? hovered() : undefined}
      style={{
        minHeight: size.row,
        marginHorizontal: 10,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 10,
        borderRadius: radius.control,
        borderCurve: "continuous",
        backgroundColor: props.selected ? alpha(colors.text, 0.08) : "transparent",
      }}
    >
      {props.children}
    </View>
  );
}

/** How far the wide layout's floating sidebar sits from the window's edges. */
const sidebarInset = 8;

function Sidebar(props: {
  hub: Hub;
  target: () => string | null;
  onPick: (ref: string) => void;
  /** Set a question aside: it leaves Needs your decision and is not asked again. */
  onIgnore: (ref: string) => void;
  task: () => string | null;
  onTask: (id: string) => void;
  machine: () => string | null;
  onMachine: (host: string) => void;
  onSettings: () => void;
  rules: () => boolean;
  onRules: () => void;
  tasks: () => boolean;
  onTasks: () => void;
  plan: () => string | null;
  plans: () => boolean;
  onPlans: () => void;
  onPlan: (id: string) => void;
  onHelp: () => void;
  onClose?: () => void;
  chrome?: boolean;
  onCollapse?: () => void;
  home: () => boolean;
  onHome: () => void;
  onRestart: () => void;
}) {
  const s = () => props.hub.status();
  // the hub closes a decision on its next tick: one the channel already shows answered leaves the list now
  const waits = computed(() => { const done = answeredIds(props.hub.events()); return waiting(s()).filter((d) => !done.has(d.id)); });
  const queue = () => {
    const q = s()?.tasks;
    return [
      ["To approve", q?.proposed],
      ["Queued", q?.inbox],
      ["Blocked", q?.blocked],
      ["Failed", q?.failed],
      ["Done", q?.done],
    ] as const;
  };
  const rowText = () => ({ flex: 1, fontSize: 14.5, color: colors.text, numberOfLines: 1 }) as const;
  return (
    <View style={{ flex: 1 }}>
      <View
        desktop={{ windowDrag: true }}
        // the floating panel starts below the window's top: its row stays centered on the title bar, level with the window controls
        style={{ height: props.chrome ? size.bar - sidebarInset : size.bar, paddingBottom: props.chrome ? sidebarInset : 0, flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: (props.chrome && hasWindow ? Math.max(0, titleBar().left - sidebarInset) : 0) + 18, paddingRight: 10 }}
      >
        <Text style={{ flex: 1, fontSize: 16, fontWeight: "600", color: colors.text }}>Noop</Text>
        <If when={props.onClose}>
          <ToolButton icon="close" label="Close menu" onPress={() => props.onClose?.()} />
        </If>
        <If when={props.onCollapse}>
          <ToolButton icon="sidebar" label="Hide sidebar" noTooltip compact onPress={() => props.onCollapse?.()} />
        </If>
      </View>
      <Scroll style={{ flex: 1 }}>
        <View style={{ paddingBottom: 16, gap: 1 }}>
          <View style={{ paddingTop: 8 }}>
            <SideRow onPress={props.onHome} selected={props.home()} title="Main chat">
              <Icon name="chat" size={17} tint={props.home() ? colors.text : colors.muted} />
              <Text style={{ ...rowText(), fontWeight: "600" }}>Main chat</Text>
              <If when={waits().length}>
                <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{`${waits().length} to decide`}</Text>
              </If>
            </SideRow>
            <SideRow onPress={props.onRules} selected={props.rules()} title="Memory">
              <Icon name="scroll" size={17} tint={props.rules() ? colors.text : colors.muted} />
              <Text style={rowText()}>Memory</Text>
            </SideRow>
          </View>
          <SideHeading title="Needs your decision" count={(waits().length + (s()?.recent ?? []).filter((t) => t.state === "nohost").length) || undefined} accent />
          <Each of={(s()?.recent ?? []).filter((t) => t.state === "nohost")} key={(t) => t.id}>
            {(t) => <SideRow onPress={() => props.onTask(t().id)} selected={props.task() === t().id} title={`${t().id} · Change run settings`}>
              <Dot tone="wait" /><Text style={rowText()}>{t().title}</Text><Text style={{ fontSize: 12.5, color: colors.warn }}>Choose machine</Text>
            </SideRow>}
          </Each>
          <Each of={waits()} key={(d) => d.id}>
            {(d) => (
              <ContextMenu
                margin={8}
                popupStyle={{ minWidth: 160, padding: 4, borderRadius: radius.control, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }}
                trigger={
                  <SideRow onPress={() => props.onPick(d().id)} title={d().id}>
                    <Dot tone="wait" />
                    <Text style={rowText()}>{d().question || d().id}</Text>
                    <Text style={{ fontFamily: MONO, fontSize: 12, color: colors.faint }}>{d().id}</Text>
                  </SideRow>
                }
              >
                <MenuItem
                  testID={`side-ignore-${d().id}`}
                  onSelect={() => props.onIgnore(d().id)}
                  hoverStyle={hovered()}
                  style={{ height: 32, justifyContent: "center", paddingHorizontal: 10, borderRadius: 6 }}
                >
                  <Text style={{ fontSize: 14, color: colors.text }}>Ignore, no action needed</Text>
                </MenuItem>
              </ContextMenu>
            )}
          </Each>
          <If when={!waits().length && !(s()?.recent ?? []).some((t) => t.state === "nohost")}>
            <SideEmpty text="Nothing pending; the team is moving on its own" />
          </If>

          <SideHeading title="In progress" count={s()?.active.length || undefined} />
          <Each of={s()?.active ?? []} key={(a) => a.id}>
            {(a) => (
              <SideRow onPress={() => props.onTask(a().id)} selected={props.task() === a().id} title={`${a().id} · ${a().agent}${a().host ? ` @ ${a().host}` : ""}`}>
                <Dot tone="run" />
                <Text style={rowText()}>{a().title}</Text>
                <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{since(a().started)}</Text>
              </SideRow>
            )}
          </Each>
          <If when={!s()?.active.length}>
            <SideEmpty text="Idle" />
          </If>

          <If when={(s()?.recent ?? []).filter((t) => !(s()?.active ?? []).some((a) => a.id === t.id) && isQueued(t.state)).length}>
            <SideHeading title="Queued" count={(s()?.recent ?? []).filter((t) => !(s()?.active ?? []).some((a) => a.id === t.id) && isQueued(t.state)).length} />
            <Each of={(s()?.recent ?? []).filter((t) => !(s()?.active ?? []).some((a) => a.id === t.id) && isQueued(t.state))} key={(a) => a.id}>
              {(a) => (
                <SideRow onPress={() => props.onTask(a().id)} selected={props.task() === a().id} title={`${a().id} · ${STATE_OF()[a().state ?? ""]?.[0] ?? ""}`}>
                  <Dot tone={TONE[a().state ?? ""] ?? "off"} />
                  <Text style={{ ...rowText(), color: colors.muted }}>{a().title}</Text>
                  <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{a().state === "waiting" ? "Waiting on subtasks" : a().state === "parked" ? "Waiting" : a().state === "nohost" ? `Needs a ${needsLabel((a() as { needs?: string }).needs)}` : "Queued"}</Text>
                </SideRow>
              )}
            </Each>
          </If>
          <If when={(s()?.recent ?? []).filter((t) => !(s()?.active ?? []).some((a) => a.id === t.id) && !isQueued(t.state)).slice(0, 6).length}>
            <SideHeading title="Recent" />
            <Each of={(s()?.recent ?? []).filter((t) => !(s()?.active ?? []).some((a) => a.id === t.id) && !isQueued(t.state)).slice(0, 6)} key={(a) => a.id}>
              {(a) => (
                <SideRow onPress={() => props.onTask(a().id)} selected={props.task() === a().id} title={`${a().id} · ${STATE_OF()[a().state ?? ""]?.[0] ?? ""}`}>
                  <Dot tone={TONE[a().state ?? ""] ?? "off"} />
                  <Text style={{ ...rowText(), color: colors.muted }}>{a().title}</Text>
                  <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{since(a().updated)}</Text>
                </SideRow>
              )}
            </Each>
          </If>

          <SideRow onPress={props.onPlans} selected={props.plans()} title="Plans">
            <Icon name="form" size={17} tint={colors.muted} />
            <Text style={{ ...rowText(), color: colors.muted }}>Plans</Text>
          </SideRow>
          <Each of={s()?.plans ?? []} key={(p) => p.id}>
            {(p) => (
              <SideRow onPress={() => props.onPlan(p().id)} selected={props.plan() === p().id} title={p().goal}>
                <Dot tone={p().status === "running" || p().status === "drafting" ? "run" : "wait"} />
                <Text style={rowText()}>{p().goal.split("\n")[0]}</Text>
                <Text style={{ flexShrink: 0, fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{p().status === "review" || p().status === "paused" ? PLAN_STATUS[p().status].replace("Needs your review", "Review") : `${p().done}/${p().total}`}</Text>
              </SideRow>
            )}
          </Each>
          <SideRow onPress={props.onTasks} selected={props.tasks()} title="All tasks">
            <Icon name="layers" size={17} tint={colors.muted} />
            <Text style={{ ...rowText(), color: colors.muted }}>All tasks</Text>
          </SideRow>

          <SideHeading title="Machines" count={((s()?.hosts.length ?? 0) + (s()?.offline_hosts?.length ?? 0)) || undefined} />
          <Each of={[...(s()?.hosts ?? []), ...(s()?.offline_hosts ?? [])]} key={(h) => h.host}>
            {(h) => (
              <SideRow onPress={() => props.onMachine(h().host)} selected={props.machine() === h().host} title={`Load ${loadOf(h())}% · Disk ${h().stats?.diskError ? "unavailable" : `${h().stats?.diskFreeGB ?? "?"}GB`} · ${h().busy ?? 0} running`}>
                <Dot tone={h().online === false ? "off" : h().enabled === false ? "wait" : "on"} />
                <Text style={rowText()}>{h().host}</Text>
                <If when={h().online === false || h().enabled === false}><Text style={{ fontSize: 12.5, color: colors.faint }}>{h().online === false ? "Offline" : "Paused"}</Text></If>
                <If when={h().online !== false && (h().busy ?? 0) > 0}>
                  <Text style={{ fontSize: 13, color: colors.muted, fontVariant: ["tabular-nums"] }}>{`${h().busy} running`}</Text>
                </If>
              </SideRow>
            )}
          </Each>
          <If when={!s()?.hosts.length}>
            <SideEmpty text="No machines online" />
          </If>

          <If when={queue().some((q) => q[1] && q[0] !== "Done" && q[0] !== "To approve")}>
            <Text style={{ fontSize: 13, color: colors.faint, paddingHorizontal: 20, paddingTop: 18, fontVariant: ["tabular-nums"] }}>
              {queue().filter((q) => q[1] && q[0] !== "Done" && q[0] !== "To approve").map((q) => `${q[0]} ${q[1]}`).join(" · ")}
            </Text>
          </If>
        </View>
      </Scroll>
      <UpdateRow onRestart={props.onRestart} />
      <View
        style={{
          minHeight: 56,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingLeft: 18,
          paddingRight: 10,
          paddingBottom: touch ? safeArea().bottom : 0,
        }}
      >
        <View style={{ flex: 1, gap: 1 }}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: colors.text }}>Main chat</Text>
          <Text style={{ fontSize: 12, color: colors.muted, numberOfLines: 1 }}>{props.hub.cfg.url.replace(/^https?:\/\//, "")}</Text>
        </View>
        <ToolButton icon={isDark() ? "sun" : "moon"} label={isDark() ? "Light appearance" : "Dark appearance"} noTooltip onPress={toggleTheme} testID="theme" />
        <ToolButton icon="settings" label="Settings" shortcut={keymap.label("mod+,")} onPress={props.onSettings} testID="settings" />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- app updates

const appUpdate = signal<UpdateState>({ kind: "none" });
const updates = createUpdates(
  { check: checkForUpdate, download: () => downloadUpdate(), install: installAndRestart },
  (state) => appUpdate.set(state),
);
/** The first check waits for the app to settle; nsh/updater answers null where apps do not update (the web, a dev run). */
function watchUpdates() {
  const first = setTimeout(() => void updates.check(), 5000);
  const timer = setInterval(() => void updates.check(), CHECK_EVERY_MS);
  cleanup(() => { clearTimeout(first); clearInterval(timer); });
}

/** Above the sidebar's footer, only when there is something to press. */
function UpdateRow(props: { onRestart: () => void }) {
  const state = () => appUpdate();
  const version = () => { const u = state(); return u.kind === "none" ? "" : u.version; };
  const label = () => {
    const u = state();
    if (u.kind === "link") return `Download version ${u.version}`;
    if (u.kind === "installing") return "Updating…";
    if (u.kind === "failed") return "Update failed, tap to retry";
    return `Restart to update to ${version()}`;
  };
  const press = () => {
    const u = state();
    if (u.kind === "link") void openUrl(u.url).catch(() => {});
    else if (u.kind !== "installing") props.onRestart();
  };
  return (
    <If when={state().kind !== "none"}>
      <View
        role="button"
        testID="app-update"
        accessibilityLabel={label()}
        onPress={press}
        class="active:bg-raised"
        style={{ minHeight: touch ? 44 : 36, justifyContent: "center", gap: 2, paddingHorizontal: 18, paddingVertical: 6, borderTopWidth: 1, borderTopColor: alpha(colors.text, 0.08) }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <If when={state().kind === "installing"}>
            <Spinner size={12} tint={colors.muted} />
          </If>
          <Text style={{ flexShrink: 1, fontSize: 13.5, color: state().kind === "installing" ? colors.muted : colors.info, numberOfLines: 1 }}>{label()}</Text>
        </View>
        <If when={state().kind === "failed"}>
          <Text style={{ fontSize: 12, lineHeight: 16, color: colors.muted, numberOfLines: 2 }}>{(state() as { message?: string }).message}</Text>
        </If>
      </View>
    </If>
  );
}

// ---------------------------------------------------------------- team settings

function Chip(props: { label: string; on: boolean; onPress: () => void; testID?: string; accessibilityLabel?: string }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ selected: props.on }}
      onPress={props.onPress}
      hoverStyle={props.on ? undefined : hovered()}
      focusStyle={focusRing()}
      style={{
        minHeight: touch ? 40 : 34,
        minWidth: 34,
        justifyContent: "center",
        alignItems: "center",
        paddingHorizontal: 12,
        borderRadius: radius.control,
        borderCurve: "continuous",
        borderWidth: 0.5,
        borderColor: props.on ? alpha(colors.text, 0.2) : surfaceEdge(),
        backgroundColor: props.on ? tints.accent : colors.surface,
        transitionProperty: "background-color, border-color",
        transitionDuration: 120,
      }}
    >
      <Text style={{ textAlign: "center", fontSize: 14, fontWeight: props.on ? "600" : "400", color: props.on ? colors.accent : colors.text }}>{props.label}</Text>
    </View>
  );
}

/** A shared stepper for the per-machine parallel limit. */
function ParallelInput(props: { value: number; onChange: (value: number) => void }) {
  return <NumberInput
    testID="parallel" accessibilityLabel="Tasks each machine runs at once" value={props.value} min={1} max={32}
    onChange={({ value }) => { if (value != null && value >= 1 && value <= 32 && value !== props.value) props.onChange(value); }}
    style={{ flexDirection: "row", alignItems: "center", height: touch ? 44 : 36, borderRadius: radius.control, borderCurve: "continuous", backgroundColor: colors.raised }}
    inputStyle={{ width: 40, textAlign: "center", fontSize: 16, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}
    decrementButtonClass="active:opacity-50 disabled:opacity-30" incrementButtonClass="active:opacity-50 disabled:opacity-30"
    decrementButtonStyle={{ width: touch ? 44 : 36, height: touch ? 44 : 36, alignItems: "center", justifyContent: "center" }}
    incrementButtonStyle={{ width: touch ? 44 : 36, height: touch ? 44 : 36, alignItems: "center", justifyContent: "center" }}
    decrementButton={<View testID="parallel-dec"><Icon name="minus" size={16} tint={colors.text} /></View>}
    incrementButton={<View testID="parallel-inc"><Icon name="plus" size={16} tint={colors.text} /></View>}
  />;
}

/** A settings section: the gallery's Card (a title above one flat surface). */
const AUTONOMY_DETAIL: Record<string, string> = {
  onboarding: "Asks you about most things and learns from your answers",
  assisted: "Handles routine work itself, asks you first on important things",
  autonomous: "Decides on its own, asks only about high-risk things",
};
const cliDetail = (clis: string[]) => !clis.length ? "Pause new work for this member" : clis.length === 1
  ? `Use ${providerLabel(clis[0]!)} only` : `Try ${clis.map(providerLabel).join(" → ")} in this order; fallback stays within this selection`;

const taskOrderLabel = (order: string[] | null, member = false) => order === null ? member ? "Use team default" : "Automatic"
  : order.length ? cliLabel(order) : member ? "Pause this member" : "No default task tools";
const memberToolsLabel = (agent: SettingsView["effective"]["agents"][number]) => agent.paused === true ? "Paused"
  : !agent.clis.length ? "No enabled task tools" : cliLabel(agent.clis);
const TOOL_ORDERS = providerOrders(PROVIDER_IDS);

/** Saved policy and the selection being confirmed stay separate; a file reset is never an inheritance value. */
function TaskToolPolicy(props: { settings: Settings; agent?: string; phone?: boolean }) {
  const view = props.settings.view, member = () => view()?.effective.agents.find((agent) => agent.id === props.agent);
  const capability = () => readToolPolicyView(view()?.effective.tool_policy);
  const policy = () => props.agent ? capability() && readToolPolicy(member()?.tool_policy) : capability()?.team;
  const base = props.agent ? `cli-${props.agent}` : "team-tools";
  const edit = () => props.settings.toolEdit(props.agent);
  const pending = () => props.settings.toolSaving(props.agent);
  const order = () => edit() ? edit()!.reset ? policy()?.file_default ?? null : edit()!.order : policy()?.configured ?? null;
  const fromFile = () => edit() ? edit()!.reset : policy()?.source !== "ui";
  const selected = () => fromFile() ? "file" : order() === null ? "inherit" : `order:${cliKey(order()!)}`;
  const selectedLabel = () => !edit() && policy()?.invalid ? "Invalid saved task tool setting"
    : `${fromFile() ? (edit()?.reset ? policy()?.file_source : policy()?.source) === "default" ? "Built-in default · " : "File setting · " : ""}${taskOrderLabel(order(), !!props.agent)}`;
  const enabled = () => view()?.effective.enabled_clis ?? DEFAULT_PROVIDERS;
  const disabledNote = (order: string[]) => {
    const disabled = order.filter((id) => !enabled().includes(id));
    return disabled.length ? `${disabled.map(providerLabel).join(", ")} disabled for execution; kept in this selection.` : "";
  };
  const options = () => [{ id: "inherit", label: props.agent ? "Use team default" : "Automatic", testID: `${base}-inherit`,
    detail: props.agent ? "Follow the team's default task tool policy." : "Let planning choose among enabled tools." },
    ...TOOL_ORDERS.map((tools) => ({ id: `order:${cliKey(tools)}`, label: taskOrderLabel(tools, !!props.agent), testID: `${base}-${cliKey(tools)}`,
      detail: [tools.length ? cliDetail(tools) : props.agent ? "Pause this member, including tasks pinned to a tool." : "Tasks with an explicit tool or member order can still run.", disabledNote(tools)].filter(Boolean).join(" ") }))];
  const choose = (key: string) => {
    if (key === "inherit") void props.settings.saveTools(props.agent, null);
    else { const tools = TOOL_ORDERS.find((tools) => `order:${cliKey(tools)}` === key); if (tools) void props.settings.saveTools(props.agent, tools); }
  };
  const confirmed = (value: ToolPolicy) => {
    if (value.invalid) return "The saved task tool setting is invalid. Choose a valid order. An invalid member setting does not count as a deliberate pause.";
    if (props.agent && value.configured?.length === 0) return "This member is paused for new work, including tasks pinned to a tool.";
    if (!props.agent && value.configured?.length === 0) return "No default task tools. Tasks with an explicit tool or member order can still run.";
    if (!value.effective.length) return "No selected task tools are enabled. Change this selection or enable its tools in AI tools & onboarding.";
    return `Main machine reports enabled task tools: ${cliLabel(value.effective)}. Unavailable tools are skipped on the machine claiming the task.`;
  };
  const source = (value: ToolPolicy) => value.source === "ui" ? "Saved UI setting" : value.source === "local_file" ? "Main machine's local configuration file"
    : value.source === "shared_file" ? "Shared configuration file" : "Built-in default";
  const legacyOptions = () => view()?.options.clis.map((tools) => ({ id: cliKey(tools), label: cliLabel(tools), detail: cliDetail(tools), testID: `${base}-${cliKey(tools)}` })) ?? [];
  const legacyPick = (key: string) => { const tools = view()?.options.clis.find((tools) => cliKey(tools) === key); if (props.agent && tools) void props.settings.save(patches.clis(props.agent, tools)); };
  return <View style={{ gap: 8, flexShrink: 1, maxWidth: props.agent && !props.phone ? 360 : undefined }}>
    <If when={policy()} else={<>
      <If when={props.agent ? member() : undefined}>{(agent) => props.phone
        ? <Choices label="Model" choices={legacyOptions()} selected={agent().paused === false && !agent().clis.length ? "unavailable" : cliKey(agent().clis)} onPick={legacyPick} />
        : <Dropdown testID={base} label="Model" value={memberToolsLabel(agent())} options={legacyOptions()} selected={agent().paused === false && !agent().clis.length ? "unavailable" : cliKey(agent().clis)} onPick={legacyPick} />}</If>
      <Text testID={`${base}-unsupported`} style={{ color: colors.warn, fontSize: 13, lineHeight: 18 }}>Update the app, hub and main machine to configure default task tool order, inheritance and file resets. Existing member orders remain available.</Text>
    </>}>
      {(value) => <>
        {props.phone ? <Choices label="Task tools" choices={options()} selected={selected()} onPick={choose} />
          : <Dropdown testID={base} label={props.agent ? "Task tools" : "Default task tool order"} value={selectedLabel()} selected={selected()} options={options()} onPick={choose} scrollable />}
        <Text testID={`${base}-source`} style={{ color: colors.muted, fontSize: 13, lineHeight: 18 }}>{`${source(value())} · ${value().invalid ? "Invalid task tool setting" : taskOrderLabel(value().configured, !!props.agent)}`}</Text>
        <Text testID={`${base}-confirmed`} style={{ color: value().invalid || !value().effective.length ? colors.warn : colors.muted, fontSize: 13, lineHeight: 18 }}>{confirmed(value())}</Text>
        <Text style={{ color: colors.muted, fontSize: 12.5, lineHeight: 18 }}>{props.agent ? "An explicit task tool can override a nonempty member order. A paused member also blocks pinned tools." : "Explicit member orders and task tool pins can override this default."}</Text>
        <If when={disabledNote(value().configured ?? capability()!.team.configured ?? [])}><Text style={{ color: colors.warn, fontSize: 13, lineHeight: 18 }}>{disabledNote(value().configured ?? capability()!.team.configured ?? [])}</Text></If>
        <Text testID={`${base}-file`} style={{ color: colors.muted, fontSize: 12.5, lineHeight: 18 }}>{value().file_invalid ? "The main machine's file setting is invalid. Choose a valid saved order instead."
          : `Main machine file setting: ${taskOrderLabel(value().file_default, !!props.agent)}. Other machines use their own files after a reset.`}</Text>
        <Btn testID={`${base}-reset`} label="Restore file setting" kind="ghost" disabled={value().source !== "ui" || value().file_invalid === true || pending()}
          onPress={() => void props.settings.saveTools(props.agent, null, true)} />
      </>}
    </If>
    <If when={edit()}><Text testID={`${base}-pending`} style={{ color: colors.muted, fontSize: 13, lineHeight: 18 }}>{`${pending() ? "Saving selection" : "Selection not confirmed"}: ${edit()!.reset ? "Restore file setting" : taskOrderLabel(edit()!.order, !!props.agent)}. Confirmed settings are shown separately.`}</Text>
      <If when={!pending()}><>
        <Btn testID={`${base}-retry`} label="Retry same tool setting" kind="ghost" onPress={() => void props.settings.retryTools(props.agent)} />
        <Btn testID={`${base}-discard`} label="Discard unconfirmed selection…" kind="ghost" disabled={props.settings.saving() > 0} onPress={() => void props.settings.discardTools(props.agent)} />
      </></If>
    </If>
  </View>;
}

/** Member inheritance and restoring machine files are separate, explicit choices. */
function MemberAutonomyPolicy(props: { settings: Settings; agent: string; phone?: boolean }) {
  const view = props.settings.view, member = () => view()?.effective.agents.find((a) => a.id === props.agent);
  const policy = () => view()?.effective.autonomy_policy_version === 1 ? readAutonomyPolicy(member()?.autonomy_policy) : null;
  const base = `autonomy-${props.agent}`, edit = () => props.settings.autonomyEdit(props.agent);
  const pending = () => props.settings.policySaving("autonomy", props.agent);
  const level = () => edit() ? edit()!.reset ? policy()?.file_default ?? null : edit()!.level : policy()?.configured ?? null;
  const fromFile = () => edit() ? edit()!.reset : policy()?.source !== "ui";
  const label = (value: AutonomyLevel | null) => value === null ? `Use team default (${autonomyLabel(view()?.effective.autonomy ?? "onboarding")})` : autonomyLabel(value);
  const selected = () => fromFile() ? "file" : level() ?? "inherit";
  const selectedLabel = () => !edit() && policy()?.invalid ? "Invalid saved autonomy setting"
    : `${fromFile() ? (edit()?.reset ? policy()?.file_source : policy()?.source) === "default" ? "Built-in default · " : "File setting · " : ""}${label(level())}`;
  const choices = () => [{ id: "inherit", label: label(null), detail: "Follow the team's current autonomy default.", testID: `${base}-inherit` },
    ...AUTONOMY_LEVELS.map((level) => ({ id: level, label: autonomyLabel(level), detail: AUTONOMY_DETAIL[level], testID: `${base}-${level}` }))];
  const choose = (value: string) => { if (value === "inherit" || validAutonomyLevel(value)) void props.settings.saveAutonomy(props.agent, value === "inherit" ? null : value); };
  const legacyChoices = () => [{ id: "inherit", label: label(null), detail: "Follow the team's default.", testID: `${base}-inherit` },
    ...(view()?.options.autonomy ?? []).filter(validAutonomyLevel).map((value) => ({ id: value, label: autonomyLabel(value), detail: AUTONOMY_DETAIL[value], testID: `${base}-${value}` }))];
  const legacyPick = (value: string) => { if (value === "inherit" || validAutonomyLevel(value)) void props.settings.save(patches.autonomy(props.agent, value === "inherit" ? null : value)); };
  const source = () => policy()?.source === "ui" ? "Saved UI setting" : policy()?.source === "local_file" ? "Main machine's local configuration file"
    : policy()?.source === "shared_file" ? "Shared configuration file" : "Built-in default";
  return <View style={{ gap: 8, flexShrink: 1, maxWidth: props.phone ? undefined : 360 }}>
    <If when={policy()} else={<>
      {props.phone ? <Choices label="Autonomy" choices={legacyChoices()} selected={member()?.autonomy_inherited ? "inherit" : member()?.autonomy ?? "onboarding"} onPick={legacyPick} />
        : <Dropdown testID={base} label="Autonomy" value={member()?.autonomy_inherited ? label(null) : autonomyLabel(member()?.autonomy ?? "onboarding")}
          options={legacyChoices()} selected={member()?.autonomy_inherited ? "inherit" : member()?.autonomy ?? "onboarding"} onPick={legacyPick} />}
      <Text testID={`${base}-unsupported`} style={{ color: colors.warn, fontSize: 13, lineHeight: 18 }}>Update the app, hub and main machine to see autonomy sources and restore file settings. Existing autonomy choices remain available.</Text>
    </>}>
      {(value) => <>
        {props.phone ? <Choices label="Autonomy" choices={choices()} selected={selected()} onPick={choose} />
          : <Dropdown testID={base} label="Autonomy" value={selectedLabel()} options={choices()} selected={selected()} onPick={choose} />}
        <Text testID={`${base}-source`} style={{ color: colors.muted, fontSize: 13, lineHeight: 18 }}>{`${source()} · ${value().invalid ? "Invalid autonomy setting" : label(value().configured)}`}</Text>
        <Text testID={`${base}-confirmed`} style={{ color: value().invalid ? colors.warn : colors.muted, fontSize: 13, lineHeight: 18 }}>{value().invalid
          ? "The saved autonomy setting is invalid. This member uses Learning until it is repaired."
          : `Main machine reports ${autonomyLabel(value().effective)}${value().configured === null ? " from the team default" : ""}.`}</Text>
        <Text testID={`${base}-file`} style={{ color: colors.muted, fontSize: 12.5, lineHeight: 18 }}>{value().file_invalid
          ? "The main machine's file setting is invalid. Choose a valid saved autonomy level instead."
          : `Main machine file setting: ${label(value().file_default)}. Other machines use their own files after a reset.`}</Text>
        <Btn testID={`${base}-reset`} label="Restore file setting" kind="ghost" disabled={value().source !== "ui" || value().file_invalid === true || pending()}
          onPress={() => void props.settings.saveAutonomy(props.agent, null, true)} />
      </>}
    </If>
    <Text testID={`${base}-scope`} style={{ color: colors.muted, fontSize: 12.5, lineHeight: 18 }}>Controls approval for this member's self-generated work. Owner-requested tasks still run; tool permissions remain separate.</Text>
    <If when={edit()}><Text testID={`${base}-pending`} style={{ color: colors.muted, fontSize: 13, lineHeight: 18 }}>{`${pending() ? "Saving selection" : "Selection not confirmed"}: ${edit()!.reset ? "Restore file setting" : label(edit()!.level)}. Confirmed settings are shown separately.`}</Text>
      <If when={!pending()}><>
        <Btn testID={`${base}-retry`} label="Retry same autonomy setting" kind="ghost" onPress={() => void props.settings.retryPolicy("autonomy", props.agent)} />
        <Btn testID={`${base}-discard`} label="Discard unconfirmed selection…" kind="ghost" disabled={props.settings.saving() > 0} onPress={() => void props.settings.discardPolicy("autonomy", props.agent)} />
      </></If>
    </If>
  </View>;
}

type DropdownOption = { id: string; label: string; detail?: string; testID?: string };

/** A labelled value that opens a menu of its choices (each with a line saying what it means). */
function Dropdown(props: { label: string; value: string; options: DropdownOption[]; selected: string; onPick: (id: string) => void; testID?: string; scrollable?: boolean }) {
  const items = () => <Each of={props.options}>{(o) => <MenuItem testID={o().testID} role="menuitemradio" checked={o().id === props.selected}
    onSelect={() => o().id !== props.selected && props.onPick(o().id)} hoverStyle={hovered()}
    style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 7, paddingHorizontal: 10, borderRadius: 6 }}>
    <View style={{ width: 14, paddingTop: 3 }}><If when={o().id === props.selected}><Icon name="check" size={13} tint={colors.text} /></If></View>
    <View style={{ flex: 1, gap: 2 }}><Text style={{ fontSize: 14, fontWeight: "500", color: colors.text }}>{o().label}</Text>
      <If when={o().detail}><Text style={{ fontSize: 12.5, lineHeight: 17, color: colors.muted }}>{o().detail}</Text></If>
    </View>
  </MenuItem>}</Each>;
  return (
    <Menu
      align="end"
      offset={6}
      margin={8}
      popupStyle={{ minWidth: 260, maxWidth: 340, padding: 4, borderRadius: radius.control, borderCurve: "continuous", borderWidth: 0.5, borderColor: surfaceEdge(), backgroundColor: colors.surface }}
      trigger={
        <View
          role="button"
          testID={props.testID}
          accessibilityLabel={`${props.label}: ${props.value}`}
          hoverStyle={hovered()}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 34, paddingLeft: 11, paddingRight: 9, borderRadius: radius.control, borderCurve: "continuous", borderWidth: 0.5, borderColor: surfaceEdge(), backgroundColor: colors.surface }}
        >
          <Text style={{ fontSize: 13, color: colors.faint }}>{props.label}</Text>
          <Text style={{ fontSize: 14, fontWeight: "500", color: colors.text }}>{props.value}</Text>
          <Icon name="chevron-down" size={12} tint={colors.muted} />
        </View>
      }
    >
      {props.scrollable ? <Scroll testID={`${props.testID}-options`} style={{ maxHeight: 360 }}>{items()}</Scroll> : items()}
    </Menu>
  );
}

function Group(props: { title: string; hint?: string; children: JSX.Element }) {
  return (
    <View style={{ gap: 8 }}>
      <View style={{ gap: 3, paddingHorizontal: 2 }}>
        <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>{props.title}</Text>
        {props.hint ? <Text style={{ fontSize: 13.5, lineHeight: 20, color: colors.muted }}>{props.hint}</Text> : null}
      </View>
      <View style={{ borderRadius: radius.card, borderCurve: "continuous", borderWidth: 0.5, borderColor: surfaceEdge(), overflow: "hidden" }}>{props.children}</View>
    </View>
  );
}

// ---------------------------------------------------------------- notifications (Web Push through host.js; the system's in an installed app)

/** In an installed app (no page host) NSH shows the system's notifications; they appear while the app runs. */
const systemNotifications = () => !host.available();
/** The notifications this run showed, by id, to take them back. Ones without an event to open start with `noop:`. */
const showing = new Set<string>();
const closeNotification = (id: string) => {
  if (!showing.delete(id)) return;
  Notifications.close(id).catch(() => {});
};
function clearNotification(ref: string) {
  if (systemNotifications()) closeNotification(ref);
  else hostCall("clearNotifications", { ref });
}
function setBadge(count: number) {
  if (systemNotifications()) Notifications.setBadge(count).catch(() => {}); // iOS refuses it before the permission
  else hostCall("setBadge", { count });
}
const DEVICES: Record<string, string> = { macos: "Mac", ios: "iPhone", android: "Android", windows: "Windows", linux: "Linux" };

type PushInfo = { supported: boolean; ios: boolean; standalone: boolean; permission: string; subscribed: boolean; endpoint: string | null; device: string };
type Note = { text: string; tone: "ok" | "bad" } | null;

async function systemInfo(): Promise<PushInfo | null> {
  try {
    const permission = await Notifications.permission();
    if (permission === "unavailable") return null;
    const off = !!(await Storage.getItem(KEYS.notifyOff));
    return { supported: true, ios: false, standalone: true, permission, subscribed: permission === "granted" && !off, endpoint: null, device: DEVICES[platform.os] ?? "This device" };
  } catch {
    return null;
  }
}

/** This device's push state and the steps that change it (the permission prompt needs the press that calls `enable`). */
function createPush(hub: Hub) {
  const info = signal<PushInfo | null>(null);
  const busy = signal(false);
  const note = signal<Note>(null);
  const refresh = async () => info.set(systemNotifications() ? await systemInfo() : await hostCall<PushInfo>("pushState"));
  refresh();

  async function run(work: () => Promise<string>) {
    busy.set(true);
    note.set(null);
    try {
      note.set({ text: await work(), tone: "ok" });
    } catch (e) {
      note.set({ text: e instanceof Error ? e.message : String(e), tone: "bad" });
    } finally {
      busy.set(false);
      await refresh();
    }
  }
  const enable = () =>
    run(async () => {
      if (systemNotifications()) {
        const permission = await Notifications.requestPermission();
        if (permission === "denied") throw new Error("Notifications are blocked. Allow Noop to send notifications in system settings, then come back and turn them on");
        if (permission !== "granted") throw new Error("Notifications weren't turned on");
        await Storage.removeItem(KEYS.notifyOff);
        return "Turned on: decisions that need you will arrive as system notifications";
      }
      // Ask the browser first, while the press still counts as the user's gesture.
      const v = hub.api("GET", "/api/push/vapid");
      const key = (await v).data.publicKey;
      if (typeof key !== "string" || !key) throw new Error("The server has no push configured yet, so notifications can't be turned on");
      const r = await hostCall<{ permission: string; subscription: unknown; device?: string }>("pushEnable", { publicKey: key });
      if (!r) throw new Error("This environment doesn't support web push");
      if (r.permission === "denied") throw new Error("Notifications are blocked. Allow Noop to send notifications in your browser or system settings, then come back and turn them on");
      if (r.permission !== "granted" || !r.subscription) throw new Error("Notifications weren't turned on");
      const s = await hub.api("POST", "/api/push/subscribe", { subscription: r.subscription, device_label: r.device ?? untracked(info)?.device ?? "Device" });
      if (!s.ok) throw new Error(`Subscription failed (${s.status || "can't reach the server"})`);
      return "Turned on: decisions that need you will be pushed to this device";
    });
  const disable = () =>
    run(async () => {
      if (systemNotifications()) {
        await Storage.setItem(KEYS.notifyOff, "1");
        for (const id of [...showing]) closeNotification(id);
        return "Notifications turned off on this device";
      }
      const r = await hostCall<{ endpoint: string | null }>("pushDisable");
      if (r?.endpoint) await hub.api("POST", "/api/push/unsubscribe", { endpoint: r.endpoint });
      return "Notifications turned off on this device";
    });
  const test = () =>
    run(async () => {
      if (systemNotifications()) {
        showing.add("noop:test");
        if (!(await Notifications.show({ id: "noop:test", title: "Noop", body: "Test notification: system notifications are on." }))) throw new Error("The system didn't accept this notification");
        return "Test notification sent";
      }
      const r = await hub.api("POST", "/api/push/test");
      if (!r.ok) throw new Error(`Test notification failed (${r.status || "can't reach the server"})`);
      return "Test notification sent; it should arrive within a few seconds";
    });
  /** iOS shows web push only to an app added to the home screen. */
  const needsHomeScreen = () => !!info()?.ios && !info()?.standalone;
  const canAsk = () => !!info()?.supported && !needsHomeScreen();
  return { info, busy, note, refresh, enable, disable, test, needsHomeScreen, canAsk };
}
type Push = ReturnType<typeof createPush>;

function Steps(props: { steps: string[] }) {
  return (
    <View style={{ gap: 8 }}>
      <Each of={props.steps}>
        {(s, i) => (
          <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
            <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: tints.accent }}>
              <Text style={{ fontSize: 12.5, fontWeight: "700", color: colors.accent }}>{String(i() + 1)}</Text>
            </View>
            <Text style={{ flex: 1, fontSize: 15, lineHeight: 22, color: colors.text }}>{s()}</Text>
          </View>
        )}
      </Each>
    </View>
  );
}

function NotifySettings(props: { push: Push; view: SettingsView | null; save: (patch: Record<string, unknown>) => void; wide: boolean }) {
  const push = props.push;
  const { prefs, setPrefs, state } = notifyModel(push, () => props.view, props.save);
  const row = (): ViewStyle => ({ gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 0.5, borderTopColor: surfaceEdge() });
  return (
    <Group title="Notifications" hint={systemNotifications() ? "While Noop is running, decisions that need you are sent as system notifications; tap one to jump straight to it." : "Decisions that need you are pushed to your phone; you can pick an option right from the notification."}>
      <View style={{ gap: 12, paddingHorizontal: 16, paddingVertical: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Dot tone={push.info()?.subscribed ? "on" : push.info()?.permission === "denied" ? "bad" : "off"} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: 15.5, fontWeight: "600", color: colors.text }}>{push.info()?.device ?? "This device"}</Text>
            <Text testID="push-state" style={{ fontSize: 13.5, color: colors.muted }}>{state()}</Text>
          </View>
        </View>
        <If when={push.needsHomeScreen()}>
          <View style={{ gap: 10, padding: 14, borderRadius: radius.inset, backgroundColor: colors.inset, borderWidth: 1, borderColor: colors.line }}>
            <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>Turn on notifications on iPhone</Text>
            <Steps steps={["In Safari, tap the Share button at the bottom", "Choose Add to Home Screen, then tap Add", "Open Noop from the Home Screen, sign in, and come back here to tap Turn on notifications"]} />
          </View>
        </If>
        <If when={push.info()?.permission === "denied" && !push.needsHomeScreen()}>
          <Text style={{ fontSize: 14, lineHeight: 21, color: colors.muted }}>{systemNotifications() ? "Allow Noop in System Settings → Notifications, then come back and turn it on." : "Allow Noop in your browser's site settings (or System Settings → Notifications), then reload the page and turn it on."}</Text>
        </If>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <If
            when={push.info()?.subscribed}
            else={<Btn testID="push-enable" label="Turn on notifications" icon="bell" kind="primary" busy={push.busy()} disabled={!push.canAsk()} onPress={push.enable} />}
          >
            <Btn testID="push-test" label="Send test notification" icon="bell" busy={push.busy()} onPress={push.test} />
            <Btn testID="push-disable" label="Turn off for this device" kind="ghost" onPress={push.disable} />
          </If>
        </View>
        <If when={push.note()}>
          <Text testID="push-note" style={{ fontSize: 14, lineHeight: 20, color: push.note()!.tone === "ok" ? colors.up : colors.danger }}>{push.note()!.text}</Text>
        </If>
      </View>
      <If when={props.view}>
        <View style={row()}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: colors.muted }}>What to push</Text>
          <Each of={NOTIFY_KINDS as unknown as [NotifyKind, string][]}>
            {(k) => (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 36 }}>
                <Text style={{ flex: 1, fontSize: 15.5, color: colors.text }}>{k()[1]}</Text>
                <Toggle
                  testID={`notify-${k()[0]}`}
                  label={k()[1]}
                  value={prefs().kinds[k()[0]]}
                  onChange={(on) => setPrefs({ kinds: { ...prefs().kinds, [k()[0]]: on } })}
                />
              </View>
            )}
          </Each>
        </View>
        <View style={row()}>
          <View style={{ gap: 2 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: colors.muted }}>Quiet hours</Text>
            <Text style={{ fontSize: 13, color: colors.faint }}>Recorded but not pushed during this time (time zone {prefs().tz})</Text>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Each of={QUIET_PRESETS}>
              {(q) => (
                <Chip
                  testID={`quiet-${quietKey(q().value)}`}
                  label={q().label}
                  on={quietKey(q().value) === quietKey(prefs().quiet_hours)}
                  onPress={() => setPrefs({ quiet_hours: q().value })}
                />
              )}
            </Each>
          </View>
          <NotificationTimeZone prefs={prefs} save={setPrefs} />
        </View>
      </If>
    </Group>
  );
}

/** The team's settings, shared by the settings page and the pages it pushes on phones. */
function createSettings(hub: Hub) {
  const view = signal<SettingsView | null>(null);
  const error = signal("");
  const saved = signal("");
  const saving = signal(0);
  let writes = Promise.resolve();
  let revision = 0;
  let confirmed: SettingsView | null = null;
  const pending: { patch: Record<string, unknown> }[] = [];
  type PolicyKind = "tools" | "autonomy";
  type PolicyEdit = { patch: Record<string, unknown>; reset: boolean; requestKey: string };
  type ToolEdit = PolicyEdit & { order: string[] | null };
  type AutonomyEdit = PolicyEdit & { level: AutonomyLevel | null };
  const policyKey = (kind: PolicyKind, agent?: string) => `${kind}:${agent ?? ""}`;
  const policyEdits = signal(new Map<string, PolicyEdit>());
  const policyFailures = new Map<string, string>();
  let policyErrorOwner: string | undefined;
  const remainingPolicyError = () => { const last = [...policyFailures].at(-1); policyErrorOwner = last?.[0]; error.set(last?.[1] ?? ""); };
  function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
    const result = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      const previous = result[key];
      result[key] = value && typeof value === "object" && !Array.isArray(value)
        ? merge(previous && typeof previous === "object" && !Array.isArray(previous) ? previous as Record<string, unknown> : {}, value as Record<string, unknown>)
        : value;
    }
    return result;
  }
  function displayed(v: SettingsView): SettingsView {
    const current = v.current as { clis?: { agents?: Record<string, string[]> }; autonomy?: { agents?: Record<string, string | null> }; routines?: Record<string, { enabled?: boolean; every?: string }>; host?: { max_parallel?: number } };
    return { ...v, effective: { ...v.effective,
      agents: v.effective.agents.map((a) => ({ ...a, clis: readToolPolicyView(v.effective.tool_policy) && readToolPolicy(a.tool_policy) ? a.clis : current.clis?.agents?.[a.id] ?? a.clis })),
      routines: v.effective.routines.map((r) => ({ ...r, ...current.routines?.[r.name] })),
      max_parallel: current.host?.max_parallel ?? v.effective.max_parallel,
    } };
  }
  function refresh() {
    if (!confirmed) return;
    const current = pending.reduce((state, item) => merge(state, item.patch), confirmed.current);
    view.set(displayed({ ...confirmed, current }));
  }
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(savedTimer));
  const load = (keepError = false) => {
    if (!keepError) error.set("");
    const started = revision;
    hub.settings().then((v) => { if (started === revision && !saving()) { confirmed = v; refresh(); } }, (e) => { if (started === revision && !saving()) error.set(String(e?.message ?? e)); });
  };
  async function save(patch: Record<string, unknown>, policyKey?: string, requestKey?: string) {
    revision++;
    if (policyKey === undefined) { error.set(""); policyErrorOwner = undefined; }
    else { policyFailures.delete(policyKey); if (policyErrorOwner === policyKey) remainingPolicyError(); }
    saved.set("");
    clearTimeout(savedTimer);
    saving.update((n) => n + 1);
    const item = { patch };
    pending.push(item);
    refresh();
    let accepted = false;
    try {
      const request = writes.then(() => hub.settings(patch, requestKey));
      writes = request.then(() => {}, () => {});
      confirmed = await request;
      accepted = true;
      if (policyKey !== undefined) { policyFailures.delete(policyKey); if (policyErrorOwner === policyKey) remainingPolicyError(); }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (policyKey === undefined) { policyErrorOwner = undefined; error.set(message); }
      else if (policyEdits().get(policyKey)?.patch === patch) { policyFailures.set(policyKey, message); policyErrorOwner = policyKey; error.set(message); }
    } finally {
      pending.splice(pending.indexOf(item), 1);
      refresh();
      saving.update((n) => n - 1);
      if (!saving() && !error()) {
        saved.set("Saved");
        savedTimer = setTimeout(() => saved.set(""), 1600);
      }
    }
    return accepted;
  }
  const toolEdit = (agent?: string) => policyEdits().get(policyKey("tools", agent)) as ToolEdit | undefined;
  const autonomyEdit = (agent: string) => policyEdits().get(policyKey("autonomy", agent)) as AutonomyEdit | undefined;
  const policySaving = (kind: PolicyKind, agent?: string) => { view(); const edit = policyEdits().get(policyKey(kind, agent)); return !!edit && pending.some((item) => item.patch === edit.patch); };
  const toolSaving = (agent?: string) => policySaving("tools", agent);
  async function submitPolicy(key: string, edit: PolicyEdit) {
    const accepted = await save(edit.patch, key, edit.requestKey);
    if (accepted) policyEdits.update((all) => { const next = new Map(all); if (next.get(key) === edit) next.delete(key); return next; });
    return accepted;
  }
  function setPolicy(kind: PolicyKind, agent: string | undefined, edit: PolicyEdit) {
    const key = policyKey(kind, agent);
    policyEdits.update((all) => new Map(all).set(key, edit));
    return submitPolicy(key, edit);
  }
  function saveTools(agent: string | undefined, order: string[] | null, reset = false) {
    const edit = { patch: reset ? patches.toolReset(agent) : patches.toolOrder(agent, order), reset, order, requestKey: newRequestKey() };
    return setPolicy("tools", agent, edit);
  }
  function saveAutonomy(agent: string, level: AutonomyLevel | null, reset = false) {
    return setPolicy("autonomy", agent, { patch: reset ? patches.autonomyReset(agent) : patches.autonomyPolicy(agent, level), reset, level, requestKey: newRequestKey() } as AutonomyEdit);
  }
  const retryPolicy = (kind: PolicyKind, agent?: string) => { const key = policyKey(kind, agent), edit = policyEdits().get(key); if (edit && !policySaving(kind, agent)) return submitPolicy(key, edit); return Promise.resolve(false); };
  const retryTools = (agent?: string) => retryPolicy("tools", agent);
  async function discardPolicy(kind: PolicyKind, agent?: string) {
    const key = policyKey(kind, agent), edit = policyEdits().get(key);
    if (!edit || saving()) return;
    const result = await AlertDialog.show({ title: "Discard unconfirmed selection?",
      description: "This removes only this device's recovery information for this selection. It does not undo settings or tasks already applied. Confirmed settings will be reloaded.",
      actions: [{ id: "keep", label: "Keep selection", role: "cancel" }, { id: "discard", label: "Discard selection", role: "destructive" }] });
    if (result.action !== "discard" || saving() || policyEdits().get(key) !== edit) return;
    hub.discardPolicyConfirmation(edit.patch, edit.requestKey);
    policyEdits.update((all) => { const next = new Map(all); if (next.get(key) === edit) next.delete(key); return next; });
    policyFailures.delete(key); if (policyErrorOwner === key) remainingPolicyError();
    revision++; load(true);
  }
  const discardTools = (agent?: string) => discardPolicy("tools", agent);
  // the command being added in Commands (kept here: the settings page may be laid out again while typing)
  /** The command editor: `editing` is undefined when closed, "" for a new command, else the name being edited. */
  const commandDraft = { name: signal(""), text: signal(""), editing: signal<string | undefined>(undefined), note: signal("") };
  /** The member editor: `editing` is undefined when closed, "" for a new member, else the id being edited. */
  const memberDraft = { title: signal(""), name: signal(""), about: signal(""), instructions: signal(""), editing: signal<string | undefined>(undefined), note: signal(""), busy: signal(false) };
  async function openMember(id = "") {
    const d = memberDraft;
    error.set("");
    let m: Record<string, unknown> = {};
    if (id) {
      const r = await hub.api("GET", `/api/members/${id}`);
      if (!r.ok) return error.set(String(r.data.error ?? `Couldn't load this member (${r.status})`));
      m = r.data;
    }
    d.title.set(String(m.title ?? "")); d.name.set(String(m.name ?? "")); d.about.set(String(m.about ?? "")); d.instructions.set(String(m.instructions ?? "")); d.note.set("");
    d.editing.set(id);
  }
  /** Sends an editor's change; true once it's saved, else the dialog stays open with the reason. */
  const writer = (d: { busy: Signal<boolean>; note: Signal<string>; editing: Signal<string | undefined> }, localOnly: string) => async (method: string, path: string, body?: unknown): Promise<boolean> => {
    d.busy.set(true);
    d.note.set("");
    const r = await hub.api(method, path, body);
    d.busy.set(false);
    if (!r.ok) {
      const message = r.status === 404 ? localOnly : String(r.data.error ?? "Couldn't reach the server");
      if (r.data.saved_locally && r.data.view) {
        confirmed = r.data.view as SettingsView; refresh();
        if (method === "DELETE") { error.set(message); d.editing.set(undefined); return true; }
        if (typeof r.data.id === "string") d.editing.set(r.data.id);
      }
      d.note.set(message);
      return false;
    }
    confirmed = r.data.view as SettingsView;
    refresh();
    d.editing.set(undefined);
    return true;
  };
  const writeMember = writer(memberDraft, "Update the hub and main machine to edit members");
  /** The project editor: `editing` is undefined when closed, "" for a new project, else the id being edited. */
  const projectDraft = { generation: 0, probeReceived: 0, name: signal(""), path: signal(""), host: signal(""), repo: signal(""), requires: signal(""), instructions: signal(""), original: signal<Project | undefined>(undefined), probe: signal<(ProjectFolderCheck & { probe_ticket?: string }) | null>(null), checking: signal(false), editing: signal<string | undefined>(undefined), note: signal(""), busy: signal(false) };
  function openProject(p?: Project) {
    const d = projectDraft;
    d.generation++;
    d.name.set(p?.name ?? ""); d.path.set(p?.path ?? ""); d.host.set(p?.host ?? view()?.effective.primary_host ?? "");
    d.repo.set(p?.custom_repo === undefined ? p?.repo ?? "" : p.custom_repo ?? "");
    d.requires.set((p?.custom_requires ?? p?.requires ?? []).join(",")); d.original.set(p); d.probe.set(null);
    d.instructions.set(p?.instructions ?? ""); d.note.set("");
    d.editing.set(p?.id ?? "");
  }
  const projectHost = () => projectDraft.host() || view()?.effective.primary_host || "";
  const projectPlacementChanged = () => !projectDraft.original() || projectHost() !== projectDraft.original()!.host || projectDraft.path().trim() !== projectDraft.original()!.path;
  const projectProbe = () => {
    const p = projectDraft.probe();
    return p && p.host === projectHost() && p.requested_path === projectDraft.path().trim() && Date.now() - projectDraft.probeReceived < 300_000 ? p : null;
  };
  async function checkProjectFolder() {
    const d = projectDraft, host = projectHost(), path = d.path().trim(), editing = d.editing(), generation = d.generation;
    if (!host || !path || d.checking() || d.busy()) return false;
    d.checking.set(true); d.note.set(""); d.probe.set(null);
    const r = await hub.api("POST", `/api/machines/${encodeURIComponent(host)}/project-folder-check`, { path });
    d.checking.set(false);
    if (d.generation !== generation || d.editing() !== editing || projectHost() !== host || d.path().trim() !== path) return false;
    if (!r.ok) { d.note.set(r.status === 404 || r.status === 405 ? "Update the hub and selected machine to check project folders." : String(r.data.error ?? "Couldn't check this folder. Reconnect the selected machine and retry.")); return false; }
    const p = r.data;
    if (p.host !== host || p.requested_path !== path || typeof p.path !== "string" || !p.path || typeof p.repo !== "string" || !Array.isArray(p.requires) || !p.requires.every((cap) => typeof cap === "string") || typeof p.checked !== "string" || !Number.isFinite(Date.parse(p.checked))
      || host !== view()?.effective.primary_host && (typeof p.probe_ticket !== "string" || !/^[a-f0-9-]{36}$/.test(p.probe_ticket))) {
      d.note.set("The selected machine did not confirm this folder. Check it again before saving."); return false;
    }
    d.probeReceived = Date.now(); d.probe.set(p as ProjectFolderCheck & { probe_ticket?: string });
    return true;
  }
  const projectValues = () => JSON.stringify([projectDraft.name(), projectDraft.path(), projectDraft.host(), projectDraft.repo(), projectDraft.requires(), projectDraft.instructions()]);
  async function writeProject(method: string, path: string, body?: unknown) {
    const d = projectDraft, editing = d.editing(), values = projectValues(), generation = d.generation;
    revision++; d.busy.set(true); d.note.set("");
    const r = await hub.api(method, path, body);
    d.busy.set(false);
    if ((r.ok || r.data.saved_locally) && r.data.view) { confirmed = r.data.view as SettingsView; refresh(); }
    if (d.generation !== generation || d.editing() !== editing) return r.ok;
    const id = typeof r.data.id === "string" ? r.data.id : editing, changed = projectValues() !== values;
    if (r.ok || r.data.saved_locally) {
      const saved = view()?.effective.projects?.find((p) => p.id === id), sent = body as { path?: string; host?: string } | undefined;
      if (saved && sent?.path === d.path().trim() && (sent.host ?? saved.host) === projectHost()) d.path.set(saved.path);
      d.original.set(saved ?? d.original());
    }
    if (!r.ok) {
      if (r.status === 409 && (body as { probe_ticket?: unknown } | undefined)?.probe_ticket) d.probe.set(null);
      const message = r.status === 404 ? "Update the hub and main machine to edit projects" : String(r.data.error ?? "Couldn't reach the server");
      if (r.data.saved_locally && id) {
        if (method === "DELETE") { error.set(message); d.editing.set(undefined); return true; }
        d.editing.set(id);
      }
      d.note.set(message); return false;
    }
    if (method !== "DELETE" && changed) {
      d.editing.set(id); d.note.set("The earlier version was saved. Your newer edits are still here; save again to apply them.");
    } else d.editing.set(undefined);
    return true;
  }
  async function saveProject() {
    const d = projectDraft;
    if (d.busy() || d.checking()) return;
    const advanced = !!view()?.effective.primary_host;
    if (advanced && projectHost() !== view()!.effective.primary_host && projectPlacementChanged() && !projectProbe()) {
      if (!await checkProjectFolder()) return;
    }
    const probe = projectProbe();
    const body = { name: d.name(), path: d.path().trim(), instructions: d.instructions(), ...(advanced ? { host: projectHost(), repo: d.repo().trim(), requires: d.requires().trim(), ...(probe?.probe_ticket ? { probe_ticket: probe.probe_ticket } : {}) } : {}) };
    return writeProject(d.editing() === "" ? "POST" : "PUT", d.editing() === "" ? "/api/projects" : `/api/projects/${d.editing()}`, body);
  }
  /** The routine editor: `editing` is undefined when closed, "" for a new routine, else the name being edited. */
  const routineDraft = { prefer: signal(""), weight: signal("normal"), repo: signal(""), scheduler: signal("primary"), detector: signal(""), requires: signal(""), host: signal("any"), cli: signal("auto"), priority: signal("normal"), name: signal(""), every: signal("daily 09:00"), agent: signal("lead"), project: signal(""), prompt: signal(""), desc: signal(""), enabled: signal(true), readonly: signal(false), kind: signal(""), editing: signal<string | undefined>(undefined), note: signal(""), busy: signal(false) };
  async function openRoutine(name = "") {
    const d = routineDraft;
    error.set("");
    let m: Record<string, unknown> = {};
    if (name) {
      const r = await hub.api("GET", `/api/routines/${encodeURIComponent(name)}`);
      if (!r.ok) return error.set(r.status === 404 ? "Update the hub and main machine to edit routines" : String(r.data.error ?? "Couldn't reach the server"));
      m = r.data;
    }
    d.prefer.set(String(m.prefer ?? "")); d.weight.set(String(m.weight ?? "normal")); d.repo.set(String(m.repo ?? "")); d.scheduler.set(String(m.scheduler ?? (m.kind === "learn" ? "each" : "primary"))); d.detector.set(String(m.signal ?? ""));
    d.requires.set(String(m.requires ?? "")); d.host.set(String(m.host ?? "any")); d.cli.set(String(m.cli ?? "auto")); d.priority.set(String(m.priority ?? "normal"));
    d.name.set(String(m.name ?? "")); d.every.set(String(m.every ?? "daily 09:00")); d.agent.set(String(m.agent ?? "lead")); d.project.set(String(m.project ?? ""));
    d.prompt.set(String(m.prompt ?? "")); d.desc.set(String(m.desc ?? "")); d.enabled.set(m.enabled !== false); d.readonly.set(m.readonly === true); d.kind.set(String(m.kind ?? "")); d.note.set("");
    d.editing.set(name);
  }
  const writeRoutine = writer(routineDraft, "Update the hub and main machine to edit routines");
  /** The section the wide settings page shows (its sidebar picks it). */
  const tab = signal<SettingsTab>("notify");
  return { accept: (next: SettingsView) => { revision++; confirmed = next; refresh(); }, machines: () => [...(hub.status()?.hosts ?? []), ...(hub.status()?.offline_hosts ?? [])], view, error, saved, saving, load, save, toolEdit, toolSaving, saveTools, retryTools, discardTools, autonomyEdit, saveAutonomy, policySaving, retryPolicy, discardPolicy, commandDraft, memberDraft, openMember, writeMember, projectDraft, openProject, writeProject, saveProject, checkProjectFolder, projectHost, projectProbe, projectPlacementChanged, routineDraft, openRoutine, writeRoutine, tab };
}
type Settings = ReturnType<typeof createSettings>;

/** Operational controls share one validated endpoint locally and through the primary-machine bridge. */
function ConfigurationSettings(props: { hub: Hub; machine?: string; initialGroup?: keyof typeof CONFIGURATION_GROUPS; onTask: (id: string) => void }) {
  const fields = props.machine ? MACHINE_CONFIGURATION_FIELDS : CONFIGURATION_FIELDS;
  const endpoint = props.machine ? `/api/machines/${encodeURIComponent(props.machine)}/configuration` : "/api/configuration";
  const values = signal<Record<string, ConfigValue>>({}), baseline = signal<Record<string, ConfigValue>>({});
  const health = signal<ProviderStatus[]>([]);
  const learningSupported = signal(false);
  const diskPathSupported = signal(false);
  const learning = signal<{ host: string; blocked_reason: string | null } | null>(null);
  const overrides = signal<string[]>([]), loaded = signal(false), busy = signal(false), note = signal(""), failed = signal(false);
  const group = signal<keyof typeof CONFIGURATION_GROUPS>(props.machine ? "resources" : props.initialGroup ?? "execution");
  const id = (path: string) => `configuration-${path.replace(/\./g, "-")}`;
  const optionLabel = (f: ConfigurationField, key: string) => f.optionLabels && Object.prototype.hasOwnProperty.call(f.optionLabels, key) ? f.optionLabels[key]! : key;
  const reported = (f: ConfigurationField) => Object.prototype.hasOwnProperty.call(baseline(), f.path);
  const supported = (f: ConfigurationField) => reported(f) && (!props.machine || (f.group !== "onboarding" || learningSupported()) && (f.path !== "resources.disk_path" || diskPathSupported()));
  const normalized = (f: ConfigurationField, value: ConfigValue | undefined): ConfigValue => {
    if (f.kind === "number" && typeof value === "string") return value.trim() ? Number(value) : null;
    if ((f.kind === "folders" || f.kind === "names" || f.kind === "patterns") && typeof value === "string") return value.split("\n").map((p) => p.trim()).filter(Boolean);
    if ((f.kind === "model" || f.kind === "path") && typeof value === "string") return value.trim() || null;
    return value ?? null;
  };
  const changes = () => Object.fromEntries(fields.filter(supported).map((f) => [f.path, normalized(f, values()[f.path])] as const)
    .filter(([path, value]) => JSON.stringify(value) !== JSON.stringify(baseline()[path])));
  const set = (path: string, value: ConfigValue) => { values.update((v) => ({ ...v, [path]: value })); note.set(""); };
  const accept = (data: Record<string, unknown>, keep: Record<string, ConfigValue> = {}) => {
    const confirmed = data.values as Record<string, ConfigValue>;
    health.set((data.provider_status as ProviderStatus[]) ?? []);
    learningSupported.set(data.learning_supported === true);
    diskPathSupported.set(data.disk_path_supported === true);
    learning.set((data.learning as { host: string; blocked_reason: string | null }) ?? null);
    baseline.set(confirmed); values.set({ ...confirmed, ...keep });
    overrides.set((data.overrides as string[]) ?? []); loaded.set(true);
  };
  async function load() {
    busy.set(true); failed.set(false); note.set("");
    const r = await props.hub.api("GET", endpoint);
    if (r.ok && r.data.values) accept(r.data);
    else { failed.set(true); note.set(r.status === 404 ? "Update the hub and main machine to use team configuration." : String(r.data.error ?? "Couldn't load configuration")); }
    busy.set(false);
  }
  void load();
  async function save(reset?: string[]) {
    const pending = changes(), submitted = values();
    busy.set(true); failed.set(false); note.set("");
    const r = await props.hub.api("PUT", endpoint, reset ? { reset } : { values: pending });
    if (r.ok && r.data.values) {
      const keep: Record<string, ConfigValue> = reset ? Object.fromEntries(Object.entries(pending).filter(([path]) => !reset.includes(path))) : {};
      for (const f of fields) if (JSON.stringify(normalized(f, values()[f.path])) !== JSON.stringify(normalized(f, submitted[f.path]))) keep[f.path] = values()[f.path];
      accept(r.data, keep);
      note.set(Object.keys(changes()).length ? "Submitted changes saved. You have additional unsaved edits." : "Saved. Settings apply on each machine's next sync; running agents keep their current limits.");
    } else { failed.set(true); note.set(String(r.data.error ?? "Couldn't save configuration")); }
    busy.set(false);
  }
  const visible = () => fields.filter((f) => f.group === group() && supported(f)
    && (f.path !== "judge.model" || values()["judge.cli"] === "claude") && (f.path !== "judge.codex_model" || values()["judge.cli"] === "codex") && (f.path !== "judge.hermes_model" || values()["judge.cli"] === "hermes"));
  return <View testID="configuration-page" style={{ gap: 18 }}>
    <Text role="header" style={{ fontSize: 20, fontWeight: "600", color: colors.text }}>{props.machine ? `Configuration for ${props.machine}` : "Team configuration"}</Text>
    <Text style={{ fontSize: 13.5, lineHeight: 20, color: colors.muted }}>{props.machine ? "Overrides for this machine only. Paths use its own filesystem and home folder. Other values use its reported defaults. Offline machines apply changes when they reconnect." : "Shared operational settings for the team. Saved overrides take precedence over configuration files. Each machine’s own run limits still take precedence."}</Text>
    <If when={loaded()} else={<Btn testID="configuration-reload" label={busy() ? "Loading…" : "Load configuration"} disabled={busy()} onPress={() => void load()} />}>
      <Dropdown testID="configuration-group" label="Section" value={props.machine && group() === "onboarding" ? "Learning history" : CONFIGURATION_GROUPS[group()]} selected={group()} onPick={(key) => group.set(key as keyof typeof CONFIGURATION_GROUPS)}
        options={(props.machine ? [["resources", "Resource limits"], ["onboarding", "Learning history"]] : Object.entries(CONFIGURATION_GROUPS)).map(([key, label]) => ({ id: key!, label: label!, testID: `configuration-group-${key}` }))} />
      <If when={fields.some((f) => f.group === group() && !reported(f))}><Text testID="configuration-unsupported" style={{ color: colors.warn, fontSize: 13, lineHeight: 19 }}>Update {props.machine ? "this machine" : "the hub and main machine"} to configure: {fields.filter((f) => f.group === group() && !reported(f)).map((f) => f.label).join(", ")}. Other available settings can still be edited.</Text></If>
      <If when={props.machine && group() === "onboarding" && !learningSupported()}><Text testID="machine-learning-unsupported" style={{ color: colors.warn, fontSize: 13 }}>Update this machine and let it sync once before editing its learning history locations.</Text></If>
      <If when={props.machine && group() === "resources" && !diskPathSupported()}><Text testID="machine-disk-path-unsupported" style={{ color: colors.warn, fontSize: 13 }}>Update this machine and let it sync once before changing its disk monitoring location. Other resource controls remain available.</Text></If>
      <Each of={visible()} key={(f) => f.path}>
        {(field) => <View style={{ gap: 6 }}>
          <If when={field().kind === "boolean"} else={field().kind === "providers" ?
            <View style={{ gap: 10 }}>
              <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>{field().label}</Text>
              <Each of={field().options ?? []} key={(key) => key}>{(key) => <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Toggle testID={`${id(field().path)}-${key()}`} label={providerLabel(key())} value={Array.isArray(values()[field().path]) && (values()[field().path] as string[]).includes(key())}
                  onChange={(on) => { const list = Array.isArray(values()[field().path]) ? values()[field().path] as string[] : []; set(field().path, on ? [...list, key()] : list.filter((value) => value !== key())); }} />
                <Text style={{ color: colors.text }}>{providerLabel(key())}</Text>
              </View>}</Each>
              <Text style={{ fontSize: 13, lineHeight: 18, color: colors.muted }}>{field().hint}</Text>
            </View>
            : field().kind === "choice" ?
            <><Dropdown testID={id(field().path)} label={field().label} value={optionLabel(field(), String(values()[field().path] ?? ""))} selected={String(values()[field().path] ?? "")}
              onPick={(v) => set(field().path, v)} options={(field().options ?? []).map((key) => ({ id: key, label: field().path === "autonomy.level" ? autonomyLabel(key) : optionLabel(field(), key), testID: `${id(field().path)}-${key}` }))} />
              <Text style={{ fontSize: 13, lineHeight: 18, color: colors.muted }}>{field().hint}</Text></>
            : (field().kind === "folders" || field().kind === "names" || field().kind === "patterns") ?
              <TextArea testID={id(field().path)} label={field().label} value={Array.isArray(values()[field().path]) ? (values()[field().path] as string[]).join("\n") : String(values()[field().path] ?? "")} height={90} onChange={(v) => set(field().path, v)} hint={field().hint} />
            : <Field testID={id(field().path)} label={field().label} value={String(values()[field().path] ?? "")} onChange={(v) => set(field().path, v)}
                keyboardType={field().kind === "number" && field().integer ? "number-pad" : undefined} hint={field().hint} />
          }>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Toggle testID={id(field().path)} label={field().label} value={values()[field().path] !== false} onChange={(v) => set(field().path, v)} />
              <View style={{ flex: 1, gap: 3 }}><Text style={{ fontSize: 14.5, color: colors.text }}>{field().label}</Text><Text style={{ fontSize: 13, lineHeight: 18, color: colors.muted }}>{field().hint}</Text></View>
            </View>
          </If>
        </View>}
      </Each>
      <If when={group() === "onboarding" && health().length > 0}>
        <View testID="provider-health" style={{ gap: 6 }}>
          <Text role="header" style={{ color: colors.text, fontWeight: "600" }}>Tool launch checks on the main machine</Text>
          <Each of={health()} key={(provider) => provider.id}>{(provider) => <Text testID={`provider-health-${provider().id}`} style={{ color: provider().available ? colors.muted : colors.warn, fontSize: 13, lineHeight: 18 }}>
            {`${provider().label}${provider().host ? ` · ${provider().host}` : ""}: ${provider().available ? "CLI available; sign-in is checked when used" : provider().reason ?? "Unavailable"}`}
          </Text>}</Each>
        </View>
      </If>
      <If when={group() === "onboarding" && !props.machine}><RoleLibrary hub={props.hub} disabled={busy() || Object.keys(changes()).length > 0} onAdded={() => void load()} /></If>
      <If when={group() === "onboarding" && !props.machine && learning()}>
        <MachineLearning hub={props.hub} host={learning()!.host} disabled={busy() || Object.keys(changes()).length > 0} refreshToken={baseline()} onTask={props.onTask} />
      </If>
      <Text testID="configuration-dirty" style={{ fontSize: 13, color: colors.muted }}>{Object.keys(changes()).length ? `${Object.keys(changes()).length} unsaved changes` : "All changes saved"}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <Btn testID="configuration-save" label="Save settings" kind="primary" busy={busy()} disabled={busy() || !Object.keys(changes()).length} onPress={() => void save()} />
        <Btn testID="configuration-reload-saved" label={Object.keys(changes()).length ? "Discard edits and reload" : "Reload settings"} kind="ghost" disabled={busy()} onPress={() => void load()} />
        <Btn testID="configuration-reset" label={props.machine ? "Reset this section to defaults" : "Reset this section's overrides"} kind="ghost" disabled={busy() || !fields.some((f) => supported(f) && f.group === group() && overrides().includes(f.path))}
          onPress={() => void save(fields.filter((f) => supported(f) && f.group === group()).map((f) => f.path))} />
      </View>
    </If>
    <If when={note()}><Text testID="configuration-note" style={{ fontSize: 13.5, lineHeight: 20, color: failed() ? colors.danger : colors.up }}>{note()}</Text></If>
  </View>;
}

/** The sections of the wide settings page, in its sidebar's order. */
const SETTINGS_TABS = [
  ["notify", "Notifications", "bell"],
  ["members", "Members", "chat"],
  ["projects", "Projects", "lists"],
  ["routines", "Routines", "play"],
  ["archive", "Archive", "lists"],
  ["saved", "Saved requests", "lists"],
  ["parallel", "Parallel", "layers"],
  ["onboarding", "AI tools & onboarding", "sliders"],
  ["configuration", "Team configuration", "sliders"],
  ["commands", "Commands", "terminal"],
  ["storage", "Storage", "photos"],
  ["version", "Version", "github"],
  ["rules", "Rules and memory", "scroll"],
  ["account", "Account", "lock"],
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number][0];

const ARCHIVE_LABELS: Record<ArchiveKind, string> = { routines: "Routine", members: "Member", projects: "Project", plans: "Plan" };

function savedRequestLabel(entry: PendingEntry) {
  if (entry.kind === "task") return `${"id" in entry.request ? `Reopen ${entry.request.id}` : "New task"} · ${entry.request.settings.title}`;
  if (entry.kind === "archive") return `Restore ${ARCHIVE_LABELS[entry.preview.entry.kind].toLowerCase()} · ${entry.preview.entry.name}`;
  if (entry.kind === "learning") return `Learning on ${entry.key} · ${entry.preview.turns} owner turns`;
  return `${entry.request.action === "include" ? "Include" : "Exclude"} ${entry.request.target_id} · cleanup for ${entry.request.owner.id}`;
}

/** Recovered requests are passive until the owner explicitly checks or retries the original authorization. */
function SavedRequests(props: { hub: Hub; settings: Settings; isCurrent?: () => boolean; onTask: (id: string) => void; onOwner: (owner: StopOwner) => void; onArchive: (kind: ArchiveKind, id: string) => void }) {
  const selected = signal<PendingEntry | undefined>(undefined), busy = signal(false), note = signal(""), good = signal(false), knownId = signal("");
  let generation = 0, disposed = false;
  cleanup(() => { disposed = true; generation++; });
  const active = () => { const entry = selected(); return entry && props.hub.savedEntries().some((e) => e.kind === entry.kind && e.key === entry.key && e.request.request_id === entry.request.request_id); };
  const currentEntry = () => { const entry = selected(); return entry && (props.hub.savedEntries().find((e) => e.kind === entry.kind && e.key === entry.key && e.request.request_id === entry.request.request_id) ?? entry); };
  const currentId = () => { const entry = currentEntry(); return knownId() || (entry?.kind === "task" || entry?.kind === "learning" ? entry.known_id ?? "" : ""); };
  const select = (entry: PendingEntry) => {
    if (busy()) return;
    selected.set(entry); note.set(""); good.set(false);
    knownId.set(entry.kind === "archive" ? entry.preview.entry.id : entry.kind === "stop" ? entry.request.owner.id : "id" in entry.request ? entry.request.id : entry.known_id ?? "");
  };
  function release(entry: PendingEntry, receipt?: TaskFormResult) {
    if (entry.kind === "task") {
      const state = props.hub.taskForms().get(entry.key);
      if (state?.pending()?.request_id === entry.request.request_id) {
        clearTaskRequest(state, entry.key);
        if (receipt) { state.result.set(receipt); state.knownId.set(receipt.id); }
      }
    } else if (entry.kind === "archive") props.hub.archiveRestores.update((all) => { const next = new Map(all); if (next.get(entry.key)?.request.request_id === entry.request.request_id) next.delete(entry.key); return next; });
    else if (entry.kind === "stop") props.hub.stopReviews.update((all) => { const next = new Map(all); if (next.get(entry.key)?.intent.request_id === entry.request.request_id) next.delete(entry.key); return next; });
  }
  async function perform(retry = false, discard = false) {
    const entry = currentEntry(); if (!entry || disposed || !active() || busy()) return;
    const started = generation;
    if (entry.kind === "stop") {
      const answer = await AlertDialog.show({ title: "Retry the same cleanup decision?", description: "This keeps your original target, decision and reason. If the decision was not saved, it may be applied now. It does not choose a newer run.", actions: [{ id: "back", label: "Back", role: "cancel" }, { id: "retry", label: "Retry same decision" }] });
      if (answer.action !== "retry" || disposed || started !== generation || props.isCurrent?.() === false) return;
    }
    if (entry.kind === "learning" && (retry || discard)) {
      const answer = await AlertDialog.show({ title: discard ? "Release the uncertain collection?" : "Retry the same learning run?",
        description: discard ? "This leaves tasks and current learning progress unchanged. A fresh preview may include the same history. It releases only this exact uncertain collection; it does not cancel a task."
          : "If the original run was not applied, this may collect the same reviewed history and queue its learning task on the saved machine. It keeps the original request and preview; it does not select newer history.",
        actions: [{ id: "back", label: "Back", role: "cancel" }, { id: "continue", label: discard ? "Release collection" : "Retry same run" }] });
      if (answer.action !== "continue" || disposed || started !== generation || props.isCurrent?.() === false || busy() || !active() || selected()?.request.request_id !== entry.request.request_id) return;
    }
    busy.set(true); note.set(""); good.set(false);
    try {
      if (!await props.hub.keepPending(entry)) { note.set(props.hub.savedError() || "Reload saved requests before continuing."); return; }
      if (disposed || started !== generation || props.isCurrent?.() === false) return;
      let body: unknown = { ...entry.request, ...(!retry && !discard && entry.kind !== "stop" ? { confirm_only: true } : {}) };
      if (retry && entry.kind === "archive" && entry.request.project) {
        const { host, path } = entry.request.project;
        const check = await props.hub.api("POST", `/api/machines/${encodeURIComponent(host)}/project-folder-check`, { path });
        const value = check.data;
        if (!check.ok || value.host !== host || value.requested_path !== path || typeof value.path !== "string" || !value.path || typeof value.repo !== "string" || !Array.isArray(value.requires)
          || value.requires.some((cap) => typeof cap !== "string") || typeof value.checked !== "string" || !Number.isFinite(Date.parse(value.checked)) || value.probe_ticket !== undefined && !validRunId(value.probe_ticket)) {
          note.set(String(value.error ?? "The saved machine did not confirm its folder. Reconnect it before retrying this restoration.")); return;
        }
        body = { ...entry.request, project: { host, path, ...(value.probe_ticket ? { probe_ticket: value.probe_ticket } : {}) } };
      }
      const path = entry.kind === "task" ? "id" in entry.request ? "/api/tasks/reopen" : "/api/tasks/create" : entry.kind === "archive" ? "/api/archive/restore" : "/api/stops/resolve";
      const r = entry.kind === "learning" ? await props.hub.learningRun(entry.key, body as LearningRunRequest, discard) : await props.hub.api("POST", path, body);
      if (disposed || started !== generation || !active()) return;
      const receipt = entry.kind === "archive" ? readArchiveRestoreResult(r.data) : entry.kind === "task" ? readTaskFormResult(r.data) : undefined;
      const learned = entry.kind === "learning" ? learningReceipt(r.data, entry.key, entry.request, entry.preview, entry.known_id) : undefined;
      const discarded = entry.kind === "learning" ? learningRelease(r.data, entry.key, entry.request, entry.known_id) : undefined;
      if (r.ok && (entry.kind === "archive" ? !receipt || receipt.id !== entry.preview.entry.id || (receipt as ArchiveRestoreResult).kind !== entry.preview.entry.kind
        : entry.kind === "task" ? !receipt || !!entry.known_id && receipt.id !== entry.known_id : entry.kind === "learning" ? !learned && !discarded : false)) { note.set("Could not verify this saved request's result. Its original authorization is kept for another check."); return; }
      if (entry.kind === "learning") {
        const id = learned?.id ?? discarded?.id ?? learningTaskId(r.data, entry.key, entry.request, entry.known_id);
        if (id) { knownId.set(id); if (!await props.hub.keepPending({ ...entry, known_id: id })) { note.set(props.hub.savedError()); return; } }
      }
      if (entry.kind === "task" && r.data.request_id === entry.request.request_id && r.data.action === ("id" in entry.request ? "reopen" : "create") && typeof r.data.id === "string" && /^T-[\w-]*\d{4}$/.test(r.data.id)
        && (!("id" in entry.request) || r.data.id === entry.request.id) && (!currentId() || r.data.id === currentId())) {
        knownId.set(r.data.id);
        if (!r.ok) await props.hub.keepPending({ ...entry, known_id: r.data.id });
      }
      if (!r.ok) { note.set(String(r.data.error ?? "This saved request is still unconfirmed. Inspect its current record before authorizing another request.")); return; }
      if (!await props.hub.dropPending(entry.kind, entry.key, entry.request.request_id)) { note.set("The earlier action is confirmed, but its local recovery copy could not be cleared. Reload saved requests and check it again."); return; }
      release(entry, entry.kind === "task" ? readTaskFormResult(r.data) : undefined); good.set(true);
      note.set(entry.kind === "stop" ? "Earlier cleanup decision confirmed. This does not prove that the task was stopped." : discarded ? "Earlier collection release confirmed. Tasks and learning progress were left unchanged." : "Earlier request confirmed. Open the record to check its current state.");
      void props.hub.refreshStatus();
    } finally { busy.set(false); }
  }
  async function forget() {
    const entry = selected(); if (!entry || disposed || !active() || busy()) return;
    const started = generation;
    const answer = await AlertDialog.show({ title: "Forget this saved request?", description: "This removes only its recovery copy from this sign-in on this device. The earlier action may still finish. No task, restoration, cleanup decision or learning progress is undone.", actions: [{ id: "keep", label: "Keep saved request", role: "cancel" }, { id: "forget", label: "Forget saved request", role: "destructive" }] });
    if (answer.action !== "forget" || disposed || started !== generation || props.isCurrent?.() === false || busy() || selected()?.request.request_id !== entry.request.request_id) return;
    busy.set(true);
    if (await props.hub.dropPending(entry.kind, entry.key, entry.request.request_id)) { release(entry); selected.set(undefined); note.set(""); }
    else { good.set(false); note.set(props.hub.savedError()); }
    busy.set(false);
  }
  async function reset() {
    if (busy() || props.hub.savedLoading()) return;
    const answer = await AlertDialog.show({ title: "Reset local saved requests?", description: "Unconfirmed actions may already have happened or may still finish. Inspect current records first. This clears this sign-in's local recovery copies, including unreadable copies, and does not cancel or undo server work.", actions: [{ id: "keep", label: "Keep recovery copies", role: "cancel" }, { id: "reset", label: "Reset local copies", role: "destructive" }] });
    if (answer.action === "reset" && await props.hub.resetSaved()) { selected.set(undefined); note.set(""); }
  }
  async function inspect() {
    const entry = selected(), id = currentId(); if (!entry || !id || busy()) return;
    if (entry.kind === "stop") { props.onOwner(entry.request.owner); return; }
    const task = entry.kind === "task" || entry.kind === "learning";
    const path = task ? `/api/tasks/get?id=${encodeURIComponent(id)}` : `/api/${entry.preview.entry.kind}/${encodeURIComponent(id)}`;
    const mine = ++generation;
    busy.set(true); const r = await props.hub.api("GET", path);
    busy.set(false);
    if (mine !== generation || props.isCurrent?.() === false || selected()?.request.request_id !== entry.request.request_id) return;
    const found = task ? r.data.id : entry.preview.entry.kind === "routines" ? r.data.name : entry.preview.entry.kind === "plans" ? (r.data.plan as PlanInfo | undefined)?.id : r.data.id;
    if (!r.ok || found !== id) { good.set(false); note.set(String(r.data.error ?? "This record is not currently available. A confirmed receipt remains historical.")); return; }
    if (task) props.onTask(id);
    else if (entry.preview.entry.kind === "projects") props.settings.openProject(r.data as unknown as Project);
    else props.onArchive(entry.preview.entry.kind, id);
  }
  return <View testID="saved-requests-page" style={{ gap: 14 }}>
    <Text role="header" style={{ fontSize: 20, fontWeight: "600", color: colors.text }}>Saved requests</Text>
    <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 20 }}>These requests keep their original authorization after an app restart. Nothing is automatically retried. Checking an earlier result does not create another task or restore a deleted record.</Text>
    <If when={props.hub.savedError()}><View style={{ gap: 10 }}><Text testID="saved-requests-error" style={{ color: colors.danger, fontSize: 14, lineHeight: 20 }}>{props.hub.savedError()}</Text><Btn testID="saved-requests-reset" label="Reset local recovery copies…" kind="ghost" disabled={busy() || props.hub.savedLoading()} onPress={() => void reset()} /></View></If>
    <Btn testID="saved-requests-reload" label={props.hub.savedLoading() ? "Loading…" : "Reload saved requests"} kind="ghost" disabled={busy() || props.hub.savedLoading()} onPress={() => void props.hub.reloadSaved()} />
    <Group title={props.hub.savedError() ? "Saved requests need review" : `${props.hub.savedEntries().length} unconfirmed requests`}>
      <Each of={props.hub.savedEntries()} key={(entry) => `${entry.kind}:${entry.key}:${entry.request.request_id}`}>{(entry, i) => <SetRow first={i() === 0} testID={`saved-request-${entry().request.request_id}`} label={savedRequestLabel(entry())} detail={entry().at} chevron onPress={() => select(entry())} />}</Each>
      <If when={!props.hub.savedEntries().length}><SetRow first label={props.hub.savedError() ? "Recovery copies could not be loaded" : "No unconfirmed requests"} /></If>
    </Group>
    <If when={selected()}>{(entry) => <View testID="saved-request-detail" style={{ gap: 12, padding: 16, borderRadius: radius.inset, backgroundColor: colors.surface }}>
      <Text role="header" style={{ fontSize: 17, fontWeight: "600", color: colors.text }}>{savedRequestLabel(entry())}</Text>
      <If when={entry().kind === "task"}>{() => { const task = entry() as Extract<PendingEntry, { kind: "task" }>; return <>
        <Text style={{ color: colors.text, fontSize: 14, lineHeight: 20, userSelect: "text" }}>{task.request.instructions}</Text>
        <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 19 }}>{`Member: ${task.request.settings.agent} · AI tool: ${task.request.settings.cli}\nMachine: ${task.request.settings.host} · Required: ${task.request.settings.requires || "None"}\nProject: ${task.request.settings.project || "None"} · Priority: ${task.request.settings.priority}\nPreferred: ${task.request.settings.prefer || "None"} · Resource use: ${task.request.settings.weight}${task.request.settings.project_guard ? `\nProject folder: ${task.request.settings.project_guard.path}\nProject requirements: ${task.request.settings.project_guard.requires.join(", ") || "None"}` : task.preview?.repo && task.request.settings.project === "__current__" ? `\nSaved folder: ${task.preview.repo}` : ""}`}</Text>
        <If when={task.preview?.learning_host || task.preview?.learning_host_error}><Text style={{ color: colors.warn, fontSize: 13, lineHeight: 19 }}>{task.preview?.learning_host ? `Learning source: ${task.preview.learning_host}. Its private history stays on that machine.` : `Learning source cannot be verified: ${task.preview?.learning_host_error}`}</Text></If>
      </>; }}</If>
      <If when={entry().kind === "archive"}>{() => { const archive = entry() as Extract<PendingEntry, { kind: "archive" }>, value = archive.preview; return <>
        <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 20 }}>{`Original ID: ${value.entry.id}${archive.request.project ? `\nMachine: ${archive.request.project.host}\nFolder: ${archive.request.project.path}` : ""}`}</Text>
        <Text style={{ color: colors.text, fontSize: 14, lineHeight: 20, userSelect: "text" }}>{value.routine ? `${value.routine.every} · ${value.routine.agent || "Local learning"}\n${value.routine.prompt}\nRestores paused.` : value.member ? `${value.member.about}\n${value.member.instructions}\nIncludes ${value.entry.files} profile and memory files.` : value.project ? `Repository override: ${value.project.repo || "Automatic"}\nAdditional requirements: ${value.project.requires.join(", ") || "None"}\n${value.project.instructions}` : value.plan ? `${value.plan.goal}\n${value.plan.status} · ${value.plan.steps} steps · ${value.plan.agent}\nRestores history only; no work starts.` : ""}</Text>
        <Each of={value.warnings}>{(warning) => <Text style={{ color: colors.warn, fontSize: 13, lineHeight: 19 }}>{warning()}</Text>}</Each>
      </>; }}</If>
      <If when={entry().kind === "stop"}>{() => { const stop = entry() as Extract<PendingEntry, { kind: "stop" }>; return <><Text style={{ color: colors.text, fontSize: 14, lineHeight: 20 }}>{stop.request.reason}</Text>
        <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 19, userSelect: "text" }}>{stop.preview ? stop.preview.current.records.map((record) => [record.title, record.state, record.host, record.run_id ? `Run ${record.run_id}` : ""].filter(Boolean).join(" · ")).join("\n") : "The original run details are unavailable in this copy. The server verifies the saved review before applying it."}</Text>
        <Text style={{ color: colors.warn, fontSize: 13, lineHeight: 19 }}>Retrying may apply this earlier decision if it was not saved. It does not select a newer run. An already-dispatched stop cannot be recalled.</Text></>; }}</If>
      <If when={entry().kind === "learning"}>{() => { const learning = entry() as Extract<PendingEntry, { kind: "learning" }>; return <>
        <Text style={{ color: colors.text, fontSize: 14, lineHeight: 20 }}>{`${learning.key} · ${learning.preview.turns} owner turns · ${learning.preview.sessions} provider sessions\nSelected sources: ${learning.preview.sources.map(providerLabel).join(", ") || "None"}`}</Text>
        <Text style={{ color: colors.warn, fontSize: 13, lineHeight: 19 }}>{learning.preview.truncated ? "The prepared digest exceeded its limit; earlier collected content was omitted. Counts describe the full prepared collection." : "No digest truncation reported."} Checking the saved run does not read history or queue a task.</Text>
      </>; }}</If>
      <If when={active()}>
        <If when={entry().kind !== "stop"}><Btn testID="saved-request-check" label={entry().kind === "learning" ? "Check saved run" : "Check earlier result"} kind="primary" busy={busy()} disabled={busy() || props.hub.savedLoading() || !!props.hub.savedError()} onPress={() => void perform()} /></If>
        <Btn testID="saved-request-retry" label={entry().kind === "stop" ? "Retry same decision…" : entry().kind === "learning" ? "Retry same learning run…" : entry().kind === "archive" && (entry() as Extract<PendingEntry, { kind: "archive" }>).request.project ? "Check folder and retry same restore" : "Retry same request"} disabled={busy() || props.hub.savedLoading() || !!props.hub.savedError()} onPress={() => void perform(true)} />
        <If when={entry().kind === "learning"}><Btn testID="saved-request-release" label="Release uncertain collection…" disabled={busy() || props.hub.savedLoading() || !!props.hub.savedError()} onPress={() => void perform(false, true)} /></If>
        <Btn testID="saved-request-forget" label="Forget local copy…" kind="ghost" disabled={busy() || props.hub.savedLoading()} onPress={() => void forget()} />
      </If>
      <If when={currentId()}><Btn testID="saved-request-inspect" label="Inspect current record" kind="secondary" disabled={busy()} onPress={() => void inspect()} /></If>
    </View>}</If>
    <If when={note()}><Text testID="saved-requests-note" style={{ color: good() ? colors.up : colors.danger, fontSize: 14, lineHeight: 20 }}>{note()}</Text></If>
    <ProjectEditor settings={props.settings} />
  </View>;
}

/** Archives are previewed on the main machine; a restore never replaces an existing record. */
function ArchiveBrowser(props: { hub: Hub; settings: Settings; isCurrent?: () => boolean; onOpen: (kind: ArchiveKind, id: string) => void }) {
  const items = signal<ArchiveItem[]>([]), total = signal(0), nextOffset = signal(0), filter = signal<ArchiveKind | "">(""), query = signal("");
  const listBusy = signal(false), error = signal(""), warnings = signal<string[]>([]);
  const opened = signal(false), key = signal(""), loaded = signal<ArchivePreview | undefined>(undefined), result = signal<ArchiveRestoreResult | undefined>(undefined);
  const busy = signal(false), note = signal(""), noteOk = signal(false), stale = signal(false);
  const host = signal(""), path = signal(""), checking = signal(false);
  const checked = signal<(ProjectFolderCheck & { probe_ticket?: string; received: number }) | undefined>(undefined);
  const pending = () => props.hub.archiveRestores().get(key());
  const preview = () => pending()?.preview ?? loaded();
  let listGeneration = 0, previewGeneration = 0, probeGeneration = 0, appliedFilter = "";
  cleanup(() => { listGeneration++; previewGeneration++; probeGeneration++; });
  const invalidateFolder = () => { probeGeneration++; checked.set(undefined); checking.set(false); };
  const probe = () => {
    const value = checked();
    return value && value.host === host() && value.requested_path === path().trim() && Date.now() - value.received < 300_000 ? value : undefined;
  };
  async function load(reset = true) {
    const generation = ++listGeneration, kind = filter(), search = query().trim(), selectedFilter = JSON.stringify([kind, search]);
    const offset = reset || selectedFilter !== appliedFilter ? 0 : nextOffset();
    listBusy.set(true); error.set("");
    const r = await props.hub.api("POST", "/api/archive", { ...(kind ? { kind } : {}), query: search, offset, limit: 25 });
    if (generation !== listGeneration) return;
    listBusy.set(false);
    const list = readArchiveList(r.data);
    if (!r.ok || !list || list.offset !== offset || list.limit !== 25 || !list.items.length && offset < list.total || kind && list.items.some((item) => item.kind !== kind)) {
      error.set(r.status === 404 ? "Update the hub and main machine to browse and restore archives." : String(r.data.error ?? "Couldn't load the archive. Your saved records are unchanged.")); return;
    }
    appliedFilter = selectedFilter;
    items.set(offset === 0 ? list.items : [...items(), ...list.items.filter((item) => !items().some((old) => old.key === item.key))]); nextOffset.set(offset + list.items.length); total.set(list.total); warnings.set(list.warnings);
  }
  async function choose(selected: string, keepDraft = false) {
    if (busy()) return;
    const generation = ++previewGeneration;
    key.set(selected); opened.set(true); loaded.set(undefined); result.set(undefined); note.set(""); noteOk.set(false); stale.set(false); invalidateFolder();
    const saved = pending();
    if (saved) { host.set(saved.request.project?.host ?? ""); path.set(saved.request.project?.path ?? ""); note.set("An earlier restoration still needs confirmation. Check the saved restore before starting another request."); return; }
    busy.set(true);
    const selectedItem = items().find((item) => item.key === selected);
    const r = await props.hub.api("POST", "/api/archive/preview", { key: selected });
    if (generation !== previewGeneration || key() !== selected) return;
    busy.set(false);
    const value = readArchivePreview(r.data);
    if (r.ok && value?.entry.key === selected && (!selectedItem || value.entry.kind === selectedItem.kind && value.entry.id === selectedItem.id)) {
      loaded.set(value);
      if (!keepDraft) { host.set(value.project?.host ?? ""); path.set(value.project?.path ?? ""); }
    } else note.set(r.status === 404 ? "This archive is unavailable, or the main machine needs an update. Refresh the list." : String(r.data.error ?? "Couldn't preview this archive."));
  }
  const close = () => { if (!busy() && !checking()) { previewGeneration++; opened.set(false); } };
  async function refreshPreview() {
    if (busy() || checking()) return;
    const saved = pending();
    if (saved) {
      const answer = await AlertDialog.show({ title: "Start a fresh archive preview?", description: "The earlier restore may still finish. Existing records will be kept. Check the saved restore first if you want to confirm its result.", actions: [{ id: "keep", label: "Keep pending restore", role: "cancel" }, { id: "refresh", label: "Refresh preview" }] });
      if (answer.action !== "refresh") return;
      if (!await props.hub.dropPending("archive", key(), saved.request.request_id)) { noteOk.set(false); note.set(props.hub.savedError()); return; }
      props.hub.archiveRestores.update((all) => { const next = new Map(all); if (next.get(key())?.request.request_id === saved.request.request_id) next.delete(key()); return next; });
    }
    await choose(key(), true);
  }
  async function checkFolder() {
    const selected = key(), generation = ++probeGeneration, target = host(), folder = path().trim();
    if (!target || !folder || busy()) return false;
    checking.set(true); checked.set(undefined); note.set(""); noteOk.set(false);
    const r = await props.hub.api("POST", `/api/machines/${encodeURIComponent(target)}/project-folder-check`, { path: folder });
    if (generation !== probeGeneration || key() !== selected || host() !== target || path().trim() !== folder) return false;
    checking.set(false);
    const value = r.data;
    if (!r.ok || value.host !== target || value.requested_path !== folder || typeof value.path !== "string" || !value.path || typeof value.repo !== "string" || !Array.isArray(value.requires) || value.requires.some((cap) => typeof cap !== "string")
      || typeof value.checked !== "string" || !Number.isFinite(Date.parse(value.checked)) || target !== props.settings.view()?.effective.primary_host && !validRunId(value.probe_ticket)) {
      note.set(String(value.error ?? "The selected machine did not confirm this folder. Reconnect it and check again.")); return false;
    }
    checked.set({ ...(value as ProjectFolderCheck & { probe_ticket?: string }), received: Date.now() }); return true;
  }
  async function send(request: ArchiveRestoreRequest, value: ArchivePreview) {
    if (busy() || checking()) return;
    const existing = props.hub.archiveRestores().get(request.key);
    if (existing && existing.request.request_id !== request.request_id) { note.set("Confirm the pending restoration before starting another request."); return; }
    busy.set(true); note.set(""); noteOk.set(false);
    try {
      if (!await props.hub.keepPending({ kind: "archive", key: request.key, at: props.hub.savedAt("archive", request.key), request, preview: value })) { note.set(props.hub.savedError() || "Wait for saved requests to finish loading before submitting."); return; }
      props.hub.archiveRestores.update((all) => new Map(all).set(request.key, { request: { ...request, confirm_only: undefined }, preview: value }));
      const r = await props.hub.api("POST", "/api/archive/restore", request);
      const latest = props.hub.archiveRestores().get(request.key);
      if (latest?.request.request_id !== request.request_id || key() !== request.key) return;
      const restored = readArchiveRestoreResult(r.data), valid = restored?.key === request.key && restored.digest === request.digest && restored.request_id === request.request_id && restored.id === value.entry.id && restored.kind === value.entry.kind;
      if (r.ok && valid) {
        result.set(restored); loaded.set(value);
        if (!await props.hub.dropPending("archive", request.key, request.request_id)) { note.set("Restoration confirmed, but its local recovery copy could not be cleared. Reload saved requests and check it again."); return; }
        props.hub.archiveRestores.update((all) => { const next = new Map(all); if (next.get(request.key)?.request.request_id === request.request_id) next.delete(request.key); return next; });
        note.set(restored.replayed ? "Earlier restoration confirmed. Open the record to check its current state." : "Restoration confirmed.");
        noteOk.set(true);
        props.settings.load(); void props.hub.refreshStatus(); return;
      }
      if (r.data.saved_locally && valid) result.set(restored);
      note.set(String(r.data.error ?? "Couldn't confirm this restoration. Check the saved restore before trying again."));
      if (!(r.status === 0 || r.status === 202 || r.status >= 500 || r.data.saved_locally || r.data.pending || r.data.uncertain) && !request.confirm_only) {
        if (!await props.hub.dropPending("archive", request.key, request.request_id)) { note.set(`${note()} The saved request is kept until local storage recovers.`); return; }
        props.hub.archiveRestores.update((all) => { const next = new Map(all); if (next.get(request.key)?.request.request_id === request.request_id) next.delete(request.key); return next; });
        stale.set(true); invalidateFolder();
      }
    } finally { busy.set(false); }
  }
  async function restore() {
    const value = preview();
    if (!value || !value.can_restore || pending() || busy() || checking() || stale() || result()) return;
    if (value.entry.kind === "projects" && !probe() && !await checkFolder()) return;
    const request: ArchiveRestoreRequest = { key: value.entry.key, digest: value.digest, request_id: crypto.randomUUID(), ...(value.project ? { project: { host: host(), path: path().trim(), ...(probe()?.probe_ticket ? { probe_ticket: probe()!.probe_ticket } : {}) } } : {}) };
    await send(request, value);
  }
  async function openRestored() {
    const saved = result() ?? preview()?.entry; if (!saved) return;
    const selected = key(), mine = ++previewGeneration;
    busy.set(true);
    const r = await props.hub.api("GET", `/api/${saved.kind}/${encodeURIComponent(saved.id)}`);
    if (mine !== previewGeneration || key() !== selected || props.isCurrent?.() === false) { busy.set(false); return; }
    busy.set(false);
    const identity = saved.kind === "routines" ? r.data.name : saved.kind === "plans" ? (r.data.plan as PlanInfo | undefined)?.id : r.data.id;
    if (!r.ok || identity !== saved.id) { noteOk.set(false); note.set(String(r.data.error ?? "This record is not currently available. Its earlier restore may still need confirmation.")); return; }
    close();
    if (saved.kind === "projects") props.settings.openProject(r.data as unknown as Project);
    else props.onOpen(saved.kind, saved.id);
  }
  void load();
  return <View testID="archive-page" style={{ gap: 14 }}>
    <Text role="header" style={{ fontSize: 19, fontWeight: "600", color: colors.text }}>Archive</Text>
    <Text style={{ fontSize: 14, lineHeight: 20, color: colors.muted }}>Preview deleted routines, members, projects and plans before restoring them. Routines return paused; plans return as history.</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Dropdown testID="archive-kind" label="Type" value={filter() ? `${ARCHIVE_LABELS[filter() as ArchiveKind]}s` : "All types"} selected={filter()} onPick={(v) => { filter.set(v as ArchiveKind | ""); void load(); }} options={[{ id: "", label: "All types", testID: "archive-kind-all" }, ...ARCHIVE_KINDS.map((kind) => ({ id: kind, label: `${ARCHIVE_LABELS[kind]}s`, testID: `archive-kind-${kind}` }))]} />
      <Btn testID="archive-refresh" label="Refresh archive" kind="ghost" disabled={listBusy()} onPress={() => void load()} />
    </View>
    <Field testID="archive-search" label="Search archive" value={query()} onChange={(v) => query.set(v)} hint="Search names and original IDs." />
    <Btn testID="archive-search-submit" label="Search" disabled={listBusy() || query().length > 200} onPress={() => void load()} />
    <If when={error()}><Text testID="archive-error" style={{ fontSize: 13, color: colors.danger }}>{error()}</Text></If>
    <Each of={warnings()} key={(warning) => warning}>{(warning) => <Text style={{ fontSize: 13, color: colors.warn }}>{warning()}</Text>}</Each>
    <Group title={error() || listBusy() && !items().length ? "Archived records" : `${total()} archived record${total() === 1 ? "" : "s"}`}>
      <Each of={items()} key={(item) => item.key}>{(item, i) => <SetRow testID={`archive-item-${item().key}`} first={i() === 0} label={item().name} detail={`${ARCHIVE_LABELS[item().kind]} · ${item().id} · ${item().archived_at}`} value={props.hub.archiveRestores().has(item().key) ? "Needs confirmation" : undefined} chevron onPress={() => void choose(item().key)} />}</Each>
      <If when={!items().length}><SetRow first label={listBusy() ? "Loading…" : error() ? "Archive unavailable" : "No archived records match"} /></If>
    </Group>
    <If when={nextOffset() < total()}><Btn testID="archive-more" label="Load more" disabled={listBusy()} busy={listBusy()} onPress={() => void load(false)} /></If>
    <Dialog testID="archive-preview" open={opened()} onOpenChange={({ open }) => { if (!open) close(); }} animation="fade" backdropClass="bg-scrim" style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "box-none" }}>
      <View style={{ width: "100%", maxWidth: 680, maxHeight: "100%", borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: "hidden" }}>
        <View style={{ flexDirection: "row", alignItems: "center", height: 56, paddingLeft: 20, paddingRight: 10, borderBottomWidth: .5, borderBottomColor: surfaceEdge() }}><Text style={{ flex: 1, fontSize: 17, fontWeight: "600", color: colors.text }}>Archived record</Text><Btn testID="archive-close" label="Close" kind="ghost" disabled={busy() || checking()} onPress={close} /></View>
        <Scroll style={{ flexShrink: 1 }}><View style={{ padding: 20, gap: 14 }}>
          <If when={preview()} else={<Text style={{ fontSize: 14, color: colors.muted }}>{busy() ? "Loading preview…" : "Refresh to load this archive."}</Text>}>
            {(value) => <>
              <Text testID="archive-name" style={{ fontSize: 18, fontWeight: "600", color: colors.text }}>{value().entry.name}</Text>
              <Text style={{ fontSize: 13, color: colors.faint }}>{`${ARCHIVE_LABELS[value().entry.kind]} · ${value().entry.id} · ${value().entry.archived_at}`}</Text>
              <Each of={[...value().conflicts, ...value().warnings]} key={(warning) => warning}>{(warning) => <Text testID="archive-warning" style={{ fontSize: 13, lineHeight: 19, color: colors.warn }}>{warning()}</Text>}</Each>
              <If when={value().routine}>{(r) => <><Text style={{ fontSize: 14, color: colors.muted }}>{`${r().every} · ${r().agent || "Local learning"}${r().project ? ` · ${r().project}` : ""}`}</Text><Text style={{ fontSize: 14, lineHeight: 20, color: colors.text, userSelect: "text" }}>{r().prompt}</Text><Text style={{ fontSize: 13, color: colors.warn }}>Restores paused. Enable it in Routines when you are ready.</Text></>}</If>
              <If when={value().member}>{(m) => <><Text style={{ fontSize: 14, color: colors.muted }}>{[m().name, m().title, m().about].filter(Boolean).join(" · ")}</Text><View selectable><Rich text={m().instructions} /></View><Text style={{ fontSize: 13, color: colors.muted }}>{`Includes ${value().entry.files} archived files, including the saved profile and memory.`}</Text></>}</If>
              <If when={value().plan}>{(p) => <><Text style={{ fontSize: 14, color: colors.muted }}>{`${p().status} · ${p().steps} steps · ${p().agent}${p().project ? ` · ${p().project}` : ""}`}</Text><Text style={{ fontSize: 14, lineHeight: 20, color: colors.text, userSelect: "text" }}>{p().goal}</Text><Text style={{ fontSize: 13, color: colors.muted }}>Restores history only. No work starts automatically.</Text></>}</If>
              <If when={value().project}>{(p) => <>
                <View disabled={!!pending() || busy() || !!result()} style={{ gap: 12 }}>
                  <Dropdown testID="archive-project-host" label="Machine" value={host()} selected={host()} onPick={(v) => { host.set(v); invalidateFolder(); }} options={[...new Set([host(), props.settings.view()?.effective.primary_host ?? "", ...props.settings.machines().map((m) => m.host)].filter(Boolean))].map((id) => ({ id, label: id, detail: props.settings.machines().find((m) => m.host === id)?.online === false ? "Offline" : id === props.settings.view()?.effective.primary_host ? "Main machine" : "Worker", testID: `archive-project-host-${id}` }))} />
                  <Field testID="archive-project-path" label="Folder" value={path()} onChange={(v) => { path.set(v); invalidateFolder(); }} hint="Choose a folder on this machine. A new check is required before restoration." />
                </View>
                <Btn testID="archive-project-check" label={`Check folder on ${host()}`} disabled={busy() || checking() || !!result() && !pending() || !host() || !path().trim()} busy={checking()} onPress={() => void checkFolder()} />
                <If when={probe()}><Text testID="archive-project-checked" style={{ fontSize: 13, lineHeight: 19, color: colors.muted }}>{`Confirmed folder: ${probe()!.path}\nDetected repo: ${probe()!.repo || "None"}\nDetected requirements: ${probe()!.requires.join(", ") || "None"}`}</Text></If>
                <Text style={{ fontSize: 13, lineHeight: 19, color: colors.muted }}>{`Saved repo override: ${p().repo || "Automatic"}\nAdditional requirements: ${p().requires.join(", ") || "None"}`}</Text>
                <View selectable><Rich text={p().instructions} /></View>
              </>}</If>
              <If when={!pending() && !result()}><Btn testID="archive-restore" label={value().entry.kind === "routines" ? "Restore paused" : "Restore"} kind="primary" disabled={!value().can_restore || busy() || checking() || stale()} busy={busy()} onPress={() => void restore()} /></If>
            </>}
          </If>
          <If when={pending()}>{(saved) => <View style={{ gap: 8 }}>
            <Btn testID="archive-confirm" label="Check saved restore" kind="primary" disabled={busy() || checking()} busy={busy()} onPress={() => void send({ ...saved().request, confirm_only: true, ...(saved().request.project ? { project: { host: saved().request.project!.host, path: saved().request.project!.path } } : {}) }, saved().preview)} />
            <Btn testID="archive-retry" label="Retry same restore" disabled={busy() || checking() || !!saved().request.project && !probe()} onPress={() => void send({ ...saved().request, ...(saved().request.project ? { project: { ...saved().request.project!, ...(probe()?.probe_ticket ? { probe_ticket: probe()!.probe_ticket } : {}) } } : {}) }, saved().preview)} />
          </View>}</If>
          <If when={note()}><Text testID="archive-note" style={{ fontSize: 13, lineHeight: 19, color: noteOk() ? colors.up : colors.danger }}>{note()}</Text></If>
          <Each of={result()?.warnings ?? []} key={(warning) => warning}>{(warning) => <Text style={{ fontSize: 13, lineHeight: 19, color: colors.warn }}>{warning()}</Text>}</Each>
          <If when={result() || pending() || preview()?.conflicts.length}><Btn testID="archive-open" label={result() && !pending() ? "Open restored record" : "Inspect current record"} kind="secondary" disabled={busy() || checking()} onPress={() => void openRestored()} /></If>
          <Btn testID="archive-preview-refresh" label="Refresh preview" kind="ghost" disabled={busy() || checking()} onPress={() => void refreshPreview()} />
        </View></Scroll>
      </View>
    </Dialog>
    <ProjectEditor settings={props.settings} />
  </View>;
}

/** The wide (desktop, tablet, wide browser) settings page. */
function TeamSettings(props: { hub: Hub; push: Push; settings: Settings; wide: boolean; isCurrent: () => boolean; onTask: (id: string) => void; onArchiveOpen: (kind: ArchiveKind, id: string) => void; onRules: () => void; onConnection: () => void; onDisconnect: () => void }) {
  const { view, error, saved, save } = props.settings;
  props.settings.load();
  const eff = () => view()?.effective;
  const row = (): ViewStyle => ({ gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 0.5, borderTopColor: surfaceEdge() });
  const chips: ViewStyle = { flexDirection: "row", flexWrap: "wrap", gap: 6 };

  const tab = props.settings.tab;
  const on = (k: SettingsTab) => tab() === k;
  return (
    <View style={{ flex: 1, flexDirection: "row" }}>
      <View testID="settings-nav" role="tablist" style={{ width: 208, gap: 2, paddingHorizontal: 10, paddingVertical: 20, borderRightWidth: 0.5, borderRightColor: surfaceEdge() }}>
        <Each of={[...SETTINGS_TABS]}>
          {(x) => (
            <View
              role="tab"
              testID={`settings-tab-${x()[0]}`}
              accessibilityLabel={x()[1]}
              accessibilityState={{ selected: on(x()[0]) }}
              onPress={() => tab.set(x()[0])}
              hoverStyle={on(x()[0]) ? undefined : hovered()}
              style={{ flexDirection: "row", alignItems: "center", gap: 10, height: 36, paddingHorizontal: 10, borderRadius: 8, backgroundColor: on(x()[0]) ? colors.raised : undefined }}
            >
              <Icon name={x()[2]} size={16} tint={on(x()[0]) ? colors.text : colors.muted} />
              <Text style={{ fontSize: 14.5, fontWeight: on(x()[0]) ? "600" : "400", color: on(x()[0]) ? colors.text : colors.muted }}>{x()[1]}</Text>
            </View>
          )}
        </Each>
      </View>
    <Scroll style={{ flex: 1 }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", gap: 28, paddingHorizontal: props.wide ? 32 : 16, paddingTop: props.wide ? 28 : 18, paddingBottom: 48 }}>
        <If when={error() || props.settings.saving() || saved()}>
          <Text testID="settings-note" style={{ alignSelf: "flex-end", fontSize: 13.5, color: error() ? colors.danger : colors.up }}>{error() || (props.settings.saving() ? "Saving…" : saved())}</Text>
        </If>
        <If when={on("notify")}>
          <NotifySettings push={props.push} view={view()} save={save} wide={props.wide} />
        </If>
        <If when={on("projects")}>
          <Group title="Projects" hint="The folders the team works in. In chat, name a project and the work happens in its folder, following your instructions for it.">
            <ProjectRows settings={props.settings} />
          </Group>
        </If>
        <If when={on("members") || on("routines") || on("parallel")}>
        <If when={eff()} else={<Text style={{ fontSize: 14, color: colors.faint }}>{error() ? "" : "Loading…"}</Text>}>
          {(e) => (
            <View style={{ gap: 28 }}>
              <If when={on("members")}>
              <Group title="Default task tool order" hint="Applies to new tasks on the machine claiming them. Explicit orders use the first usable tool; Automatic lets planning choose. Chat, judges and automatic repair keep their own tool choices.">
                <View style={{ padding: 16 }}><TaskToolPolicy settings={props.settings} /></View>
              </Group>
              <Group title="Members" hint="Each role on the team. Instructions say how they work; the model decides who does the work; autonomy decides how much needs your approval first.">
                <Each of={e().agents} key={(a) => a.id}>
                  {(a, i) => (
                    <View testID={`member-${a().id}`} style={{ gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: i() === 0 ? 0 : 0.5, borderTopColor: surfaceEdge() }}>
                      <View style={{ minWidth: 0, flexDirection: "row", alignItems: "center", gap: 12 }}>
                        <Avatar from={a().id} />
                        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                          <Text style={{ fontSize: 15.5, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{a().title ?? a().id}</Text>
                          <If when={a().about}>
                            <Text testID={`member-about-${a().id}`} style={{ fontSize: 13.5, lineHeight: 19, color: colors.muted, numberOfLines: 2 }}>{a().about}</Text>
                          </If>
                        </View>
                      </View>
                      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: 8 }}>
                        <TaskToolPolicy settings={props.settings} agent={a().id} />
                        <MemberAutonomyPolicy settings={props.settings} agent={a().id} />
                        <Btn label="Edit" kind="ghost" onPress={() => void props.settings.openMember(a().id)} testID={`member-edit-${a().id}`} />
                      </View>
                    </View>
                  )}
                </Each>
                <SetRow label="New member" tone="accent" leading={<Icon name="plus" size={16} tint={colors.info} />} onPress={() => void props.settings.openMember()} testID="member-new" />
              </Group>
              <MemberEditor settings={props.settings} />
              <RoleLibrary hub={props.hub} onAdded={props.settings.accept} disabled={props.settings.saving() > 0} />
              </If>

              <If when={on("routines")}>
              <Group title="Routines" hint="Rules that create tasks on a schedule: on/off and run times">
                <Each of={e().routines} key={(r) => r.name}>
                  {(r, i) => (
                    <View style={{ ...row(), flexDirection: "row", alignItems: "center", gap: 12, borderTopWidth: i() === 0 ? 0 : 0.5 }}>
                      <Toggle
                        testID={`routine-${r().name}`}
                        label={r().name}
                        value={r().enabled}
                        onChange={(on) => save(patches.routine(r().name, { enabled: on }))}
                      />
                      <View style={{ flex: 1, gap: 3 }}>
                        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                          <Text style={{ fontSize: 15.5, fontWeight: "500", color: r().enabled ? colors.text : colors.faint }}>{r().name}</Text>
                          <If when={r().agent}>
                            <Text style={{ fontSize: 12.5, color: colors.faint }}>{e().agents.find((a) => a.id === r().agent)?.title ?? r().agent}</Text>
                          </If>
                        </View>
                        <If when={r().desc}>
                          <Text testID={`routine-desc-${r().name}`} style={{ fontSize: 13, lineHeight: 18, color: colors.muted }}>{r().desc}</Text>
                        </If>
                      </View>
                      <Dropdown
                        testID={`every-${r().name}`}
                        label="Run"
                        value={everyLabel(r().every)}
                        options={intervalsWith(r().every).map((iv) => ({ id: iv, label: everyLabel(iv), testID: `every-${r().name}-${iv}` }))}
                        selected={r().every}
                        onPick={(iv) => save(patches.routine(r().name, { every: iv }))}
                      />
                      <Btn label="Edit" kind="ghost" onPress={() => void props.settings.openRoutine(r().name)} testID={`routine-edit-${r().name}`} />
                    </View>
                  )}
                </Each>
                <SetRow first={!e().routines.length} label="New routine" tone="accent" leading={<Icon name="plus" size={16} tint={colors.info} />} onPress={() => void props.settings.openRoutine()} testID="routine-new" />
              </Group>
              <RoutineEditor settings={props.settings} />
              </If>

              <If when={on("parallel")}>
              <Group title="Parallel" hint="Fleet default. A machine’s own run settings take precedence.">
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 14 }}>
                  <Text style={{ flex: 1, fontSize: 15.5, color: colors.text }}>Tasks each machine runs at once</Text>
                  <ParallelInput value={e().max_parallel ?? 2} onChange={(value) => save(patches.maxParallel(value))} />
                </View>
              </Group>
              </If>
            </View>
          )}
        </If>
        </If>
        <If when={on("onboarding")}><ConfigurationSettings hub={props.hub} initialGroup="onboarding" onTask={props.onTask} /></If>
        <If when={on("archive")}><ArchiveBrowser hub={props.hub} settings={props.settings} isCurrent={() => props.isCurrent() && on("archive")} onOpen={props.onArchiveOpen} /></If>
        <If when={on("saved")}><SavedRequests hub={props.hub} settings={props.settings} isCurrent={() => props.isCurrent() && on("saved")} onTask={taskLink} onOwner={(owner) => owner.kind === "plan" ? planLink(owner.id) : taskLink(owner.id)} onArchive={props.onArchiveOpen} /></If>
        <If when={on("configuration")}><ConfigurationSettings hub={props.hub} onTask={props.onTask} /></If>
        <If when={on("commands")}>
        <Group title="Commands" hint="Type / in the composer to use one. Built-in commands perform an action; the ones you add send a message to the team.">
          <CommandRows settings={props.settings} />
        </Group>
        </If>
        <If when={on("storage")}>
        <Group title="Image retention" hint={MEDIA_HINT}>
          <MediaDaysChoices settings={props.settings} />
        </Group>
        </If>
        <If when={on("version")}>
        <Group title="Version" hint="The code each machine runs. Updating makes every machine pull the latest code, and the main machine also redeploys online.">
          <VersionRows hub={props.hub} />
        </Group>
        </If>
        <If when={on("rules")}>
        <Group title="Memory" hint="The rules the team works by, your preferences, member profiles and decision precedents. Edit rules, preferences and member memory here.">
          <SetRow first label="View rules and memory" chevron onPress={props.onRules} testID="settings-rules" />
        </Group>
        </If>
        <If when={on("account")}>
        <Group title="Account" hint="Your sign-in is kept on this device and reconnects automatically next time.">
          <View style={{ flexDirection: props.wide ? "row" : "column", alignItems: props.wide ? "center" : "stretch", gap: 10, paddingHorizontal: 16, paddingVertical: 14 }}>
            <View style={{ flex: props.wide ? 1 : undefined, flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Dot tone={props.hub.conn() === "live" ? "on" : props.hub.conn() === "unauthorized" ? "bad" : "wait"} />
              <Text style={{ flex: 1, fontSize: 15, color: colors.text, numberOfLines: 1 }}>{props.hub.cfg.url}</Text>
            </View>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Btn label="Sign out" kind="danger" onPress={props.onDisconnect} testID="logout" />
            </View>
          </View>
        </Group>
        </If>
      </View>
    </Scroll>
    </View>
  );
}

// ---------------------------------------------------------------- settings on phones (iOS / Android Settings)

/** What the notification settings show and change, for both layouts. */
function notifyModel(push: Push, view: () => SettingsView | null, save: (patch: Record<string, unknown>) => unknown) {
  const tz = deviceTimeZone();
  const prefs = () => notifyPrefsOf(view(), tz);
  const setPrefs = (change: Partial<NotifyPrefs>) => save(notifyPatch({ ...prefs(), ...change }));
  const state = () => {
    const i = push.info();
    if (!i) return systemNotifications() ? "System notifications aren't available in this environment (open the hub's web page in a phone browser to receive push)" : "Web push isn't supported in this environment (open the hub's web page in a phone browser)";
    if (push.needsHomeScreen()) return "On iPhone, add Noop to the Home Screen first";
    if (!i.supported) return "This browser doesn't support web push";
    if (i.permission === "denied") return systemNotifications() ? "Notifications are blocked by the system" : "Notifications are blocked by the browser";
    return i.subscribed ? "On" : "Off";
  };
  /** The short form for a row's value. */
  const short = () => {
    const i = push.info();
    if (!i || !i.supported || push.needsHomeScreen()) return "Unavailable";
    if (i.permission === "denied") return "Blocked";
    return i.subscribed ? "On" : "Off";
  };
  return { prefs, setPrefs, state, short };
}

/** One shared preference keeps app and web-push quiet hours in the same named zone. */
function NotificationTimeZone(props: { prefs: () => NotifyPrefs; save: (change: Partial<NotifyPrefs>) => unknown }) {
  const draft = signal<string | null>(null), busy = signal(false), error = signal(""), note = signal("");
  const value = () => draft() ?? props.prefs().tz;
  async function submit() {
    if (busy()) return;
    const submitted = value(), tz = notificationTimeZone(submitted);
    error.set(""); note.set("");
    if (!tz) return error.set("Enter a valid IANA time zone, for example America/Toronto or UTC.");
    busy.set(true);
    const accepted = await props.save({ tz });
    busy.set(false);
    if (accepted === false) error.set("Couldn't save the time zone. Your entry is kept; check the settings message and retry.");
    else {
      if (draft() === submitted) draft.set(null);
      note.set(value().trim() === props.prefs().tz ? "Time zone saved." : "Submitted time zone saved. Your additional unsaved entry is kept.");
    }
  }
  return <View style={{ gap: 10 }}>
    <Field testID="notify-timezone" label="Quiet hours time zone" value={value()} onChange={(value) => { draft.set(value); error.set(""); note.set(""); }} onSubmit={() => void submit()} maxLength={100}
      hint="Use an IANA name such as America/Toronto or UTC. Daylight saving changes apply automatically. This preference is shared across your devices." />
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Btn testID="notify-timezone-save" label="Save time zone" kind="ghost" busy={busy()} disabled={busy() || value().trim() === props.prefs().tz} onPress={() => void submit()} />
      <Btn testID="notify-timezone-device" label="Use this device's time zone" kind="ghost" disabled={busy()} onPress={() => { draft.set(deviceTimeZone()); void submit(); }} />
    </View>
    <If when={error()}><Text testID="notify-timezone-error" style={{ color: colors.danger, fontSize: 13 }}>{error()}</Text></If>
    <If when={note()}><Text testID="notify-timezone-note" style={{ color: colors.up, fontSize: 13 }}>{note()}</Text></If>
  </View>;
}

/** A grouped, inset section: a muted title above, rows on one rounded surface, a hint below. */
function Section(props: { title?: string; hint?: string; testID?: string; children: JSX.Element }) {
  return (
    <View testID={props.testID} style={{ gap: 7 }}>
      <If when={props.title}>
        <Text style={{ paddingHorizontal: 32, fontSize: 13, color: colors.muted }}>{props.title}</Text>
      </If>
      <View style={{ marginHorizontal: 16, borderRadius: radius.card, borderCurve: "continuous", borderWidth: 0.5, borderColor: surfaceEdge(), overflow: "hidden", backgroundColor: colors.surface }}>{props.children}</View>
      <If when={props.hint}>
        <Text style={{ paddingHorizontal: 32, fontSize: 13, lineHeight: 18, color: colors.faint }}>{props.hint}</Text>
      </If>
    </View>
  );
}

/** The hairline above every row of a section but its first, inset to the text. */
function Hairline(props: { inset?: number }) {
  return <View style={{ position: "absolute", top: 0, left: props.inset ?? 16, right: 0, height: 0.5, backgroundColor: surfaceEdge() }} />;
}

/** A row of a section, at least 48 pt tall: a label (and a line under it), then a value, a control or a chevron. */
/** The code a machine runs: the short commit, a link to it on GitHub. */
function RevLink(props: { host: HostInfo }) {
  const short = () => (props.host.rev ?? "").slice(0, 7);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Text style={{ fontSize: 14, color: colors.muted }}>Version</Text>
      <Text
        role={props.host.rev_url ? "link" : undefined}
        testID={`rev-${props.host.host}`}
        accessibilityLabel={`Version ${short()}`}
        onPress={props.host.rev_url ? () => void openUrl(props.host.rev_url!).catch(() => {}) : undefined}
        style={{ fontFamily: MONO, fontSize: 13, color: props.host.rev_url ? linkColor() : colors.muted }}
      >
        {short()}
      </Text>
    </View>
  );
}

/** Ask every machine to update to the latest code; the primary also redeploys the web app and the Worker. */
async function updateAllMachines(hub: Hub) {
  const r = await AlertDialog.show({
    title: "Update all machines?",
    description: "Each machine pulls the latest code and restarts: idle ones update right away, busy ones restart once their tasks finish. The main machine also redeploys online.",
    actions: [
      { id: "cancel", label: "Cancel", role: "cancel" },
      { id: "update", label: "Update" },
    ],
  });
  if (r.action === "update") await hub.api("POST", "/api/fleet/update").catch(() => {});
}

/** One row per online machine with the commit it runs, then the button that updates them all. */
/** The commands typed after "/" in the composer: the built-ins, the saved ones (deletable), and a form to add one. */
function CommandRows(props: { settings: Settings }) {
  const { view, save } = props.settings;
  const saved = () => savedCommands(view());
  const { name, text, editing, note } = props.settings.commandDraft;
  const open = (c?: Command) => {
    name.set(c?.name ?? ""); text.set(c?.text ?? ""); note.set("");
    editing.set(c?.name ?? "");
  };
  return (
    <>
      <SetRow
        first
        label="/update"
        detail="Make every machine pull the latest code and restart"
        testID="command-row-builtin"
        trailing={<Text style={{ fontSize: 12, color: colors.faint, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: colors.raised }}>Built-in</Text>}
      />
      <Each of={saved()} key={(c) => c.name}>
        {(c) => (
          <View
            role="button"
            testID={`command-row-${c().name}`}
            accessibilityLabel={`Edit command ${c().name}`}
            onPress={() => open(c())}
            hoverStyle={hovered()}
            class="active:bg-raised"
          >
            <Hairline />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16, paddingRight: 14, paddingVertical: 11 }}>
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <Text style={{ fontSize: 15.5, fontWeight: "500", color: colors.text, numberOfLines: 1 }}>/{c().name}</Text>
                <Text style={{ fontSize: 13.5, lineHeight: 19, color: colors.muted, numberOfLines: 2 }}>{c().text}</Text>
              </View>
              <Icon name="chevron" size={14} tint={colors.faint} />
            </View>
          </View>
        )}
      </Each>
      <SetRow label="New command" tone="accent" leading={<Icon name="plus" size={16} tint={colors.info} />} onPress={() => open()} testID="command-new" />
      <CommandEditor settings={props.settings} />
    </>
  );
}

/** New / edit / delete one saved command, in a dialog: a name and the words it sends (several lines welcome). */
function CommandEditor(props: { settings: Settings }) {
  const { view, save } = props.settings;
  const { name, text, editing, note } = props.settings.commandDraft;
  const isNew = () => editing() === "";
  const close = () => { if (!props.settings.saving()) editing.set(undefined); };
  const others = () => savedCommands(view()).filter((c) => c.name !== editing());
  const clean = () => name().trim().replace(/^\//, "").replace(/\s+/g, "-");
  const ok = () => !!clean() && !!text().trim();
  const submit = async () => {
    const n = clean(), t = text().trim();
    if (!n) return note.set("Give the command a name");
    if (!t) return note.set("Write what this command sends to the team");
    if (BUILTIN_COMMANDS.some((b) => b.name === n)) return note.set(`"${n}" is the name of a built-in command`);
    if (others().some((c) => c.name === n)) return note.set(`"/${n}" already exists`);
    const list = savedCommands(view());
    const i = list.findIndex((c) => c.name === editing());
    const next = i < 0 ? [...list, { name: n, text: t }] : list.map((c, j) => (j === i ? { name: n, text: t } : c));
    if (await save({ commands: next })) {
      if (clean() === n && text().trim() === t) close();
      else { editing.set(n); note.set("Submitted version saved. You have additional unsaved edits."); }
    } else note.set(props.settings.error() || "Couldn't save this command. Your draft is kept.");
  };
  const remove = async () => {
    const n = editing();
    if (await save({ commands: savedCommands(view()).filter((c) => c.name !== n) })) close();
    else note.set(props.settings.error() || "Couldn't delete this command");
  };
  return (
    <Dialog
      testID="command-editor"
      open={editing() !== undefined}
      animation="fade"
      onOpenChange={({ open }) => !open && close()}
      backdropClass="bg-scrim"
      style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "box-none" }}
    >
      <View style={{ width: "100%", maxWidth: 560, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: "hidden" }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 20, paddingRight: 10, height: 56, borderBottomWidth: 0.5, borderBottomColor: surfaceEdge() }}>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: "600", color: colors.text }}>{isNew() ? "New command" : "Edit command"}</Text>
          <ToolButton icon="close" label="Close" shortcut="Esc" onPress={close} />
        </View>
        <View style={{ gap: 16, padding: 20 }}>
          <Field label="Name" value={name()} onChange={(v) => { name.set(v); note.set(""); }} placeholder="e.g. daily-report" testID="command-name" autoFocus={isNew()} hint={clean() ? `Type /${clean()} in the composer to use it` : "Type / and the name in the composer to use it"} />
          <TextArea
            label="Message to the team"
            testID="command-text"
            height={140}
            value={text()}
            onChange={(v) => { text.set(v); note.set(""); }}
            placeholder={"e.g. Summarize today's progress on each project into a daily report and send it to me,\none section per project, conclusion first."}
          />
          <If when={note()}>
            <Text testID="command-note" style={{ fontSize: 13.5, color: colors.danger }}>{note()}</Text>
          </If>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 20, paddingBottom: 20 }}>
          <If when={!isNew()}>
            <Btn label="Delete" kind="danger" icon="trash" disabled={!!props.settings.saving()} onPress={() => void remove()} testID="command-delete" />
          </If>
          <View style={{ flex: 1 }} />
          <Btn label="Cancel" kind="ghost" onPress={close} testID="command-cancel" />
          <Btn label={isNew() ? "Add" : "Save"} kind="primary" disabled={!ok() || !!props.settings.saving()} onPress={() => void submit()} testID="command-save" />
        </View>
      </View>
    </Dialog>
  );
}

/** A labelled multi-line field. */
function TextArea(props: { label: string; value: string; onChange: (v: string) => void; height: number; placeholder?: string; testID?: string; hint?: string }) {
  const focused = signal(false);
  return (
    <View style={{ gap: 7 }}>
      <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{props.label}</Text>
      <Input
        testID={props.testID}
        multiline
        value={props.value}
        onChange={({ value }) => props.onChange(value)}
        onFocus={() => focused.set(true)}
        onBlur={() => focused.set(false)}
        placeholder={props.placeholder}
        class="placeholder:text-faint"
        style={{
          height: props.height,
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderRadius: radius.control,
          borderWidth: 1,
          borderColor: focused() ? colors.accent : colors.fieldBorder,
          backgroundColor: colors.field,
          fontSize: 15.5,
          lineHeight: 23,
          color: colors.text,
          ...(focused() ? { outlineStyle: "solid", outlineWidth: 3, outlineColor: alpha(colors.accent, 0.12) } : {}),
        }}
      />
      <If when={props.hint}>
        <Text style={{ fontSize: 13, lineHeight: 18, color: colors.faint }}>{props.hint}</Text>
      </If>
    </View>
  );
}

/** New / edit / delete one routine, in a dialog: what it does, who does it, and when. */
function RoutineEditor(props: { settings: Settings; onGone?: () => void }) {
  const { name, every, agent, project, prompt, desc, enabled, readonly, kind, editing, note, busy, requires, host, cli, priority, prefer, weight, repo, scheduler, detector } = props.settings.routineDraft;
  const advanced = signal(false);
  const eff = () => props.settings.view()?.effective;
  const isNew = () => editing() === "";
  const learn = () => kind() === "learn";
  const close = () => editing.set(undefined);
  const clean = () => name().trim().toLowerCase().replace(/\s+/g, "-");
  const ok = () => !!clean() && !!every().trim() && (learn() || (!!prompt().trim() && !!agent())) && !busy();
  const clear = () => note.set("");
  const submit = () => {
    const body = { name: clean(), every: every(), agent: agent(), project: project(), prompt: prompt(), desc: desc(), enabled: enabled(), readonly: readonly(), requires: requires(), host: host(), cli: cli(), priority: priority(), prefer: prefer(), weight: weight(), repo: repo(), scheduler: scheduler(), signal: detector() };
    void (isNew() ? props.settings.writeRoutine("POST", "/api/routines", body) : props.settings.writeRoutine("PUT", `/api/routines/${encodeURIComponent(editing()!)}`, body));
  };
  const remove = async () => {
    const id = editing()!;
    const r = await AlertDialog.show({
      title: `Delete ${id}?`,
      description: "It stops creating tasks. Anything it already started carries on. A copy stays in Archive, where you can restore it paused.",
      actions: [
        { id: "cancel", label: "Cancel", role: "cancel" },
        { id: "delete", label: "Delete", role: "destructive" },
      ],
    });
    if (r.action === "delete" && (await props.settings.writeRoutine("DELETE", `/api/routines/${encodeURIComponent(id)}`))) props.onGone?.();
  };
  return (
    <Dialog
      testID="routine-editor"
      open={editing() !== undefined}
      animation="fade"
      onOpenChange={({ open }) => !open && close()}
      backdropClass="bg-scrim"
      style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "box-none" }}
    >
      <View style={{ width: "100%", maxWidth: 620, maxHeight: "100%", borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: "hidden" }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 20, paddingRight: 10, height: 56, borderBottomWidth: 0.5, borderBottomColor: surfaceEdge() }}>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: "600", color: colors.text }}>{isNew() ? "New routine" : "Edit routine"}</Text>
          <ToolButton icon="close" label="Close" shortcut="Esc" onPress={close} />
        </View>
        <Scroll style={{ flexShrink: 1 }}>
          <View style={{ gap: 16, padding: 20 }}>
            <Field label="Name" value={name()} onChange={(v) => { name.set(v); clear(); }} placeholder="e.g. weekly-deps" testID="routine-name" autoFocus={isNew()} />
            <Field label="Schedule" value={every()} onChange={(v) => { every.set(v); clear(); }} placeholder="e.g. daily 09:00" testID="routine-every" hint="30m, hourly, daily 09:00, weekdays 09:00 or weekly MON 09:00, in this machine's time. Frequent routines use more quota." />
            <If when={!learn()} else={<Text style={{ fontSize: 13.5, lineHeight: 19, color: colors.muted }}>This routine learns from each machine's selected local conversation sources, so it has no member or instructions to set.</Text>}>
              <>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  <Dropdown
                    testID="routine-agent"
                    label="Member"
                    value={eff()?.agents.find((a) => a.id === agent())?.title ?? (agent() || "Choose")}
                    options={(eff()?.agents ?? []).map((a) => ({ id: a.id, label: a.title ?? a.id, testID: `routine-agent-${a.id}` }))}
                    selected={agent()}
                    onPick={(id) => { agent.set(id); clear(); }}
                  />
                  <Dropdown
                    testID="routine-project"
                    label="Project"
                    value={eff()?.projects?.find((p) => p.id === project())?.name ?? (project() || "None")}
                    options={[{ id: "", label: "None", testID: "routine-project-none" }, ...(eff()?.projects ?? []).map((p) => ({ id: p.id, label: p.name, testID: `routine-project-${p.id}` }))]}
                    selected={project()}
                    onPick={(id) => { project.set(id); clear(); }}
                  />
                </View>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  <Dropdown testID="routine-os" label="OS" value={requires().split(",").map((r) => r.trim()).find((r) => r.startsWith("os:"))?.replace("os:", "") || "Any OS"}
                    selected={requires().split(",").map((r) => r.trim()).find((r) => r.startsWith("os:")) ?? ""}
                    onPick={(v) => requires.set([...requires().split(",").map((r) => r.trim()).filter((r) => r && !r.startsWith("os:")), v].filter(Boolean).join(","))}
                    options={[{ id: "", label: "Any OS", testID: "routine-os-any" }, ...["macos", "linux", "windows"].map((o) => ({ id: `os:${o}`, label: o === "macos" ? "macOS" : o === "linux" ? "Linux" : "Windows", testID: `routine-os-${o}` }))]} />
                  <Dropdown testID="routine-cli" label="CLI" value={cli()} selected={cli()} onPick={(v) => cli.set(v)} options={["auto", ...PROVIDER_IDS].map((id) => ({ id, label: id, detail: id !== "auto" && !(eff()?.enabled_clis ?? DEFAULT_PROVIDERS).includes(id) ? "Disabled in AI tools & onboarding" : undefined }))} />
                  <Dropdown testID="routine-priority" label="Priority" value={priority()} selected={priority()} onPick={(v) => priority.set(v)} options={["urgent", "high", "normal", "low"].map((id) => ({ id, label: id }))} />
                </View>
                <If when={cli() !== "auto" && !(eff()?.enabled_clis ?? DEFAULT_PROVIDERS).includes(cli())}><Text testID="routine-cli-disabled" style={{ fontSize: 13, lineHeight: 19, color: colors.warn }}>{`${providerLabel(cli())} is disabled for execution. Choose another tool or enable it in Settings → AI tools & onboarding.`}</Text></If>
                <Dropdown testID="routine-host" label="Machine" value={host() === "any" ? "Any matching machine" : host()} selected={host()} onPick={(v) => host.set(v)}
                  options={[{ id: "any", label: "Any matching machine" }, ...props.settings.machines().map((h) => ({ id: h.host, label: h.host, detail: h.online === false ? "Offline" : h.enabled === false ? "Paused for new tasks" : "Online" }))]} />
                <Text style={{ fontSize: 13, color: colors.faint }}>A selected project's machine takes precedence.</Text>
                <Field testID="routine-requires" label="Required capabilities" value={requires()} onChange={(v) => requires.set(v)} hint="Leave empty for any OS. Use os:macos, os:linux or os:windows only when the work needs that OS; separate additional capabilities with commas. Applies to future runs." />
                <TextArea label="What should it do?" testID="routine-prompt" height={140} value={prompt()} onChange={(v) => { prompt.set(v); clear(); }} placeholder="e.g. Check for outdated dependencies and report what's worth updating." />
              </>
            </If>
            <Btn testID="routine-advanced" label={advanced() ? "Hide advanced run settings" : "Advanced run settings"} kind="ghost" onPress={() => advanced.set(!advanced())} />
            <If when={advanced()}>
              <Dropdown testID="routine-scheduler" label="Schedule from" value={scheduler() === "primary" ? "Main machine" : scheduler() === "each" ? "Every machine" : scheduler()} selected={scheduler()} onPick={(v) => scheduler.set(v)}
                options={[{ id: "primary", label: "Main machine", testID: "routine-scheduler-primary" }, { id: "each", label: "Every machine", detail: "Each machine creates its own local run", testID: "routine-scheduler-each" }, ...props.settings.machines().map((h) => ({ id: h.host, label: h.host, detail: h.online === false ? "Offline" : "Online", testID: `routine-scheduler-${h.host}` }))]} />
              <Text style={{ fontSize: 13, lineHeight: 18, color: colors.faint }}>The scheduling machine creates the task at the chosen time. Every machine creates a separate local task unless a project or run machine overrides its location.</Text>
              <If when={!learn()}>
                <Field testID="routine-prefer" label="Preferred capabilities" value={prefer()} onChange={(v) => prefer.set(v)} hint="A soft preference, e.g. os:macos or gpu. Other machines can still run the task." />
                <Dropdown testID="routine-weight" label="Resource use" value={weight()} selected={weight()} onPick={(v) => weight.set(v)} options={[{ id: "normal", label: "Normal", testID: "routine-weight-normal" }, { id: "heavy", label: "Heavy", detail: "Waits for spare resources", testID: "routine-weight-heavy" }]} />
                <Field testID="routine-repo" label="Working folder (without a project)" value={repo()} onChange={(v) => repo.set(v)} hint="Must exist on the run machine. A selected project supplies its saved folder instead." />
                <TextArea testID="routine-signal" label="Change detector command (optional)" height={80} value={detector()} onChange={(v) => detector.set(v)} hint="Runs in Noop's data folder on the scheduling machine. An agent runs only when the command's output changes or the command fails. Leave empty to run every scheduled time." />
              </If>
            </If>
            <Field label="Description (optional)" value={desc()} onChange={(v) => { desc.set(v); clear(); }} placeholder="Shown in the routines list" testID="routine-desc" />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Toggle testID="routine-enabled" label="On" value={enabled()} onChange={(on) => enabled.set(on)} />
              <Text style={{ flex: 1, fontSize: 14, color: colors.text }}>On</Text>
            </View>
            <If when={!learn()}>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <Toggle testID="routine-readonly" label="Only observe" value={readonly()} onChange={(on) => readonly.set(on)} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ fontSize: 14, color: colors.text }}>Only observe</Text>
                  <Text style={{ fontSize: 13, lineHeight: 18, color: colors.faint }}>It's told to report and change nothing, so it can run without your approval. Changes it suggests come back to you as follow-ups.</Text>
                </View>
              </View>
            </If>
            <If when={note()}>
              <Text testID="routine-note" style={{ fontSize: 13.5, lineHeight: 19, color: colors.danger }}>{note()}</Text>
            </If>
          </View>
        </Scroll>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 20, paddingVertical: 16, borderTopWidth: 0.5, borderTopColor: surfaceEdge() }}>
          <If when={!isNew()}>
            <Btn label="Delete" kind="danger" icon="trash" onPress={() => void remove()} testID="routine-delete" />
          </If>
          <View style={{ flex: 1 }} />
          <Btn label="Cancel" kind="ghost" onPress={close} testID="routine-cancel" />
          <Btn label={isNew() ? "Add" : "Save"} kind="primary" disabled={!ok()} busy={busy()} onPress={submit} testID="routine-save" />
        </View>
      </View>
    </Dialog>
  );
}

/** The connected projects, and the way to add one. */
function ProjectRows(props: { settings: Settings }) {
  const projects = () => props.settings.view()?.effective.projects ?? [];
  return (
    <>
      <Each of={projects()} key={(p) => p.id}>
        {(p, i) => (
          <SetRow
            first={i() === 0}
            label={p().name}
            detail={p().exists === false ? `Folder not found: ${p().path}` : [p().exists === null ? p().host : "", p().repo, p().path, p().exists === null ? p().checked ? `Last checked ${ago(p().checked!)}` : "Folder not yet verified" : ""].filter(Boolean).join(" · ")}
            chevron
            onPress={() => props.settings.openProject(p())}
            testID={`project-${p().id}`}
          />
        )}
      </Each>
      <SetRow first={!projects().length} label="Connect a project" tone="accent" leading={<Icon name="plus" size={16} tint={colors.info} />} onPress={() => props.settings.openProject()} testID="project-new" />
      <ProjectEditor settings={props.settings} />
    </>
  );
}

/** Connect / edit / remove one project, in a dialog: its name, its folder and how to work in it. */
function ProjectEditor(props: { settings: Settings }) {
  const { name, path, host, repo, requires, original, instructions, editing, note, busy, checking } = props.settings.projectDraft;
  const isNew = () => editing() === "";
  const close = () => editing.set(undefined);
  const advanced = () => !!props.settings.view()?.effective.primary_host;
  const ok = () => !!name().trim() && !!path().trim() && !busy() && !checking();
  const submit = () => void props.settings.saveProject();
  const machines = () => [...new Set([props.settings.view()?.effective.primary_host ?? "", ...props.settings.machines().map((m) => m.host), props.settings.projectHost()].filter(Boolean))];
  const detected = () => props.settings.projectProbe() ?? (!props.settings.projectPlacementChanged() ? { requires: original()?.detected_requires ?? [], repo: original()?.detected_repo ?? "", checked: original()?.checked } : null);
  const remove = async () => {
    const id = editing()!;
    const r = await AlertDialog.show({
      title: `Remove ${name() || id}?`,
      description: "The team stops working on it. Its folder isn't touched; the project record and instructions stay in Archive.",
      actions: [
        { id: "cancel", label: "Cancel", role: "cancel" },
        { id: "remove", label: "Remove", role: "destructive" },
      ],
    });
    if (r.action === "remove") await props.settings.writeProject("DELETE", `/api/projects/${id}`);
  };
  return (
    <Dialog
      testID="project-editor"
      open={editing() !== undefined}
      animation="fade"
      onOpenChange={({ open }) => !open && close()}
      backdropClass="bg-scrim"
      style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "box-none" }}
    >
      <View style={{ width: "100%", maxWidth: 620, maxHeight: "100%", borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: "hidden" }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 20, paddingRight: 10, height: 56, borderBottomWidth: 0.5, borderBottomColor: surfaceEdge() }}>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: "600", color: colors.text }}>{isNew() ? "Connect a project" : "Edit project"}</Text>
          <ToolButton icon="close" label="Close" shortcut="Esc" onPress={close} />
        </View>
        <Scroll style={{ flexShrink: 1 }}>
          <View style={{ gap: 16, padding: 20 }}>
            <Field label="Name" value={name()} onChange={(v) => { name.set(v); note.set(""); }} placeholder="e.g. Website" testID="project-name" autoFocus={isNew()} />
            <If when={advanced()}>
              <Dropdown testID="project-host" label="Machine" value={props.settings.projectHost()} selected={props.settings.projectHost()} onPick={(v) => { host.set(v); note.set(""); }}
                options={machines().map((id) => ({ id, label: id, detail: id === props.settings.view()?.effective.primary_host ? "Main machine" : props.settings.machines().find((m) => m.host === id)?.online === false ? "Offline" : "Worker", testID: `project-host-${id}` }))} />
            </If>
            <Field label="Folder" value={path()} onChange={(v) => { path.set(v); note.set(""); }} placeholder="e.g. ~/code/website" testID="project-path" hint={advanced() ? "A folder on the selected machine. That machine expands ~ and detects its GitHub repo and build tools." : "A folder on the machine running Noop. It doesn't have to use git; if it's on GitHub, Noop finds the repo."} />
            <If when={advanced()} else={<Text style={{ fontSize: 13, lineHeight: 18, color: colors.faint }}>Update the main machine for project machine selection and requirements.</Text>}>
              <View style={{ gap: 8 }}>
                <Btn testID="project-check" label={`Check folder on ${props.settings.projectHost()}`} kind="secondary" disabled={!path().trim() || busy() || checking()} busy={checking()} onPress={() => void props.settings.checkProjectFolder()} />
                <If when={detected()}>
                  <Text testID="project-detected" style={{ fontSize: 13, lineHeight: 19, color: colors.muted }}>{[`Detected repo: ${detected()!.repo || "None"}`, `Detected requirements: ${detected()!.requires.length ? detected()!.requires.join(", ") : "None"}`, detected()!.checked ? `Checked ${ago(detected()!.checked!)}` : ""].filter(Boolean).join("\n")}</Text>
                </If>
                <If when={props.settings.machines().some((m) => m.host === props.settings.projectHost() && m.online === false)}>
                  <Text testID="project-offline" style={{ fontSize: 13, lineHeight: 19, color: colors.warn }}>Connect this machine to check a new or moved folder. You can still edit a saved project's settings.</Text>
                </If>
              </View>
              <Field label="GitHub repo override (optional)" testID="project-repo" value={repo()} onChange={(v) => { repo.set(v); note.set(""); }} placeholder="owner/repository" hint="Leave empty to use the repo detected in the folder." />
              <Field label="Additional requirements" testID="project-requires" value={requires()} onChange={(v) => { requires.set(v); note.set(""); }} placeholder="e.g. docker,gpu" hint="Detected build-tool requirements are always included. These add your own requirements for new tasks; existing tasks keep their run settings." />
            </If>
            <TextArea
              label="Instructions (optional)"
              testID="project-instructions"
              height={160}
              value={instructions()}
              onChange={(v) => { instructions.set(v); note.set(""); }}
              placeholder={"What anyone working here should know: how to build and test, what not to touch.\ne.g. Run npm test before finishing. Don't edit generated files in dist/."}
            />
            <If when={note()}>
              <Text testID="project-note" style={{ fontSize: 13.5, lineHeight: 19, color: colors.danger }}>{note()}</Text>
            </If>
          </View>
        </Scroll>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 20, paddingVertical: 16, borderTopWidth: 0.5, borderTopColor: surfaceEdge() }}>
          <If when={!isNew()}>
            <Btn label="Remove" kind="danger" icon="trash" disabled={busy() || checking()} onPress={() => void remove()} testID="project-delete" />
          </If>
          <View style={{ flex: 1 }} />
          <Btn label="Cancel" kind="ghost" onPress={close} testID="project-cancel" />
          <Btn label={isNew() ? "Connect" : "Save"} kind="primary" disabled={!ok()} busy={busy() || checking()} onPress={submit} testID="project-save" />
        </View>
      </View>
    </Dialog>
  );
}

type BuiltinRole = { id: string; about: string; installed: boolean; profile: string; routines: { name: string; every: string; enabled: false }[] };

/** Built-in profiles can be previewed and added without replacing a member's own instructions. */
function RoleLibrary(props: { hub: Hub; disabled?: boolean; onAdded?: (view: SettingsView) => void }) {
  const open = signal(false), busy = signal(false), note = signal("");
  const roles = signal<Pick<BuiltinRole, "id" | "about" | "installed">[]>([]), selected = signal("");
  const preview = signal<BuiltinRole | null>(null), retry = signal(false);
  const close = () => { if (!busy()) open.set(false); };
  async function choose(id: string) {
    selected.set(id); preview.set(null); note.set(""); retry.set(false); busy.set(true);
    const r = await props.hub.api("GET", `/api/roles/${encodeURIComponent(id)}`);
    if (r.ok && typeof r.data.profile === "string") preview.set(r.data as BuiltinRole);
    else note.set(String(r.data.error ?? "Couldn't load this specialist"));
    busy.set(false);
  }
  async function browse() {
    open.set(true); busy.set(true); note.set(""); preview.set(null); retry.set(false);
    const r = await props.hub.api("GET", "/api/roles");
    if (r.ok && Array.isArray(r.data.roles)) {
      const list = r.data.roles as Pick<BuiltinRole, "id" | "about" | "installed">[]; roles.set(list);
      busy.set(false);
      const first = list.find((role) => role.id === "apprentice" && !role.installed) ?? list.find((role) => !role.installed) ?? list[0];
      if (first) return choose(first.id);
      note.set("No built-in specialists are available on the main machine.");
    } else note.set(r.status === 404 ? "Update the hub and main machine to add built-in specialists." : String(r.data.error ?? "Couldn't load built-in specialists"));
    busy.set(false);
  }
  async function add() {
    if (!preview() || busy()) return;
    busy.set(true); note.set("");
    const r = await props.hub.api("POST", `/api/roles/${encodeURIComponent(selected())}`, {});
    if ((r.ok || r.data.saved_locally) && r.data.view) props.onAdded?.(r.data.view as SettingsView);
    if (r.ok) open.set(false);
    else { retry.set(r.data.saved_locally === true); note.set(String(r.data.error ?? "Couldn't add this specialist")); }
    busy.set(false);
  }
  return <>
    <Btn testID="role-library-open" label="Add built-in specialist" kind="ghost" disabled={props.disabled} onPress={() => void browse()} />
    <Dialog testID="role-library" open={open()} animation="fade" onOpenChange={({ open }) => !open && close()} backdropClass="bg-scrim"
      style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "box-none" }}>
      <View style={{ width: "100%", maxWidth: 620, maxHeight: "100%", borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: "hidden" }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 20, paddingRight: 10, height: 56, borderBottomWidth: 0.5, borderBottomColor: surfaceEdge() }}>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: "600", color: colors.text }}>Built-in specialists</Text>
          <ToolButton icon="close" label="Close" onPress={close} />
        </View>
        <Scroll style={{ flexShrink: 1 }}><View style={{ gap: 14, padding: 20 }}>
          <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18 }}>Preview the supplied instructions before adding a member. Existing instructions and routines are preserved. Newly added routines start off; enable and configure them in Routines.</Text>
          <If when={roles().length > 0 && !busy()}><Dropdown testID="role-choice" label="Specialist" value={roles().find((role) => role.id === selected())?.about ?? selected()} selected={selected()}
            options={roles().map((role) => ({ id: role.id, label: role.about, detail: role.installed ? "Already on the team" : undefined, testID: `role-choice-${role.id}` }))} onPick={(id) => void choose(id)} /></If>
          <If when={preview()}>{(role) => <>
            <If when={role().installed}><Text style={{ color: colors.muted, fontSize: 13 }}>Already on the team. This preview shows the built-in instructions. Restore and sync adds missing routines and retries synchronization; your current instructions and existing routines stay as they are.</Text></If>
            <View testID="role-profile" selectable><Rich text={role().profile} /></View>
            <If when={role().routines.length > 0}><Text testID="role-routines" style={{ color: colors.muted, fontSize: 13, lineHeight: 18 }}>{`Supplied routines (off when added): ${role().routines.map((routine) => `${routine.name} · ${everyLabel(routine.every)}`).join("; ")}`}</Text></If>
          </>}</If>
          <If when={busy()}><Text style={{ color: colors.muted }}>Loading…</Text></If>
          <If when={note()}><Text testID="role-note" style={{ color: colors.danger, fontSize: 13, lineHeight: 18 }}>{note()}</Text></If>
        </View></Scroll>
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 10, padding: 16, borderTopWidth: 0.5, borderTopColor: surfaceEdge() }}>
          <Btn testID="role-library-close" label="Close" kind="ghost" disabled={busy()} onPress={close} />
          <Btn testID="role-add" label={retry() ? "Retry sync" : preview()?.installed ? "Restore and sync" : "Add specialist"} kind="primary" busy={busy()} disabled={busy() || !preview()} onPress={() => void add()} />
        </View>
      </View>
    </Dialog>
  </>;
}

/** New / edit / delete one member, in a dialog: who they are and how they work. The instructions go into every prompt they run with. */
function MemberEditor(props: { settings: Settings; onGone?: () => void }) {
  const { title, name, about, instructions, editing, note, busy } = props.settings.memberDraft;
  const isNew = () => editing() === "";
  const close = () => editing.set(undefined);
  const ok = () => !!title().trim() && !!instructions().trim() && !busy();
  const submit = () => {
    const body = { title: title(), name: name(), about: about(), instructions: instructions() };
    void (isNew() ? props.settings.writeMember("POST", "/api/members", body) : props.settings.writeMember("PUT", `/api/members/${editing()}`, body));
  };
  const remove = async () => {
    const id = editing()!;
    const r = await AlertDialog.show({
      title: `Delete ${title() || id}?`,
      description: "They leave the team and stop getting work. Their profile and memory stay in Archive, where you can restore them later.",
      actions: [
        { id: "cancel", label: "Cancel", role: "cancel" },
        { id: "delete", label: "Delete", role: "destructive" },
      ],
    });
    if (r.action === "delete" && (await props.settings.writeMember("DELETE", `/api/members/${id}`))) props.onGone?.();
  };
  return (
    <Dialog
      testID="member-editor"
      open={editing() !== undefined}
      animation="fade"
      onOpenChange={({ open }) => !open && close()}
      backdropClass="bg-scrim"
      style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "box-none" }}
    >
      <View style={{ width: "100%", maxWidth: 620, maxHeight: "100%", borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: "hidden" }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 20, paddingRight: 10, height: 56, borderBottomWidth: 0.5, borderBottomColor: surfaceEdge() }}>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: "600", color: colors.text }}>{isNew() ? "New member" : "Edit member"}</Text>
          <ToolButton icon="close" label="Close" shortcut="Esc" onPress={close} />
        </View>
        <Scroll style={{ flexShrink: 1 }}>
          <View style={{ gap: 16, padding: 20 }}>
            <Field label="Role" value={title()} onChange={(v) => { title.set(v); note.set(""); }} placeholder="e.g. Backend Engineer" testID="member-title" autoFocus={isNew()} />
            <Field label="Name (optional)" value={name()} onChange={(v) => { name.set(v); note.set(""); }} placeholder="e.g. Ada" testID="member-name" hint="Shown on their messages. Uses the role if empty." />
            <Field label="Summary (optional)" value={about()} onChange={(v) => { about.set(v); note.set(""); }} placeholder="e.g. owns the API and database" testID="member-about" hint="One line. Other members and the chat use it to decide who should get a task." />
            <TextArea
              label="Instructions"
              testID="member-instructions"
              height={200}
              value={instructions()}
              onChange={(v) => { instructions.set(v); note.set(""); }}
              placeholder={"How this member should work: what they own, how they test, when to ask you.\ne.g. Run the test suite before finishing. Never change the database schema without asking."}
            />
            <If when={note()}>
              <Text testID="member-note" style={{ fontSize: 13.5, lineHeight: 19, color: colors.danger }}>{note()}</Text>
            </If>
          </View>
        </Scroll>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 20, paddingVertical: 16, borderTopWidth: 0.5, borderTopColor: surfaceEdge() }}>
          <If when={!isNew()}>
            <Btn label="Delete" kind="danger" icon="trash" onPress={() => void remove()} testID="member-delete" />
          </If>
          <View style={{ flex: 1 }} />
          <Btn label="Cancel" kind="ghost" onPress={close} testID="member-cancel" />
          <Btn label={isNew() ? "Add" : "Save"} kind="primary" disabled={!ok()} busy={busy()} onPress={submit} testID="member-save" />
        </View>
      </View>
    </Dialog>
  );
}

function VersionRows(props: { hub: Hub }) {
  const hosts = () => props.hub.status()?.hosts ?? [];
  // the lines age (waiting → not responding, finished → hidden): re-read the clock every few seconds
  const clock = signal(Date.now());
  const timer = setInterval(() => clock.set(Date.now()), 5000);
  cleanup(() => clearInterval(timer));
  const request = () => props.hub.status()?.update?.at;
  const summary = () => updateSummary(props.hub.status(), clock());
  const toneColor = (t: UpdateLine["tone"]) => (t === "ok" ? colors.up : t === "bad" ? colors.danger : colors.muted);
  return (
    <>
      <Each of={hosts()} key={(h) => h.host}>
        {(h, i) => {
          const line = () => updateLine(h(), request(), clock());
          return (
            <SetRow
              first={i() === 0}
              label={h().host}
              value={h().rev?.slice(0, 7) ?? "Unknown"}
              chevron={!!h().rev_url}
              onPress={h().rev_url ? () => void openUrl(h().rev_url!).catch(() => {}) : undefined}
              testID={`version-${h().host}`}
              below={
                <If when={line()}>
                  <View testID={`update-${h().host}`} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <If when={line()!.busy}>
                      <Spinner size={12} tint={colors.muted} />
                    </If>
                    <Text style={{ flexShrink: 1, fontSize: 13, lineHeight: 18, color: toneColor(line()!.tone) }}>{line()!.text}</Text>
                  </View>
                </If>
              }
            />
          );
        }}
      </Each>
      <SetRow
        first={!hosts().length}
        label={summary()?.busy ? "Updating…" : "Update all machines"}
        detail={summary()?.text}
        tone="accent"
        disabled={!!summary()?.busy}
        onPress={() => void updateAllMachines(props.hub)}
        testID="update-fleet"
      />
    </>
  );
}

function SetRow(props: {
  label: string;
  detail?: string;
  value?: string;
  first?: boolean;
  chevron?: boolean;
  tone?: "danger" | "accent";
  leading?: JSX.Element;
  trailing?: JSX.Element;
  /** Under the label and detail (a progress line). */
  below?: JSX.Element;
  inset?: number;
  disabled?: boolean;
  onPress?: () => void;
  testID?: string;
}) {
  const press = () => (props.disabled ? undefined : props.onPress);
  return (
    <View
      role={props.onPress ? "button" : undefined}
      testID={props.testID}
      accessibilityLabel={props.onPress ? [props.label, props.value].filter(Boolean).join(", ") : undefined}
      accessibilityState={props.onPress ? { disabled: !!props.disabled } : undefined}
      onPress={press()}
      class={props.onPress && !props.disabled ? "active:bg-raised" : undefined}
      style={{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16, paddingRight: 14, paddingVertical: 10 }}
    >
      <If when={!props.first}>
        <Hairline inset={props.inset} />
      </If>
      {props.leading}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          style={{
            fontSize: 16,
            textAlign: props.tone === "danger" && !props.trailing && !props.chevron ? "center" : "left",
            color: props.disabled ? colors.faint : props.tone === "danger" ? colors.danger : props.tone === "accent" ? colors.info : colors.text,
            numberOfLines: 1,
          }}
        >
          {props.label}
        </Text>
        <If when={props.detail}>
          <Text style={{ fontSize: 13, lineHeight: 18, color: colors.muted }}>{props.detail}</Text>
        </If>
        {props.below}
      </View>
      <If when={props.value}>
        <Text style={{ flexShrink: 1, fontSize: 16, color: colors.muted, numberOfLines: 1 }}>{props.value}</Text>
      </If>
      {props.trailing}
      <If when={props.chevron}>
        <Icon name="chevron" size={14} tint={colors.faint} />
      </If>
    </View>
  );
}

const MEDIA_HINT = "How long screenshots and images in chat are kept before they are deleted automatically.";

/** How long images are kept: 7, 14, 30 or 90 days. */
function MediaDaysChoices(props: { settings: Settings }) {
  const { view, save } = props.settings;
  return (
    <Choices
      label="Image retention"
      choices={MEDIA_DAYS.map((d) => ({ id: String(d), label: `${d} days`, testID: `media-days-${d}` }))}
      selected={view() ? String(mediaDaysOf(view())) : null}
      onPick={(id) => save(patches.mediaDays(Number(id)))}
    />
  );
}

type Choice = { id: string; label: string; detail?: string; testID: string };

/** Pick one of a few: a radio set of rows, the chosen one checked. */
function Choices(props: { label: string; choices: Choice[]; selected: string | null; onPick: (id: string) => void }) {
  return (
    <RadioGroup>
      <Each of={props.choices} key={(c) => c.id}>
        {(c, i) => (
          <Radio
            testID={c().testID}
            checked={c().id === props.selected}
            onChange={() => props.onPick(c().id)}
            accessibilityLabel={c().label}
            class="active:bg-raised"
            style={{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16, paddingRight: 16, paddingVertical: 10 }}
          >
            <If when={i() > 0}>
              <Hairline />
            </If>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 16, color: colors.text }}>{c().label}</Text>
              <If when={c().detail}>
                <Text style={{ fontSize: 13, color: colors.muted }}>{c().detail}</Text>
              </If>
            </View>
            <View style={{ width: 20, alignItems: "center" }}>
              <If when={c().id === props.selected}>
                <View testID={`choice-check-${c().testID}`}><Icon name="check" size={17} tint={colors.info} /></View>
              </If>
            </View>
          </Radio>
        )}
      </Each>
    </RadioGroup>
  );
}

/** A page of sections on the grouped background. */
function Grouped(props: { testID?: string; settings?: Settings; children: JSX.Element }) {
  return (
    <View style={{ flex: 1, backgroundColor: platform.os === "ios" ? (isDark() ? "#1c1c1e" : "#f2f2f2") : colors.background }}>
      <If when={props.settings}><SaveNote settings={props.settings!} /></If>
      <Scroll testID={props.testID} style={{ flex: 1 }}>
        <View style={{ width: "100%", maxWidth: 640, alignSelf: "center", gap: 28, paddingTop: 20, paddingBottom: Math.max(32, safeArea().bottom + 16) }}>{props.children}</View>
      </Scroll>
    </View>
  );
}

function SaveNote(props: { settings: Settings }) {
  return (
    <If when={props.settings.error()}>
      <Text testID="settings-note" style={{ paddingHorizontal: 32, paddingVertical: 8, fontSize: 13, color: props.settings.error() ? colors.danger : colors.up }}>
        {props.settings.error()}
      </Text>
    </If>
  );
}

const routineValue = (r: { enabled: boolean; every: string }) => (r.enabled ? everyLabel(r.every) : "Off");

/** Settings on a phone: a list of sections; Notifications, each member and each routine push pages of their own. */
function PhoneSettings(props: { hub: Hub; push: Push; settings: Settings; onOpen: (r: Route) => void; onDisconnect: () => void }) {
  const { view, error, save } = props.settings;
  props.settings.load();
  const notify = notifyModel(props.push, view, save);
  const eff = () => view()?.effective;
  async function logout() {
    const r = await AlertDialog.show({
      title: "Sign out?",
      description: "Notifications will be turned off on this device, and you'll need to sign in again next time.",
      actions: [
        { id: "cancel", label: "Cancel", role: "cancel" },
        { id: "logout", label: "Sign out", role: "destructive" },
      ],
    });
    if (r.action === "logout") props.onDisconnect();
  }
  return (
    <Grouped testID="phone-settings" settings={props.settings}>
      <Section title="Notifications" hint="Decisions that need you are pushed to this device; you can pick an option right from the notification.">
        <SetRow first label="Notifications" value={notify.short()} chevron onPress={() => props.onOpen({ name: "notify" })} testID="settings-notify" />
      </Section>
      <Section title="Memory" hint="The rules the team works by, your preferences, member profiles and decision precedents. Edit rules, preferences and member memory here.">
        <SetRow first label="Rules and memory" chevron onPress={() => props.onOpen({ name: "rules" })} testID="settings-rules" />
      </Section>
      <Section title="Archive" hint="Preview and restore deleted routines, members, projects and plans.">
        <SetRow first label="Archive" chevron onPress={() => props.onOpen({ name: "archive" })} testID="settings-archive" />
        <SetRow label="Saved requests" value={props.hub.savedEntries().length ? String(props.hub.savedEntries().length) : undefined} chevron onPress={() => props.onOpen({ name: "saved" })} testID="settings-saved" />
      </Section>
      <If when={eff()} else={<Text style={{ paddingHorizontal: 32, fontSize: 14, color: colors.faint }}>{error() ? "Couldn't load settings" : "Loading…"}</Text>}>
        {(e) => (
          <View style={{ gap: 28 }}>
            <Section title="Default task tool order" hint="Applies to new tasks on the machine claiming them. Explicit orders use the first usable tool; Automatic lets planning choose. Chat, judges and automatic repair keep their own tool choices.">
              <View style={{ padding: 16 }}><TaskToolPolicy settings={props.settings} /></View>
            </Section>
            <Section title="Members" hint="Open a member to edit their instructions, model and autonomy.">
              <Each of={e().agents} key={(a) => a.id}>
                {(a, i) => (
                  <SetRow
                    first={i() === 0}
                    inset={58}
                    leading={<Avatar from={a().id} />}
                    label={a().title ?? a().id}
                    detail={`${memberToolsLabel(a())} · ${autonomyLabel(a().autonomy)}`}
                    chevron
                    onPress={() => props.onOpen({ name: "member", id: a().id })}
                    testID={`member-${a().id}`}
                  />
                )}
              </Each>
              <SetRow label="New member" tone="accent" leading={<Icon name="plus" size={16} tint={colors.info} />} onPress={() => void props.settings.openMember()} testID="member-new" />
            </Section>
            <MemberEditor settings={props.settings} />
              <RoleLibrary hub={props.hub} onAdded={props.settings.accept} disabled={props.settings.saving() > 0} />
            <Section title="Projects" hint="The folders the team works in. In chat, name a project and the work happens in its folder.">
              <ProjectRows settings={props.settings} />
            </Section>
            <Section title="Routines" hint="Things the team does on its own schedule.">
              <Each of={e().routines} key={(r) => r.name}>
                {(r, i) => (
                  <SetRow
                    first={i() === 0}
                    label={r().name}
                    detail={r().agent}
                    value={routineValue(r())}
                    chevron
                    onPress={() => props.onOpen({ name: "routine", routine: r().name })}
                    testID={`routine-row-${r().name}`}
                  />
                )}
              </Each>
              <SetRow first={!e().routines.length} label="New routine" tone="accent" leading={<Icon name="plus" size={16} tint={colors.info} />} onPress={() => void props.settings.openRoutine()} testID="routine-new" />
            </Section>
            <RoutineEditor settings={props.settings} />
            <Section title="Parallel" hint="Fleet default, 1 to 32. A machine’s own run settings take precedence.">
              <SetRow
                first
                label="At once"
                trailing={
                  <ParallelInput value={e().max_parallel ?? 2} onChange={(value) => save(patches.maxParallel(value))} />
                }
              />
            </Section>
          </View>
        )}
      </If>
      <Section title="AI tools and learning">
        <SetRow first label="AI tools & onboarding" chevron onPress={() => props.onOpen({ name: "configuration", section: "onboarding" })} testID="settings-onboarding" />
      </Section>
      <Section title="Team defaults" hint="Owner attribution, approvals, models, tool blocks, scheduling and resources.">
        <SetRow first label="Team configuration" chevron onPress={() => props.onOpen({ name: "configuration" })} testID="settings-configuration" />
      </Section>
      <Section title="Commands" hint="Type / in the composer to use one. Built-in commands perform an action; the ones you add send a message to the team.">
        <CommandRows settings={props.settings} />
      </Section>
      <Section title="Image retention" hint={MEDIA_HINT}>
        <MediaDaysChoices settings={props.settings} />
      </Section>
      <Section title="Version" hint="The code each machine runs. Updating makes every machine pull the latest code, and the main machine also redeploys online.">
        <VersionRows hub={props.hub} />
      </Section>
      <Section title="Account" hint="Your sign-in is kept on this device and reconnects automatically next time.">
        <SetRow
          first
          leading={<Dot tone={props.hub.conn() === "live" ? "on" : props.hub.conn() === "unauthorized" ? "bad" : "wait"} />}
          label={props.hub.cfg.url.replace(/^https?:\/\//, "")}
        />
        <SetRow label="Sign out" tone="danger" onPress={() => void logout()} testID="logout" inset={0} />
      </Section>
    </Grouped>
  );
}

/** Notifications on a phone: this device, what is pushed, and the quiet hours. */
function PhoneNotify(props: { push: Push; settings: Settings }) {
  const push = props.push;
  const { view, save } = props.settings;
  const notify = notifyModel(push, view, save);
  return (
    <Grouped testID="phone-notify" settings={props.settings}>
      <Section title="This device" hint="Once on, important messages are pushed to this device.">
        <SetRow first label={push.info()?.device ?? "This device"} trailing={<Text testID="push-state" style={{ fontSize: 16, color: colors.muted }}>{notify.short()}</Text>} />
        <If
          when={push.info()?.subscribed}
          else={<SetRow label="Turn on notifications" tone="accent" disabled={!push.canAsk() || push.busy()} onPress={push.enable} testID="push-enable" />}
        >
          <SetRow label="Send test notification" tone="accent" disabled={push.busy()} onPress={push.test} testID="push-test" />
          <SetRow label="Turn off for this device" tone="danger" onPress={push.disable} testID="push-disable" />
        </If>
      </Section>
      <If when={push.note()}>
        <Text testID="push-note" style={{ marginTop: -20, paddingHorizontal: 32, fontSize: 13, color: push.note()!.tone === "ok" ? colors.up : colors.danger }}>{push.note()!.text}</Text>
      </If>
      <If when={push.needsHomeScreen()}>
        <Section title="Turn on notifications on iPhone">
          <View style={{ padding: 16 }}>
            <Steps steps={["In Safari, tap the Share button at the bottom", "Choose Add to Home Screen, then tap Add", "Open Noop from the Home Screen, sign in, and come back here to tap Turn on notifications"]} />
          </View>
        </Section>
      </If>
      <If when={push.info()?.permission === "denied" && !push.needsHomeScreen()}>
        <Text style={{ paddingHorizontal: 32, fontSize: 13, lineHeight: 18, color: colors.muted }}>{`${notify.state()}: allow Noop in your browser's site settings (or System Settings → Notifications), then reload the page and turn it on.`}</Text>
      </If>
      <If when={view()}>
        <Section title="What to push">
          <Each of={NOTIFY_KINDS as unknown as [NotifyKind, string][]}>
            {(k, i) => (
              <SetRow
                first={i() === 0}
                label={k()[1]}
                trailing={
                  <Toggle
                    testID={`notify-${k()[0]}`}
                    label={k()[1]}
                    value={notify.prefs().kinds[k()[0]]}
                    onChange={(on) => notify.setPrefs({ kinds: { ...notify.prefs().kinds, [k()[0]]: on } })}
                  />
                }
              />
            )}
          </Each>
        </Section>
        <Section title="Quiet hours" hint={`Recorded but not pushed during this time (time zone ${notify.prefs().tz}).`}>
          <Choices
            label="Quiet hours"
            choices={QUIET_PRESETS.map((q) => ({ id: quietKey(q.value), label: q.label, testID: `quiet-${quietKey(q.value)}` }))}
            selected={quietKey(notify.prefs().quiet_hours)}
            onPick={(id) => notify.setPrefs({ quiet_hours: QUIET_PRESETS.find((q) => quietKey(q.value) === id)!.value })}
          />
          <View style={{ padding: 16 }}><NotificationTimeZone prefs={notify.prefs} save={notify.setPrefs} /></View>
        </Section>
      </If>
    </Grouped>
  );
}

/** A member on a phone: its models and its autonomy. */
function PhoneMember(props: { id: string; settings: Settings; onGone: () => void }) {
  const { view, save } = props.settings;
  const agent = () => view()?.effective.agents.find((a) => a.id === props.id);
  return (
    <Grouped testID="phone-member" settings={props.settings}>
      <If when={agent()} else={<Text style={{ paddingHorizontal: 32, fontSize: 14, color: colors.faint }}>No such member</Text>}>
        {(a) => (
          <>
            <Section hint={a().about}>
              <SetRow first label="Role and instructions" chevron onPress={() => void props.settings.openMember(props.id)} testID={`member-edit-${props.id}`} />
            </Section>
            <MemberEditor settings={props.settings} onGone={props.onGone} />
            <Section title="Task tools">
              <TaskToolPolicy settings={props.settings} agent={props.id} phone />
            </Section>
            <Section title="Autonomy" hint="How much needs your approval first.">
              <MemberAutonomyPolicy settings={props.settings} agent={props.id} phone />
            </Section>
          </>
        )}
      </If>
    </Grouped>
  );
}

/** A routine on a phone: on or off, and how often. */
function PhoneRoutine(props: { name: string; settings: Settings; onGone: () => void }) {
  const { view, save } = props.settings;
  const routine = () => view()?.effective.routines.find((r) => r.name === props.name);
  return (
    <Grouped testID="phone-routine" settings={props.settings}>
      <If when={routine()} else={<Text style={{ paddingHorizontal: 32, fontSize: 14, color: colors.faint }}>No such routine</Text>}>
        {(r) => (
          <>
            <Section hint={[r().desc, r().agent && `Run by ${r().agent}.`].filter(Boolean).join("\n")}>
              <SetRow
                first
                label="Enabled"
                trailing={<Toggle testID={`routine-${props.name}`} label="Enabled" value={r().enabled} onChange={(on) => save(patches.routine(props.name, { enabled: on }))} />}
              />
            </Section>
            <Section>
              <SetRow first label="Edit routine" chevron onPress={() => void props.settings.openRoutine(props.name)} testID={`routine-edit-${props.name}`} />
            </Section>
            <RoutineEditor settings={props.settings} onGone={props.onGone} />
            <Section title="Run interval">
              <Choices
                label="Run interval"
                choices={intervalsWith(r().every).map((iv) => ({ id: iv, label: everyLabel(iv), testID: `every-${props.name}-${iv}` }))}
                selected={r().every}
                onPick={(iv) => save(patches.routine(props.name, { every: iv }))}
              />
            </Section>
          </>
        )}
      </If>
    </Grouped>
  );
}

// ---------------------------------------------------------------- the team's rules and memory

/** Memory: policies, the owner's memory, each agent's profile and memory, closed decisions. */
function RulesList(props: { hub: Hub; onOpen: (path: string) => void }) {
  const groups = signal<RuleGroup[] | null>(null);
  const error = signal("");
  const adding = signal(false), folder = signal("policies"), name = signal("");
  const create = () => {
    const path = `${folder()}/${name().trim()}.md`;
    if (!/^[a-zA-Z0-9][\w-]{0,79}$/.test(name().trim()) || !editableDocument(path)) { error.set("Use letters, numbers and hyphens for the document name."); return; }
    props.onOpen(path);
  };
  void (async () => {
    const lists: Record<string, DataFile[]> = {};
    for (const pre of RULE_PREFIXES) {
      const r = await props.hub.api("GET", `/api/files/list?prefix=${encodeURIComponent(pre)}`);
      if (!r.ok) { error.set(r.status ? `Couldn't load (${r.status})` : "can't reach the server"); return; }
      lists[pre] = (r.data.files as DataFile[] | undefined) ?? [];
    }
    groups.set(groupRules(lists));
  })();
  return (
    <Grouped testID="rules">
      <Text style={{ paddingHorizontal: 32, fontSize: 13, lineHeight: 18, color: colors.muted }}>The rules and memory the team works by. You can edit rules, preferences and member memory. Member profiles are managed in Members; closed decisions are historical records.</Text>
      <View style={{ paddingHorizontal: 32, gap: 12 }}>
        <Btn testID="document-add" label="Add rule or preference" kind="ghost" onPress={() => adding.set(!adding())} />
        <If when={adding()}>
          <Dropdown testID="document-folder" label="Document type" value={folder() === "policies" ? "Team rule" : "My preference"} selected={folder()} onPick={(v) => folder.set(v)}
            options={[{ id: "policies", label: "Team rule", testID: "document-folder-policies" }, { id: "memory", label: "My preference", testID: "document-folder-memory" }]} />
          <Field testID="document-name" label="Name" value={name()} onChange={(v) => { name.set(v); error.set(""); }} hint="Letters, numbers and hyphens, for example review-checklist." />
          <Btn testID="document-create" label="Open editor" kind="primary" onPress={create} />
        </If>
        <If when={error()}><Text style={{ color: colors.danger }}>{error()}</Text></If>
      </View>
      <If when={groups()} else={<Text style={{ paddingHorizontal: 32, fontSize: 14, color: error() ? colors.danger : colors.faint }}>{error() || "Loading…"}</Text>}>
        {(gs) => (
          <Each of={gs()} key={(g) => g.key}>
            {(g) => (
              <Section title={g().title} hint={g().hint} testID={`rules-${g().key}`}>
                <If when={g().items.length} else={<SetRow first label="Nothing here yet" disabled />}>
                  <Each of={g().items} key={(it) => it.path}>
                    {(it, i) => (
                      <SetRow first={i() === 0} label={it().title} value={it().detail} chevron onPress={() => props.onOpen(it().path)} testID={`rule-${it().path}`} />
                    )}
                  </Each>
                </If>
              </Section>
            )}
          </Each>
        )}
      </If>
    </Grouped>
  );
}

/** Knowledge is edited against the primary's latest full content; its metadata stays untouched. */
function RuleDoc(props: { hub: Hub; path: string; wide: boolean }) {
  const text = signal<string | null>(null), original = signal<string | null>(null), draft = signal("");
  const error = signal(""), note = signal(""), editing = signal(false), busy = signal(false);
  const editable = editableDocument(props.path);
  async function edit() {
    busy.set(true); error.set(""); note.set("");
    const r = await props.hub.api("POST", "/api/documents", { path: props.path });
    if (r.ok && (r.data.content === null || typeof r.data.content === "string")) {
      original.set(r.data.content as string | null); text.set(documentBody(String(r.data.content ?? ""))); draft.set(documentBody(String(r.data.content ?? ""))); editing.set(true);
    } else error.set(String(r.data.error ?? "Update the hub and main machine to edit knowledge documents."));
    busy.set(false);
  }
  async function save() {
    const submitted = draft();
    busy.set(true); error.set(""); note.set("");
    const r = await props.hub.api("PUT", "/api/documents", { path: props.path, base: original(), content: submitted });
    if (r.ok && typeof r.data.content === "string") {
      original.set(r.data.content); text.set(documentBody(r.data.content));
      if (draft() === submitted) { editing.set(false); note.set("Saved. The team will use this document on its next sync."); }
      else note.set("Submitted version saved. You have additional unsaved edits.");
    } else error.set(String(r.data.error ?? "Couldn't save this document. Your draft is kept."));
    busy.set(false);
  }
  void props.hub.api("GET", `/api/files/read?path=${encodeURIComponent(props.path)}`).then((r) => {
    if (r.ok && typeof r.data.content === "string") text.set(documentBody(r.data.content));
    else if (r.status === 404 && editable) void edit();
    else error.set(r.status === 404 ? "This file no longer exists." : r.status ? `Couldn't load (${r.status})` : "can't reach the server");
  });
  return (
    <Scroll testID="rule-doc" style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", gap: 12, paddingHorizontal: props.wide ? 32 : 16, paddingTop: 20, paddingBottom: Math.max(32, safeArea().bottom + 16) }}>
        <Text style={{ fontFamily: MONO, fontSize: 12.5, color: colors.faint }}>{props.path}</Text>
        <If when={editing()} else={<>
          <If when={editable}><Btn testID="document-edit" label="Edit document" kind="ghost" disabled={busy()} onPress={() => void edit()} /></If>
          <If when={text() !== null} else={<Text style={{ fontSize: 14, color: colors.faint }}>{busy() ? "Loading…" : ""}</Text>}>
            <If when={(text() ?? "").trim()} else={<Text style={{ fontSize: 14, color: colors.faint }}>(empty file)</Text>}>
              <View selectable><Rich text={text() ?? ""} /></View>
            </If>
          </If>
        </>}>
          <TextArea testID="document-content" label="Markdown" value={draft()} onChange={(v) => draft.set(v)} height={360} hint="Edit the document text. Existing metadata is preserved. Maximum 64 KB." />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
            <Btn testID="document-save" label="Save document" kind="primary" busy={busy()} disabled={busy()} onPress={() => void save()} />
            <Btn testID="document-reload" label="Discard draft and load latest" kind="ghost" disabled={busy()} onPress={() => void edit()} />
            <Btn testID="document-cancel" label="Cancel editing" kind="ghost" disabled={busy()} onPress={() => { editing.set(false); error.set(""); }} />
          </View>
        </If>
        <If when={error()}><Text testID="document-error" style={{ color: colors.danger }}>{error()}</Text></If>
        <If when={note()}><Text testID="document-note" style={{ color: colors.up }}>{note()}</Text></If>
      </View>
    </Scroll>
  );
}

// ---------------------------------------------------------------- commands ("/" in the composer)

/** The commands a "/" draft matches, above the composer. While it shows, Up / Down (and Ctrl+P / Ctrl+N) move the
 * pick, Tab or Return runs it, Escape closes the list (clearing the "/"). */
function CommandList(props: {
  items: CommandItem[];
  selected: number;
  touch: boolean;
  onHover: (i: number) => void;
  onMove: (delta: number) => void;
  onRun: (c: CommandItem) => void;
  onClose: () => void;
  onManage: () => void;
}) {
  const run = () => { const c = props.items[props.selected]; if (c) props.onRun(c); };
  keymap.bind(
    { up: () => props.onMove(-1), down: () => props.onMove(1), "ctrl+p": () => props.onMove(-1), "ctrl+n": () => props.onMove(1), tab: run, escape: props.onClose },
    { when: "always", repeat: true },
  );
  return (
    <View
      testID="commands"
      role="menu"
      accessibilityLabel="Commands"
      style={{ width: "100%", maxWidth: 380, borderRadius: radius.card, borderCurve: "continuous", borderWidth: 0.5, borderColor: surfaceEdge(), backgroundColor: colors.surface, padding: 4, overflow: "hidden" }}
    >
      <Each of={props.items} key={(c) => c.id}>
        {(c, i) => (
          <View
            testID={`command-${c().id}`}
            role="menuitem"
            accessibilityLabel={c().name}
            accessibilityState={{ selected: i() === props.selected }}
            onPress={() => props.onRun(c())}
            onMouseEnter={() => props.onHover(i())}
            style={{ flexDirection: "row", alignItems: "center", gap: 10, height: 34, paddingHorizontal: 10, borderRadius: 8, backgroundColor: i() === props.selected ? colors.raised : undefined }}
          >
            <Text style={{ flexShrink: 0, maxWidth: 180, fontSize: 14.5, fontWeight: "500", color: colors.text, numberOfLines: 1 }}>{`/${c().name}`}</Text>
            <Text style={{ flex: 1, minWidth: 0, fontSize: 13, color: colors.faint, numberOfLines: 1 }}>{c().detail}</Text>
            <If when={i() === props.selected && !props.touch}>
              <Text style={{ fontSize: 12, color: colors.faint }}>↵</Text>
            </If>
          </View>
        )}
      </Each>
      <If when={!props.items.length}>
        <Text style={{ paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: colors.muted }}>No matching commands</Text>
      </If>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, height: 30, paddingHorizontal: 10, marginTop: 2, borderTopWidth: 0.5, borderTopColor: surfaceEdge() }}>
        <If when={!props.touch}>
          <Text style={{ flex: 1, fontSize: 12, color: colors.faint }}>↑↓ select · ↵ run · Esc close</Text>
        </If>
        <View testID="manage-commands" role="button" onPress={props.onManage} style={{ marginLeft: props.touch ? 0 : undefined }}>
          <Text style={{ fontSize: 12.5, color: colors.accent }}>Manage…</Text>
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- keyboard help

const SHORTCUTS: [string, string][] = [
  ["Enter", "Send"],
  ["Shift+Enter", "New line"],
  [`${keymap.label("mod+enter")}`, "Send (any time)"],
  [`/  ·  ${keymap.label("mod+k")}`, "Focus the composer"],
  [`1 – 9  ·  ${keymap.label("alt+1")}…`, "Choose an option on the current decision"],
  [`J / K  ·  ${keymap.label("alt+j")} / ${keymap.label("alt+k")}`, "Next / previous pending decision"],
  [`R  ·  ${keymap.label("alt+r")}`, "Reply to the current decision (other instructions)"],
  [`G  ·  ${keymap.label("alt+g")}`, "Jump to the latest message"],
  ["Esc", "Cancel reply / leave the composer / close"],
  [keymap.label("mod+,"), "Team settings"],
  [keymap.label("mod+b"), "Show / hide the sidebar"],
  [keymap.label("mod+shift+l"), "Switch light / dark"],
  ["?", "Shortcut list"],
];

/** The keyboard shortcuts, in a `Dialog`: Escape, the backdrop and the close button close it. */
function HelpSheet(props: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      testID="help"
      open={props.open}
      animation="fade"
      onOpenChange={({ open }) => !open && props.onClose()}
      backdropClass="bg-scrim"
      backdropTestID="help-backdrop"
      style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "box-none" }}
    >
      <View
        accessibilityLabel="Keyboard shortcuts"
        style={{
          width: "100%",
          maxWidth: 520,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
          overflow: "hidden",
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 20, paddingRight: 10, height: 56, borderBottomWidth: 0.5, borderBottomColor: surfaceEdge() }}>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: "600", color: colors.text }}>Keyboard shortcuts</Text>
          <ToolButton icon="close" label="Close" shortcut="Esc" onPress={props.onClose} />
        </View>
        <View style={{ paddingVertical: 8 }}>
          <Each of={SHORTCUTS}>
            {(s) => (
              <View style={{ flexDirection: "row", alignItems: "center", minHeight: 38, paddingHorizontal: 20, gap: 12 }}>
                <Text style={{ flex: 1, fontSize: 15, color: colors.text }}>{s()[1]}</Text>
                <View style={{ flexDirection: "row", gap: 4 }}>
                  <Each of={s()[0].split("  ·  ")}>{(k) => <Kbd k={k()} />}</Each>
                </View>
              </View>
            )}
          </Each>
        </View>
        <Text style={{ fontSize: 13, color: colors.faint, paddingHorizontal: 20, paddingBottom: 16 }}>Single-key shortcuts work outside the composer; while typing, use the Alt (⌥) combinations.</Text>
      </View>
    </Dialog>
  );
}

// ---------------------------------------------------------------- chat

/** The pages of the stack: the channel, what the sidebar opens, and settings with the pages it pushes on phones. */
type Route =
  | { name: "channel" }
  | { name: "team" }
  | { name: "archive" }
  | { name: "saved" }
  | { name: "task"; id: string }
  | { name: "plans" }
  | { name: "plan"; id: string }
  | { name: "host"; host: string }
  | { name: "notify" }
  | { name: "configuration"; section?: keyof typeof CONFIGURATION_GROUPS }
  | { name: "member"; id: string }
  | { name: "routine"; routine: string }
  | { name: "rules" }
  | { name: "tasks" }
  | { name: "doc"; path: string };
const CHANNEL: Route = { name: "channel" };

function Chat(props: { hub: Hub; openRef?: string | null; onConnection: () => void; onDisconnect: () => void }) {
  const hub = props.hub;
  const push = createPush(hub);
  const wide = () => windowSize().width >= WIDE;
  const drawer = signal(false);
  const drawerDragging = signal(false);
  const drawerVisible = signal(false);
  let drawerHideTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(drawerHideTimer));
  const drawerX = createAnimatedValue(0);
  const drawerWidth = () => Math.min(size.sidebar + 16, windowSize().width * 0.86);
  const drawerTranslate = () => drawerX.interpolate({ inputRange: [0, drawerWidth()], outputRange: [0, drawerWidth()] });
  const animateDrawer = (open: boolean) => {
    if (reduceMotion()) drawerX.set(open ? drawerWidth() : 0);
    else drawerX.timing(open ? drawerWidth() : 0, { duration: 200, easing: "easeOut" });
  };
  effect(() => {
    if (wide()) return;
    const open = drawer();
    clearTimeout(drawerHideTimer);
    if (open) drawerVisible.set(true);
    else drawerHideTimer = setTimeout(() => drawerVisible.set(false), reduceMotion() ? 0 : 200);
    animateDrawer(open);
  });
  const finishDrawerPan = (e: { cancelled: boolean; translation: { x: number } }) => {
    const wasOpen = untracked(drawer);
    const next = e.cancelled ? wasOpen : wasOpen ? e.translation.x > -45 : e.translation.x > 45;
    drawerDragging.set(false);
    if (next === wasOpen) animateDrawer(next);
    else drawer.set(next);
  };
  const sidebarOpen = signal(true);
  const setSidebarOpen = (open: boolean) => {
    if (open === untracked(sidebarOpen)) return;
    if (!reduceMotion()) LayoutAnimation.configureNext(LayoutAnimation.create(200, "easeInEaseOut"));
    sidebarOpen.set(open);
  };
  const help = signal(false);
  const settings = createSettings(hub);
  // The pages: the channel at the bottom, what the sidebar, a link or settings opened above it.
  const nav = createNavStack<Route>([CHANNEL]);
  const top = () => { const r = nav.routes(); return r[r.length - 1]; };
  const onChannel = () => nav.routes().length === 1;
  /** Shows a page over the channel, in place of the one shown (the sidebar's pages are siblings). */
  const show = (...routes: Route[]) => { drawer.set(false); nav.setRoutes([CHANNEL, ...routes]); };
  const openHost = (h: string) => show({ name: "host", host: h });
  /** A task: from a machine's page it goes on top (back returns to the machine), else in place. */
  const openTask = (id: string) => {
    const t = untracked(top);
    if (t.name === "host" || t.name === "tasks" || t.name === "plan") { drawer.set(false); nav.push({ name: "task", id }); }
    else show({ name: "task", id });
  };
  taskLink = openTask;
  planLink = (id) => show({ name: "plans" }, { name: "plan", id });
  const repos = computed(() => { const m = new Map<string, string>(); for (const e of props.hub.events()) reposIn(`${e.text}\n${(e.options ?? []).join("\n")}`, m); return m; });
  knownRepos = repos;
  taskState = (id) => { const s = props.hub.status(); return [...(s?.active ?? []), ...(s?.recent ?? [])].find((t) => t.id === id)?.state ?? (s?.active.some((t) => t.id === id) ? "active" : undefined); };
  /** A card being scrolled to (picked from the sidebar, a notification): entering the channel leaves the scroll to it. */
  let jumping: string | null = null;
  // Entering the channel (first load, back from a task or settings) shows the latest messages.
  effect(() => { if (onChannel() && !jumping) { atEnd.set(true); unseen.set(0); toEnd(); } });
  const draft = signal("");
  const replyTo = signal<string | null>(null);
  /** What the reply answers, for the chip ("Kai: nsh #812 mainly fixes…"); none for a decision (its id says it). */
  const replyNote = signal<string | null>(null);
  const focused = signal(false);
  const inputHeight = signal(28);
  const outbox = signal<Outgoing[]>([]);
  const atEnd = signal(true);
  const unseen = signal(0);
  const chosen = signal<string | null>(null);
  let seq = 0;

  /** The timeline: the hub's events and the messages on their way. */
  const shown = computed(() =>
    merge(
      hub.events().filter((e) => !e.thread && !(e.kind === "system" && e.text.startsWith("⚙️ Settings updated"))),
      outbox().map((o) => ({
        id: o.id, ts: o.ts, from: "owner", kind: "owner" as const, text: o.text, ref: o.ref ?? undefined,
        attachments: o.files.length ? o.files.map((f) => f.preview) : undefined,
      })),
    ),
  );
  const answered = computed(() => answeredIds(shown()));
  // "New messages": above the first event from others after what this device last saw.
  const seen = signal<string | null | undefined>(undefined);
  Storage.getItem(KEYS.seen).then((v) => seen.set(v ?? null));
  const divider = signal<string | null | undefined>(undefined);
  effect(() => {
    if (untracked(divider) !== undefined || !hub.loaded() || seen() === undefined) return;
    divider.set(firstUnread(shown(), seen() ?? null));
  });
  const timeline = computed((): (Row | { key: string; unread: true })[] => {
    const r = rows(shown());
    const d = divider();
    const at = d ? r.findIndex((x) => "event" in x && x.event.id === d) : -1;
    return at < 0 ? r : [...r.slice(0, at), { key: "unread", unread: true }, ...r.slice(at)];
  });
  const pending = computed(() => hub.events().filter((e) => isAsk(e) && !answered().has(e.ref!)));
  /** The pending ask the keys act on: the one picked (J / K, the sidebar), else the newest. */
  const target = computed(() => {
    const p = pending();
    const c = chosen();
    return p.find((e) => e.ref === c)?.ref ?? p[p.length - 1]?.ref ?? null;
  });
  const proposalSelection = new Map<string, Signal<Set<string>>>();
  let scroller: ListRef | undefined;
  let composer: InputRef | undefined;

  const toEnd = (animated = false) => setTimeout(() => scroller?.scrollToEnd({ animated }), 40);
  // The list follows its end by itself (alignment="bottom"); scrolled further up than AT_END, it stays put and this counts what came below.
  const AT_END = 24;
  let count = 0;
  effect(() => {
    const n = shown().length;
    const grew = n > count;
    count = n;
    if (grew && !untracked(atEnd)) unseen.update((u) => u + 1);
  });
  /** What the floating composer covers at the bottom of the timeline. */
  const composerHeight = signal(0);
  const jumpToEnd = () => {
    unseen.set(0);
    atEnd.set(true);
    toEnd(true);
  };

  const reply = (ref: string, note?: string) => {
    replyNote.set(note ?? null);
    replyTo.set(ref);
    if (!untracked(onChannel)) nav.popToRoot();
    composer?.focus();
  };

  // A message reads as sent at once but leaves a few seconds later,so Unsend (or Mod+Z) can still take it back.
  const UNDO_MS = 5000;
  const holds = new Map<string, ReturnType<typeof setTimeout>>();
  function send(text: string, ref: string | null, id = `local:${++seq}`, files: Attachment[] = []) {
    const ts = new Date().toISOString();
    const messageKey = newRequestKey();
    outbox.update((o) => [...o.filter((x) => x.id !== id), { id, messageKey, ts, text, ref, files, state: "held" }]);
    jumpToEnd();
    holds.set(id, setTimeout(() => { holds.delete(id); void deliver(id); }, UNDO_MS));
  }
  function deliverHeld() {
    return [...holds].map(([id, hold]) => {
      clearTimeout(hold);
      holds.delete(id);
      return deliver(id);
    });
  }
  // Leaving the app must not strand a message that already looks sent.
  effect(() => {
    if (lifecycle() !== "active") deliverHeld();
  });
  // An update restarts the app: what looks sent leaves first, and what is being typed comes back.
  async function restartToUpdate() {
    await Promise.allSettled(deliverHeld());
    while (outbox().length || attachments().length || replyTo()) {
      drawer.set(false);
      nav.popToRoot();
      jumpToEnd();
      const failed = new Set(outbox().filter((message) => message.state === "failed").map((message) => message.id));
      const canDismiss = failed.size === outbox().length && failed.size > 0 && !attachments().length && !replyTo();
      const result = await AlertDialog.show({
        title: "Review messages before updating",
        description: canDismiss
          ? "Some messages failed or their delivery is unconfirmed. Retry or inspect them in chat. Dismissing removes only the local retry messages; any tasks or plans already saved still exist."
          : "Messages are still awaiting confirmation, or your draft contains images or a reply. Finish sending, retry failed messages, or remove the images and cancel the reply before updating. Your messages and draft have been kept.",
        actions: [{ id: "review", label: "Back to chat", role: "cancel" },
          ...(canDismiss ? [{ id: "dismiss", label: "Dismiss failed messages and update", role: "destructive" as const }] : [])],
      });
      if (result.action !== "dismiss") return;
      if (outbox().some((message) => message.state !== "failed") || attachments().length || replyTo()) continue;
      outbox.update((messages) => messages.filter((message) => message.state !== "failed" || !failed.has(message.id)));
    }
    const savedDraft = draft();
    if (savedDraft) await Storage.setItem(KEYS.draft, savedDraft);
    if (outbox().length || attachments().length || replyTo() || draft() !== savedDraft) {
      drawer.set(false);
      nav.popToRoot();
      jumpToEnd();
      await AlertDialog.show({ title: "Messages changed before updating", description: "Your messages and draft have been kept. Review them in chat, then try updating again.", actions: [{ id: "review", label: "Back to chat", role: "cancel" }] });
      return;
    }
    await updates.install();
    await Storage.removeItem(KEYS.draft); // the install failed: this run still holds the draft
  }
  Storage.getItem(KEYS.draft).then((v) => {
    if (!v) return;
    if (!untracked(draft)) draft.set(v);
    void Storage.removeItem(KEYS.draft);
  });
  function undo(id?: string) {
    const o = id ? outbox().find((x) => x.id === id) : [...outbox()].reverse().find((x) => x.state === "held");
    if (!o || !holds.has(o.id)) return false;
    clearTimeout(holds.get(o.id));
    holds.delete(o.id);
    outbox.update((list) => list.filter((x) => x.id !== o.id));
    if (!/^(?:[DP]-[A-Z]?\d{4}|L-\d{4,}) \S+$/.test(o.text) || o.ref || o.files.length) {
      const current = untracked(draft), hasDraft = !!current.trim() || untracked(attachments).length > 0;
      const restored = hasDraft && o.ref && o.ref !== untracked(replyTo) ? `${o.ref}\n${o.text}` : o.text;
      draft.set([restored, current].filter(Boolean).join("\n\n"));
      if (!hasDraft) { replyNote.set(null); replyTo.set(o.ref); }
      attachments.update((a) => [...o.files, ...a]);
      composer?.focus();
    }
    return true;
  }
  async function deliver(id: string) {
    const o = outbox().find((x) => x.id === id);
    if (!o || o.state === "sending") return;
    const { text, ref, files } = o;
    outbox.update((l) => l.map((x) => (x.id === id ? { ...x, state: "sending" } : x)));
    try {
      await hub.send(text, ref, files, false, o.messageKey);
      outbox.update((o) => o.filter((x) => x.id !== id));
    } catch (error) {
      const failure = error as Error & { saved_locally?: boolean; id?: string };
      outbox.update((o) => o.map((x) => (x.id === id ? { ...x, state: "failed", error: failure.message ?? "Couldn't send the message", saved_locally: failure.saved_locally, savedId: failure.id } : x)));
    }
  }
  // Commands: a draft of "/<query>" lists the built-in and saved commands; Return runs the first one.
  const slash = () => slashQuery(draft());
  const commands = () => { const q = slash(); return q == null ? [] : commandItems(settings.view(), q).slice(0, 8); };
  /** The command Return runs: Up and Down move it, a new query starts it over at the first. */
  const cmdSel = signal(0);
  effect(() => { slash(); cmdSel.set(0); });
  const pickedCommand = () => commands()[Math.min(cmdSel(), commands().length - 1)];
  effect(() => { if (slash() != null && !untracked(settings.view)) settings.load(); });
  function runCommand(c: CommandItem) {
    draft.set("");
    inputHeight.set(28);
    if (c.action === "update-fleet") void updateAllMachines(hub);
    else if (c.text) void send(c.text, null);
  }

  function submit() {
    if (speech() !== "off") stopDictation(true);
    if (slash() != null && commands().length && !attachments().length) return runCommand(pickedCommand()!);
    const v = draft().trim();
    const files = attachments();
    if (!v && !files.length) return;
    // A bare choice ("1", "B", "1,3", "all") answers the decision the keyboard is on, never becomes a new task.
    const r = replyTo() ?? (!files.length && /^([1-9](\s*[,，]\s*[1-9])*|[A-Za-z]|all|none)$/i.test(v) ? target() : null);
    draft.set("");
    replyTo.set(null);
    attachments.set([]);
    attachNote.set(null);
    inputHeight.set(28);
    send(v, r, undefined, files);
  }

  // Images the owner attaches: pasted, dropped on the window, or picked.
  const attachments = signal<Attachment[]>([]);
  const attachNote = signal<string | null>(null);
  const dropping = signal(false);
  let attachSeq = 0;
  function attach(file: Blob, name: string, fromPicker = false) {
    // the photo picker only returns images, but phones often give them no type or extension; the server reads the bytes
    const type = imageType(file.type, name) ?? (fromPicker ? "image/jpeg" : null);
    const problem = attachProblem(type, file.size, attachments().length);
    if (problem) return attachNote.set(problem);
    attachNote.set(null);
    const typed = file.type === type ? file : new Blob([file], { type: type! });
    const preview = URL.createObjectURL(typed);
    attachments.update((a) => [...a, { id: `a${++attachSeq}`, name: name || `image-${attachSeq}.png`, type: type!, size: file.size, file: typed, preview }]);
  }
  function unattach(id: string) {
    const a = attachments().find((x) => x.id === id);
    if (a) URL.revokeObjectURL(a.preview);
    attachments.update((list) => list.filter((x) => x.id !== id));
    attachNote.set(null);
  }
  /** Local files (`file:` URLs from a drop or a file manager's copy): read the images among them. */
  async function attachUris(uris: string[]) {
    for (const u of uris) {
      const path = filePath(u);
      const name = path.split(/[\\/]/).pop() ?? "image";
      if (!imageType(undefined, name)) { attachNote.set("Only images can be sent"); continue; }
      try {
        const bytes = await fs.readFile(path);
        attach(new Blob([bytes as Uint8Array<ArrayBuffer>]), name);
      } catch {
        attachNote.set(`Can't read ${name}. Try Attach or paste the image.${platform.os === "macos" ? " Check Noop’s Files and Folders access in System Settings if this keeps happening." : " Check that Noop can access this folder."}`);
      }
    }
  }
  async function pickImages() {
    try {
      const picked = await Picker.pickImages({ multiple: true, limit: 10 });
      for (const p of picked) attach(p.file, p.file.name, true);
    } catch {
      attachNote.set("Can't pick images on this device");
    }
    composer?.focus();
  }
  // Dictation (voice input): nsh's Speech in the native apps, the browser's speech recognition (through
  // host.js) on the web. Its words land in the composer where the caret was (or at the end), live as
  // they are heard; nothing is sent. Where there is neither, there is no button.
  const canDictate = signal(false);
  const speech = signal<"off" | "on" | "stopping">("off");
  let native = false;
  let session: SpeechSession | null = null;
  void Speech.available()
    .catch(() => false)
    .then(async (ok) => {
      native = ok;
      canDictate.set(ok || !!(await hostCall<{ supported: boolean }>("speechState"))?.supported);
    });
  let caret: { start: number; end: number } | null = null;
  let before = "";
  let after = "";
  let dictated = ""; // the draft as dictation last left it: anything else is the owner typing
  /** The recognizer's language: the device locale, else US English. */
  const speechLang = () => String(locale() ?? "") || "en-US";
  const speechError = (e: string) =>
    e === "not-allowed" || e === "service-not-allowed" ? (native ? "No microphone or speech recognition permission; allow it in system settings" : "No microphone permission; allow the microphone in browser settings")
      : e === "no-speech" ? "No speech heard"
      : e === "audio-capture" ? "No microphone found"
      : e === "network" ? "Speech recognition needs a network connection"
      : e === "language-not-supported" ? "This device doesn't support speech recognition in this language"
      : e === "unavailable" ? "Voice input isn't available on this device"
      : "Voice input failed";
  /** The whole transcript so far (final and still-being-heard words). */
  const heard = (text: string) => {
    if (untracked(speech) === "off") return;
    const words = text.trim();
    // a space between Latin words, none in Chinese
    const gap = /[A-Za-z0-9.,!?;:]$/.test(before) && /^[A-Za-z0-9]/.test(words) ? " " : "";
    const head = before + gap + words;
    dictated = head + after;
    draft.set(dictated);
    composer?.setSelection(head.length, head.length);
  };
  const ended = (error?: string | null) => {
    if (untracked(speech) === "off") return;
    speech.set("off");
    if (error) attachNote.set(speechError(error));
  };
  async function startDictation() {
    const v = draft();
    const start = Math.min(caret?.start ?? v.length, v.length);
    const end = Math.min(Math.max(caret?.end ?? v.length, start), v.length);
    before = v.slice(0, start);
    after = v.slice(end);
    dictated = v;
    attachNote.set(null);
    speech.set("on");
    if (native) {
      try {
        const s = Speech.start({ lang: speechLang() });
        session = s;
        s.on("result", (r) => session === s && heard(r.text));
        s.on("end", (e) => {
          if (session !== s) return;
          session = null;
          ended(e.error);
        });
      } catch {
        session = null;
        speech.set("off");
        attachNote.set("Couldn't start voice input");
      }
      return;
    }
    if (!(await hostCall("speechStart", { lang: speechLang() })) && untracked(speech) === "on") {
      speech.set("off");
      attachNote.set("Couldn't start voice input");
    }
  }
  /** Stop listening: the words still being heard arrive first, unless `drop` (the draft was sent or edited). */
  function stopDictation(drop = false) {
    if (drop) {
      speech.set("off");
      if (session) { const s = session; session = null; s.abort(); }
      else void hostCall("speechAbort");
    } else {
      speech.set("stopping");
      if (session) session.stop();
      else void hostCall("speechStop");
    }
  }
  /** The mic / stop button: start, stop (keeping the words), and if the recognizer hangs while finishing, a second press ends it. */
  const toggleDictation = () => (speech() === "off" ? void startDictation() : stopDictation(speech() === "stopping"));
  if (host.available()) {
    host.on("speech", (p) => heard(String((p as { text?: string })?.text ?? "")));
    host.on("speechEnd", (p) => ended((p as { error?: string })?.error));
  }
  cleanup(() => {
    if (untracked(speech) !== "off") stopDictation(true);
  });

  const canSend = () => !!draft().trim() || attachments().length > 0;
  const compactComposer = () => !focused() && !draft() && !attachments().length && !replyTo();
  const answer = (ref: string, c: string) => {
    clearNotification(ref);
    return send(`${ref} ${c}`, null);
  };

  function pick(ref: string) {
    drawer.set(false);
    // set before the channel comes back: entering it would otherwise scroll to the latest messages, over this card
    jumping = ref;
    atEnd.set(false);
    const back = !untracked(onChannel);
    nav.popToRoot();
    chosen.set(ref);
    clearNotification(ref);
    // back from another page the channel lays out first
    setTimeout(() => toCard(ref, 4), back ? 120 : 0);
  }
  /** Virtualized cards can be off screen; locate the row by identity instead of measuring a view. */
  function toCard(ref: string, tries: number) {
    const index = timeline().findIndex((row) => "event" in row && row.event.ref === ref && isAsk(row.event));
    if (index >= 0 && scroller) {
      scroller.scrollToIndex({ index, animated: true, viewOffset: 24 });
      if (jumping === ref) jumping = null;
    } else if (tries > 0 && !scroller) {
      setTimeout(() => toCard(ref, tries - 1), 80);
    } else {
      if (jumping === ref) jumping = null;
      if (pending().some((e) => e.ref === ref)) reply(ref);
    }
  }

  // Opened from a notification (`?ref=`), or one clicked while the app is open: show that event.
  let openRef = props.openRef ?? null;
  effect(() => {
    const loaded = hub.loaded();
    if (!openRef || !loaded) return;
    const ref = openRef;
    openRef = null;
    setTimeout(() => pick(ref), 300);
  });
  if (host.available()) {
    host.on("open", (p) => {
      const ref = (p as { ref?: string | null } | null)?.ref;
      if (ref) setTimeout(() => pick(ref), 50);
    });
  }
  // The app's badge and the page's title count the decisions waiting. iOS needs the permission, so it follows that too.
  effect(() => {
    const n = pending().length;
    push.info();
    if (hub.loaded()) setBadge(n);
  });
  if (systemNotifications()) {
    // A press can start the app; before the timeline loads the effect above opens it.
    cleanup(Notifications.on("press", ({ id }) => {
      if (id.startsWith("noop:")) return;
      if (untracked(hub.loaded)) setTimeout(() => pick(id), 50);
      else openRef = id;
    }));
    // Back in the app: the owner may have changed the permission in the system's settings.
    effect(() => {
      if (lifecycle() === "active") void push.refresh();
    });
    // While the app is not in front, what would reach a browser as Web Push shows as a system notification.
    let latest: string | null = null;
    effect(() => {
      const evs = hub.events();
      if (!hub.loaded()) return;
      const last = evs[evs.length - 1]?.ts ?? "";
      if (latest === null) {
        latest = last;
        return;
      }
      const since: string = latest;
      const fresh = evs.filter((e) => e.ts > since);
      if (!fresh.length) return;
      latest = last;
      if (untracked(lifecycle) === "active" || !untracked(push.info)?.subscribed) return;
      void hub.api("GET", "/api/settings").then((r) => {
        const prefs = (r.data.current as { notify_prefs?: NotifyRules } | undefined)?.notify_prefs ?? {};
        // Waking from sleep can bring many: the latest few say enough, the badge counts the rest.
        for (const e of fresh.slice(-5)) {
          const note = notificationFor(e, prefs);
          if (!note) continue;
          const id = e.ref ?? `noop:${e.kind}`;
          showing.add(id);
          void Notifications.show({ id, ...note });
        }
      });
    });
    // Answered, here or on another device: the notification has done its job.
    effect(() => {
      const done = answered();
      for (const id of [...showing]) if (done.has(id)) closeNotification(id);
    });
  }
  // This device has seen what reached the bottom.
  effect(() => {
    const evs = shown();
    if (!atEnd() || !evs.length || divider() === undefined) return;
    Storage.setItem(KEYS.seen, evs[evs.length - 1].ts);
  });
  // A new decision while the app is open: a quiet toast and a short vibration.
  const toast = signal<{ ref: string; text: string } | null>(null);
  let known: Set<string> | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(toastTimer));
  effect(() => {
    const asks = pending();
    if (!hub.loaded()) return;
    if (!known) {
      known = new Set(asks.map((e) => e.ref!));
      return;
    }
    const fresh = asks.filter((e) => !known!.has(e.ref!));
    for (const e of asks) known.add(e.ref!);
    if (!fresh.length) return;
    const e = fresh[fresh.length - 1];
    toast.set({ ref: e.ref!, text: e.text.split("\n")[0].replace(/[*`]/g, "").slice(0, 80) });
    hostCall("vibrate");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.set(null), 6000);
  });
  /** J / K: the next or the previous pending ask, scrolled into view. */
  function step(by: number) {
    const p = pending();
    if (!p.length) return;
    const at = p.findIndex((e) => e.ref === target());
    const next = p[Math.max(0, Math.min(p.length - 1, (at < 0 ? p.length - 1 : at) + by))];
    pick(next.ref!);
  }
  function choose(n: number) {
    const ref = target();
    const e = pending().find((x) => x.ref === ref);
    if (!e || !onChannel()) return;
    const c = choicesOf(e)[n];
    if (c) answer(e.ref!, c);
  }
  /** Memory: from the sidebar in place; from settings on top (back returns to settings). */
  const openRules = (fromSettings = false) => {
    if (fromSettings) { drawer.set(false); nav.push({ name: "rules" }); }
    else show({ name: "rules" });
  };
  const openTeam = () => {
    if (untracked(top).name === "team") { drawer.set(false); nav.popToRoot(); }
    else show({ name: "team" });
  };

  // Shortcuts. Single keys never fire while typing (`notEditing`).
  keymap.bind("mod+enter", submit, { when: "always" });
  keymap.bind("mod+k", () => composer?.focus(), { when: "always" });
  keymap.bind("mod+z", () => { if (!draft()) undo(); }, { when: "always" });
  keymap.bind("mod+,", openTeam, { when: "always" });
  keymap.bind("mod+b", () => setSidebarOpen(!untracked(sidebarOpen)), { when: "always" });
  keymap.bind("mod+shift+l", toggleTheme, { when: "always" });
  keymap.bind(
    {
      "/": () => composer?.focus(),
      "shift+/": () => help.set(!untracked(help)),
      j: () => step(1),
      k: () => step(-1),
      r: () => target() && reply(target()!),
      g: jumpToEnd,
      "shift+g": jumpToEnd,
      ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 1), () => choose(i)])),
    },
    { when: "notEditing" },
  );
  // The same moves with Alt work while typing, so the cursor never has to leave the composer.
  keymap.bind(
    {
      "alt+j": () => step(1),
      "alt+k": () => step(-1),
      "alt+r": () => target() && reply(target()!),
      "alt+g": jumpToEnd,
      ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`alt+${i + 1}`, () => choose(i)])),
    },
    { when: "always" },
  );
  keymap.bind("escape", () => {
    if (help()) help.set(false);
    else if (drawer()) drawer.set(false);
    else if (replyTo()) replyTo.set(null);
    else if (focused()) composer?.blur();
    else if (nav.routes().length > 1) nav.pop();
  }, { when: "always" });

  const connLabel = () => ({ connecting: "Connecting…", live: "Live", offline: "Disconnected, reconnecting…", unauthorized: "Session expired" })[hub.conn()];
  const connTone = () => (hub.conn() === "live" ? "on" : hub.conn() === "unauthorized" ? "bad" : hub.conn() === "offline" ? "wait" : "off");
  const sidebar = (inDrawer: boolean) => (
    <Sidebar
      onRestart={() => void restartToUpdate()}
      hub={hub}
      target={target}
      onPick={pick}
      onIgnore={(ref) => void answer(ref, IGNORE)}
      task={() => { const t = top(); return t.name === "task" ? t.id : null; }}
      onTask={openTask}
      machine={() => { const t = top(); return t.name === "host" ? t.host : null; }}
      onMachine={openHost}
      onSettings={openTeam}
      rules={() => { const n = top().name; return n === "rules" || n === "doc"; }}
      onRules={() => openRules()}
      tasks={() => top().name === "tasks"}
      onTasks={() => show({ name: "tasks" })}
      plan={() => { const t = top(); return t.name === "plan" ? t.id : null; }}
      plans={() => top().name === "plans"}
      onPlans={() => show({ name: "plans" })}
      onPlan={(id) => show({ name: "plans" }, { name: "plan", id })}
      onHelp={() => help.set(true)}
      onClose={inDrawer ? () => drawer.set(false) : undefined}
      chrome={!inDrawer}
      onCollapse={inDrawer ? undefined : () => setSidebarOpen(false)}
      home={onChannel}
      onHome={() => { drawer.set(false); nav.popToRoot(); }}
    />
  );
  /** The channel: the timeline and the composer. */
  const channelPage = () => (
      <View testID="channel-swipe" pan={!wide() && !drawer() ? { x: drawerX } : undefined}
        onPanStart={() => { if (!wide() && !drawer()) drawerDragging.set(true); }}
        onPanEnd={finishDrawerPan}
        style={{ flex: 1, backgroundColor: colors.background, paddingBottom: keyboardFrame().height, transitionProperty: "padding-bottom", transitionDuration: keyboardFrame().duration }}>
          {/* Files dropped on the timeline or the composer attach their images. */}
          <View
            testID="composer-area"
            onFileDragEnter={() => dropping.set(true)}
            onFileDragLeave={() => dropping.set(false)}
            onFileDrop={({ uris }) => { dropping.set(false); void attachUris(uris); }}
            style={{ flex: 1 }}
          >
            <List
              testID="timeline"
              each={timeline()}
              alignment="bottom"
              maintainVisibleContentPosition={{ autoscrollToBottomThreshold: AT_END }}
              estimatedItemSize={120}
              contentStyle={{ paddingTop: wide() ? 24 : 12, paddingBottom: composerHeight() + 16 }}
              keyExtractor={(row) => row.key}
              ref={(r) => { scroller = r; }}
              onTouchStartCapture={() => { if (platform.os === "macos" && focused()) composer?.blur(); }}
              style={{ flex: 1 }}
              scrollEventThrottle={100}
              keyboardShouldPersistTaps="handled"
              onScroll={(ev) => {
                const end = ev.contentSize.height - ev.offset.y - ev.size.height <= AT_END;
                if (end !== untracked(atEnd)) atEnd.set(end);
                if (end) unseen.set(0);
              }}
              empty={() => <View style={{ width: "100%", maxWidth: size.column + gutter() * 2, alignSelf: "center", paddingHorizontal: gutter(), paddingTop: wide() ? 24 : 12, paddingBottom: composerHeight() + 16 }}>
                <If when={!hub.loaded()}>
                  <View style={{ alignItems: "center", paddingTop: 120, gap: 14 }}>
                    <Spinner size={22} tint={colors.muted} />
                    <Text style={{ fontSize: 15, color: colors.muted }}>Loading the channel…</Text>
                  </View>
                </If>
                <If when={hub.loaded() && shown().length === 0}>
                  <View style={{ alignItems: "center", paddingTop: wide() ? 120 : 64, paddingBottom: 32, gap: 12 }}>
                    <Mark size={44} />
                    <Text style={{ fontSize: 30, fontWeight: "600", color: colors.text, letterSpacing: -0.4 }}>{greeting()}</Text>
                    <Text style={{ fontSize: 16, lineHeight: 24, color: colors.muted, textAlign: "center" }}>The team works in the background. Anything that needs your decision shows up here.</Text>
                    <If when={!touch}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 }}>
                        <Kbd k="/" />
                        <Text style={{ fontSize: 14, color: colors.faint }}>Start typing</Text>
                        <View style={{ width: 12 }} />
                        <Kbd k="?" />
                        <Text style={{ fontSize: 14, color: colors.faint }}>All shortcuts</Text>
                      </View>
                    </If>
                  </View>
                </If>
              </View>}
            >
              {(item) => (
                <View style={{ width: "100%", maxWidth: size.column + gutter() * 2, alignSelf: "center", paddingHorizontal: gutter() }}>
                <Each of={[item()]} key={(r) => r.key}>
                  {(r) => {
                    const row = r();
                    if ("unread" in row) {
                      return (
                        <View testID="unread" style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 16, marginBottom: 4 }}>
                          <View style={{ flex: 1, height: 1, backgroundColor: alpha(colors.danger, 0.4) }} />
                          <Text style={{ fontSize: 13, fontWeight: "600", color: colors.danger }}>New messages</Text>
                          <View style={{ flex: 1, height: 1, backgroundColor: alpha(colors.danger, 0.4) }} />
                        </View>
                      );
                    }
                    if ("day" in row) {
                      return (
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 24, marginBottom: 8 }}>
                          <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
                          <Text style={{ fontSize: 13, fontWeight: "500", color: colors.faint }}>{dayLabel(row.day)}</Text>
                          <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
                        </View>
                      );
                    }
                    if (row.event.kind === "owner") {
                      const out = () => outbox().find((o) => o.id === row.event.id);
                      return <OwnerBubble hub={hub} event={row.event} out={out()} onRetry={() => void deliver(row.event.id)} onRecall={() => undo(row.event.id)} onRef={pick} onInspect={(id) => id.startsWith("PL-") ? show({ name: "plans" }, { name: "plan", id }) : openTask(id)} />;
                    }
                    return (
                      <Message
                        hub={hub}
                        event={row.event}
                        answered={answered}
                        target={target}
                        onAnswer={answer}
                        onReply={reply}
                        selection={proposalSelection}
                      />
                    );
                  }}
                </Each>
                </View>
              )}
            </List>

            <If when={!atEnd() && shown().length > 0}>
              <View style={{ position: "absolute", left: 0, right: 0, bottom: composerHeight() + 4, paddingVertical: 4, alignItems: "center", pointerEvents: "box-none" }}>
                <View
                  role="button"
                  accessibilityLabel="Jump to latest"
                  onPress={jumpToEnd}
                  hoverStyle={{ opacity: 0.92 }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    height: 38,
                    paddingHorizontal: 16,
                    ...glass(unseen() ? colors.accentFill : colors.surface, 19),
                    backgroundColor: platform.os === "linux" || (platform.os === "android" && Number(platform.version) < 31)
                      ? (unseen() ? colors.accentFill : colors.surface)
                      : (unseen() ? alpha(colors.accentFill, 0.85) : alpha(colors.surface, 0.25)),
                    borderWidth: platform.os === "ios" || platform.os === "macos" ? 0 : 1,
                    boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
                  }}
                >
                  <Icon name="arrow-down" size={15} tint={unseen() ? colors.onAccent : colors.text} />
                  <Text style={{ fontSize: 14, fontWeight: "600", color: unseen() ? colors.onAccent : colors.text }}>
                    {unseen() ? `${unseen()} new message${unseen() === 1 ? "" : "s"}` : "Jump to latest"}
                  </Text>
                  <If when={!touch}>
                    <Text style={{ fontSize: 12, color: unseen() ? alpha(colors.onAccent, 0.7) : colors.faint }}>G</Text>
                  </If>
                </View>
              </View>
            </If>

          {/* The composer floats over the timeline, which scrolls on under its glass. */}
          <View
            onLayout={({ bounds }) => composerHeight.set(bounds.size.height)}
            style={{ position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: wide() ? 32 : 10, paddingTop: 4, paddingBottom: keyboardFrame().height > 0 ? 8 : Math.max(12, safeArea().bottom + 8), transitionProperty: "padding-bottom", transitionDuration: keyboardFrame().duration, pointerEvents: "box-none" }}
          >
            <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", gap: 8, pointerEvents: "box-none" }}>
              <If when={hub.conn() === "offline" || hub.conn() === "unauthorized"}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    borderRadius: radius.inset,
                    // over the timeline: the tint needs a solid base, or the messages show through
                    backgroundColor: colors.surface,
                    backgroundImage: `linear-gradient(${hub.conn() === "unauthorized" ? tints.danger : tints.warn}, ${hub.conn() === "unauthorized" ? tints.danger : tints.warn})`,
                  }}
                >
                  <Text style={{ flex: 1, fontSize: 14, color: hub.conn() === "unauthorized" ? colors.danger : colors.warn }}>
                    {hub.conn() === "unauthorized" ? "Your session expired. Please sign in again." : "Lost the connection to Noop; reconnecting automatically…"}
                  </Text>
                  <If when={hub.conn() === "unauthorized"}>
                    <Btn label="Sign in again" kind="danger" onPress={props.onConnection} />
                  </If>
                </View>
              </If>
              <If when={slash() != null}>
                <CommandList
                  items={commands()}
                  selected={commands().indexOf(pickedCommand()!)}
                  touch={touch}
                  onHover={(i) => cmdSel.set(i)}
                  onMove={(d) => { const n = untracked(commands).length; if (n) cmdSel.set((untracked(cmdSel) + d + n) % n); }}
                  onRun={(c) => runCommand(c)}
                  onClose={() => draft.set("")}
                  onManage={() => { draft.set(""); openTeam(); }}
                />
              </If>
              <View
                style={{
                  flexDirection: compactComposer() ? "row" : "column",
                  alignItems: compactComposer() ? "center" : "stretch",
                  gap: 6,
                  paddingTop: compactComposer() ? 4 : 12,
                  paddingBottom: compactComposer() ? 4 : 8,
                  paddingLeft: 18,
                  paddingRight: 8,
                  ...composerGlass(focused()),
                  ...(dropping() ? { borderColor: colors.accent, borderStyle: "dashed" as const } : {}),
                }}
              >
                <If when={replyTo()}>
                  {(ref) => (
                    <View testID="reply-chip" style={{ flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", maxWidth: "100%", height: 30, paddingLeft: 10, paddingRight: 4, borderRadius: 8, backgroundColor: tints.accent }}>
                      <Text style={{ ...chipText, flexShrink: 1, numberOfLines: 1, fontSize: 14, fontWeight: "500", color: colors.accent }}>{replyNote() ? `Replying to ${replyNote()}` : `Replying to ${ref()}`}</Text>
                      <View
                        onPress={() => replyTo.set(null)}
                        role="button"
                        accessibilityLabel="Cancel reply"
                        tooltip={<Tip label="Cancel reply" shortcut="Esc" />}
                        hoverStyle={hovered()}
                        style={{ width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center" }}
                      >
                        <Icon name="close" size={13} tint={colors.accent} />
                      </View>
                    </View>
                  )}
                </If>
                <If when={attachments().length}>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 2 }}>
                    <Each of={attachments()} key={(a) => a.id}>
                      {(a) => (
                        <View testID="attachment" accessibilityLabel={a().name} style={{ width: 64, height: 64 }}>
                          <Image
                            src={a().preview}
                            style={{ width: 64, height: 64, borderRadius: radius.inset, backgroundColor: colors.inset, objectFit: "cover" }}
                          />
                          <View
                            testID="remove-attachment"
                            role="button"
                            accessibilityLabel={`Remove ${a().name}`}
                            tooltip={touch ? undefined : <Tip label="Remove" />}
                            onPress={() => unattach(a().id)}
                            hoverStyle={{ opacity: 0.85 }}
                            style={{
                              position: "absolute", top: -6, right: -6, width: 22, height: 22, borderRadius: 11,
                              alignItems: "center", justifyContent: "center",
                              backgroundColor: colors.text,
                            }}
                          >
                            <Icon name="close" size={10} tint={colors.background} />
                          </View>
                        </View>
                      )}
                    </Each>
                  </View>
                </If>
                <If when={attachNote()}>
                  {(note) => <Text testID="attach-note" style={{ fontSize: 13, color: colors.danger }}>{note()}</Text>}
                </If>
                <If when={compactComposer()}>
                  <View testID="attach" role="button" accessibilityLabel="Add image" onPress={() => void pickImages()} hoverStyle={hovered()} style={{ width: touch ? 44 : 36, height: touch ? 44 : 36, marginLeft: -8, borderRadius: touch ? 22 : 18, alignItems: "center", justifyContent: "center" }}>
                    <Icon name="plus" size={touch ? 22 : 18} tint={colors.text} />
                  </View>
                </If>
                <Input
                  testID="composer"
                  ref={(r) => (composer = r)}
                  multiline
                  submitBehavior={touch ? "newline" : "submit"}
                  onSubmit={submit}
                  value={draft()}
                  onChange={({ value }) => {
                    draft.set(value);
                    if (untracked(speech) !== "off" && value !== dictated) stopDictation(true);
                  }}
                  onSelectionChange={({ start, end }) => (caret = { start, end })}
                  onPaste={({ files, uris }) => {
                    for (const f of files) attach(f, f.name);
                    if (uris.length) void attachUris(uris);
                  }}
                  onFocus={() => {
                    if (compactComposer() && !reduceMotion()) LayoutAnimation.configureNext(LayoutAnimation.create(180, "easeInEaseOut"));
                    focused.set(true);
                  }}
                  onBlur={() => {
                    if (!draft() && !attachments().length && !replyTo() && !reduceMotion()) LayoutAnimation.configureNext(LayoutAnimation.create(180, "easeInEaseOut"));
                    focused.set(false);
                  }}
                  onContentSizeChange={({ size: s }) => inputHeight.set(Math.min(220, Math.max(28, s.height)))}
                  placeholder={replyTo() ? `Reply to ${replyTo()}…` : wide() ? "Give the team an instruction" : "Give the team an instruction…"}
                  class={platform.os === "ios" ? "placeholder:text-muted-foreground" : "placeholder:text-faint"}
                  style={{ height: compactComposer() ? 28 : inputHeight(), flex: compactComposer() ? 1 : undefined, minWidth: 0, fontSize: size.text, lineHeight: 24, color: colors.text, paddingVertical: 2 }}
                />
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <If when={!compactComposer()}><View
                      testID="attach"
                      role="button"
                      accessibilityLabel="Add image"
                      tooltip={touch ? undefined : <Tip label="Add image (or paste or drag one in)" />}
                      onPress={() => void pickImages()}
                      hoverStyle={hovered()}
                      style={{ width: touch ? 44 : 36, height: touch ? 44 : 36, marginLeft: -8, borderRadius: touch ? 22 : 18, alignItems: "center", justifyContent: "center" }}
                    >
                      <Icon name="plus" size={touch ? 22 : 18} tint={colors.text} />
                    </View></If>
                    <If when={speech() !== "off"}>
                      <Text testID="dictating" style={{ fontSize: 13, color: colors.accent, numberOfLines: 1 }}>
                        {speech() === "on" ? "Listening…" : "Transcribing…"}
                      </Text>
                    </If>
                  </View>
                  <If when={canDictate()}>
                    {/* a large round target beside send, unfilled so it does not compete with send; while listening it becomes a red stop in the same place */}
                    <View
                      testID="dictate"
                      role="button"
                      accessibilityLabel={speech() === "off" ? "Voice input" : "Stop voice input"}
                      accessibilityState={{ selected: speech() !== "off" }}
                      tooltip={touch ? undefined : <Tip label={speech() === "off" ? "Voice input" : "Stop voice input"} />}
                      onPress={toggleDictation}
                      hoverStyle={speech() === "off" ? hovered() : { opacity: 0.9 }}
                      style={{
                        width: touch ? 44 : 36,
                        height: touch ? 44 : 36,
                        borderRadius: touch ? 22 : 18,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: speech() === "off" ? undefined : tints.danger,
                        transitionProperty: "background-color",
                        transitionDuration: 120,
                      }}
                    >
                      <Icon name={speech() === "off" ? "mic" : "stop"} size={speech() === "off" ? (touch ? 22 : 19) : (touch ? 18 : 16)} tint={speech() === "off" ? colors.text : colors.danger} />
                    </View>
                  </If>
                  <If when={!compactComposer()}>
                    <SendButton testID="send" disabled={!canSend()} onPress={submit} />
                  </If>
                </View>
              </View>
            </View>
          </View>
          </View>
      </View>
  );

  const gutter = () => (wide() ? 32 : 16);
  const titleOf = (r: Route): string => {
    switch (r.name) {
      case "channel": return "Main chat";
      case "team": return wide() ? "Team settings" : "Settings";
      case "archive": return "Archive";
      case "saved": return "Saved requests";
      case "task": return `Task ${r.id}`;
      case "tasks": return "All tasks";
      case "plans": return "Plans";
      case "plan": return `Plan ${r.id}`;
      case "host": return `Machine ${r.host}`;
      case "notify": return "Notifications";
      case "configuration": return r.section === "onboarding" ? "AI tools & onboarding" : "Team configuration";
      case "member": return settings.view()?.effective.agents.find((a) => a.id === r.id)?.title ?? r.id;
      case "routine": return r.routine;
      case "rules": return "Memory";
      case "doc": return r.path.split("/").pop()!.replace(/\.md$/i, "");
    }
  };
  /** The back button's label, the page below's short name. */
  const backTitle = (r: Route | undefined) => (!r ? "" : r.name === "channel" ? "Main chat" : r.name === "team" ? "Settings" : r.name === "host" ? "Machine" : r.name === "rules" ? "Memory" : r.name === "tasks" ? "All tasks" : r.name === "plans" ? "Plans" : titleOf(r));
  const below = (r: Route) => { const rs = nav.routes(); const i = rs.indexOf(r); return i > 0 ? rs[i - 1] : undefined; };
  const connPill = () => (
    <View
      tooltip={<Tip label={hub.cfg.url} />}
      accessibilityLabel={connLabel()}
      testID="conn"
      style={{ flexDirection: "row", alignItems: "center", gap: 7, height: 30, paddingHorizontal: wide() ? 10 : 11 }}
    >
      <Dot tone={connTone()} />
      <If when={wide()}>
        <Text style={{ fontSize: 13.5, color: hub.conn() === "unauthorized" ? colors.danger : colors.muted }}>{connLabel()}</Text>
      </If>
    </View>
  );
  /** The page header on desktops and the web; phones use the system header. */
  const Bar = (p: { route: Route }) => (
    <View
      desktop={{ windowDrag: true }}
      onTouchStartCapture={() => { if (platform.os === "macos" && focused()) composer?.blur(); }}
      style={{
        height: size.bar,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingLeft: (wide() && sidebarOpen() ? 0 : hasWindow ? titleBar().left : 0) + (wide() ? 24 : 8),
        paddingRight: (hasWindow ? titleBar().right : 0) + (wide() ? 16 : 8),
        borderBottomWidth: 0.5,
        borderBottomColor: surfaceEdge(),
        backgroundColor: colors.background,
      }}
    >
      <If when={!wide() && p.route === CHANNEL}>
        <ToolButton icon="menu" label="Menu" onPress={() => drawer.set(true)} />
      </If>
      <If when={wide() && !sidebarOpen()}>
        <ToolButton icon="sidebar" label="Show sidebar" shortcut={keymap.label("mod+b")} onPress={() => setSidebarOpen(true)} />
      </If>
      <If when={below(p.route)}>
        {(b) => (
          <View
            role="button"
            accessibilityLabel={`Back to ${backTitle(b())}`}
            onPress={() => nav.pop()}
            hoverStyle={hovered()}
            style={{ height: touch ? 44 : 32, flexDirection: "row", alignItems: "center", gap: 2, paddingLeft: 4, paddingRight: 10, borderRadius: radius.control, borderCurve: "continuous" }}
          >
            <Icon name="back" size={18} tint={colors.accent} />
            <Text style={{ fontSize: 15, fontWeight: "500", color: colors.accent }}>{backTitle(b())}</Text>
          </View>
        )}
      </If>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 }}>
        <Text style={{ fontSize: 16, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{titleOf(p.route)}</Text>
      </View>
      {connPill()}
      <If when={!wide() && p.route === CHANNEL}>
        <ToolButton icon="sliders" label="Settings" onPress={openTeam} testID="settings-top" />
      </If>
    </View>
  );
  const content = (r: Route) => {
    switch (r.name) {
      case "channel": return channelPage();
      case "task": return <TaskDetail hub={hub} id={r.id} wide={wide()} isCurrent={() => top() === r} />;
      case "tasks": return <TaskHistory hub={hub} wide={wide()} isCurrent={() => top() === r} onTask={openTask} />;
      case "plans": return <PlansPage hub={hub} settings={settings} wide={wide()} onPlan={(id) => nav.push({ name: "plan", id })} />;
      case "plan": return <PlanPage hub={hub} settings={settings} id={r.id} wide={wide()} onTask={openTask} onGone={() => nav.pop()} />;
      case "host": return <MachineDetail hub={hub} host={r.host} wide={wide()} onTask={openTask} />;
      case "team":
        return (
          <If
            when={wide()}
            else={<PhoneSettings hub={hub} push={push} settings={settings} onOpen={(x) => nav.push(x)} onDisconnect={props.onDisconnect} />}
          >
            <TeamSettings hub={hub} push={push} settings={settings} wide={wide()} isCurrent={() => top() === r} onTask={openTask} onArchiveOpen={(kind, id) => { if (kind === "members") nav.push({ name: "member", id }); else if (kind === "routines") nav.push({ name: "routine", routine: id }); else if (kind === "plans") nav.push({ name: "plan", id }); }} onRules={() => openRules(true)} onConnection={props.onConnection} onDisconnect={props.onDisconnect} />
          </If>
        );
      case "configuration": return <Grouped><View style={{ paddingHorizontal: 20 }}><ConfigurationSettings hub={hub} initialGroup={r.section} onTask={openTask} /></View></Grouped>;
      case "archive": return <Grouped><View style={{ paddingHorizontal: 20 }}><ArchiveBrowser hub={hub} settings={settings} isCurrent={() => top() === r} onOpen={(kind, id) => { if (kind === "members") nav.push({ name: "member", id }); else if (kind === "routines") nav.push({ name: "routine", routine: id }); else if (kind === "plans") nav.push({ name: "plan", id }); }} /></View></Grouped>;
      case "saved": return <Grouped><View style={{ paddingHorizontal: 20 }}><SavedRequests hub={hub} settings={settings} isCurrent={() => top() === r} onTask={openTask} onOwner={(owner) => owner.kind === "plan" ? nav.push({ name: "plan", id: owner.id }) : openTask(owner.id)} onArchive={(kind, id) => { if (kind === "members") nav.push({ name: "member", id }); else if (kind === "routines") nav.push({ name: "routine", routine: id }); else if (kind === "plans") nav.push({ name: "plan", id }); }} /></View></Grouped>;
      case "notify": return <PhoneNotify push={push} settings={settings} />;
      case "member": return <PhoneMember id={r.id} settings={settings} onGone={() => nav.pop()} />;
      case "routine": return <PhoneRoutine name={r.routine} settings={settings} onGone={() => nav.pop()} />;
      case "rules": return <RulesList hub={hub} onOpen={(path) => nav.push({ name: "doc", path })} />;
      case "doc": return <RuleDoc hub={hub} path={r.path} wide={wide()} />;
    }
  };

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.sidebar, overflow: "hidden" }}>
      <If when={platform.os === "macos" && wide() && sidebarOpen()}>
        <View style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: size.sidebar + 20, ...glass(colors.sidebar, 0), backgroundColor: alpha(colors.sidebar, 0.25), borderWidth: 0, boxShadow: "none", pointerEvents: "none" }} />
      </If>
      <If when={wide() && sidebarOpen()}>
        <View onTouchStartCapture={() => { if (platform.os === "macos" && focused()) composer?.blur(); }} style={{ width: size.sidebar, paddingTop: sidebarInset }}>{sidebar(false)}</View>
      </If>
      <If when={!wide()}>
        <View testID="drawer" pan={drawer() ? { x: drawerX } : undefined} onPanStart={() => drawerDragging.set(true)} onPanEnd={finishDrawerPan} style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: drawerWidth(), paddingTop: touch ? safeArea().top : 0, visibility: drawerVisible() || drawerDragging() ? "visible" : "hidden", pointerEvents: drawer() ? "auto" : "none" }}>{sidebar(true)}</View>
      </If>
      <View style={{ flex: 1, minWidth: 0, backgroundColor: colors.background, borderTopLeftRadius: wide() && sidebarOpen() ? 20 : 0, borderBottomLeftRadius: wide() && sidebarOpen() ? 20 : 0, borderCurve: "continuous", borderLeftWidth: !wide() && (drawer() || drawerDragging()) ? 1 : 0, borderLeftColor: colors.line, overflow: "hidden", translate: [wide() ? 0 : drawerTranslate(), 0], boxShadow: wide() && sidebarOpen() ? "-3px 0 18px rgba(0,0,0,0.08)" : undefined }}>
      <NavStack state={nav} testID="pages" style={{ flex: 1, minWidth: 0 }}>
        {(route, index) => (
          <NavPage
            testID={`page-${route.name}`}
            // with the sidebar beside it, a page picked there replaces the view at once; only a page opened from a page slides in
            animation={wide() && index() <= 1 ? "none" : "default"}
            title={titleOf(route)}
            header={systemHeader ? undefined : <Bar route={route} />}
            headerBackTitle={backTitle(route)}
            headerLeft={systemHeader && route === CHANNEL && !wide() ? <ToolButton icon="menu" label="Menu" onPress={() => drawer.set(true)} /> : undefined}
            ios={{ headerLeftSymbol: "sidebar.left", headerRightSymbol: "gearshape" }}
            headerTitle={
              // iOS: the bar's buttons are UIKit's own, so the connection sits by the title.
              platform.os === "ios" && route === CHANNEL ? (
                <View testID="conn" accessibilityLabel={connLabel()} style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                  <Dot tone={connTone()} />
                  <Text style={{ fontSize: 17, fontWeight: "600", color: colors.text }}>{titleOf(route)}</Text>
                </View>
              ) : undefined
            }
            headerRight={
              platform.os === "ios" ? (
                route === CHANNEL ? <ToolButton icon="sliders" label="Settings" onPress={openTeam} testID="settings-top" /> : undefined
              ) : systemHeader ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  {connPill()}
                  <If when={route === CHANNEL}>
                    <ToolButton icon="sliders" label="Settings" onPress={openTeam} testID="settings-top" />
                  </If>
                </View>
              ) : undefined
            }
            style={{ backgroundColor: colors.background }}
          >
            <View style={{ flex: 1 }}>
              <If when={(hub.savedEntries().length || hub.savedError()) && route.name !== "saved" && !(route.name === "team" && settings.tab() === "saved")}>
                <View testID="saved-requests-banner" role="button" accessibilityLabel="Review saved requests" onPress={() => nav.push({ name: "saved" })} style={{ paddingHorizontal: 16, paddingVertical: 10, backgroundColor: tints.warn }}>
                  <Text style={{ color: colors.text, fontSize: 13, lineHeight: 18 }}>{hub.savedError() ? "Saved requests need attention. Review recovery options." : `${hub.savedEntries().length} saved request${hub.savedEntries().length === 1 ? " needs" : "s need"} confirmation. Review saved requests.`}</Text>
                </View>
              </If>
              {content(route)}
            </View>
          </NavPage>
        )}
      </NavStack>
      <If when={!wide() && drawer()}>
        <View testID="drawer-dismiss" role="button" accessibilityLabel="Close sidebar" onPress={() => drawer.set(false)} pan={{ x: drawerX }} onPanStart={() => drawerDragging.set(true)} onPanEnd={finishDrawerPan} style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: "rgba(0,0,0,0.08)" }} />
      </If>
      </View>

      <If when={toast()}>
        {(t) => (
          <View style={{ position: "absolute", top: size.bar + 10, left: 0, right: 0, alignItems: "center", paddingHorizontal: 12, pointerEvents: "box-none" }}>
            <View
              role="button"
              testID="toast"
              accessibilityLabel={`View ${t().ref}`}
              onPress={() => {
                const ref = t().ref; // read before clearing: the toast's accessor is null after set(null)
                toast.set(null);
                pick(ref);
              }}
              style={{
                maxWidth: 520,
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingVertical: 10,
                paddingHorizontal: 14,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface,
                boxShadow: "0 10px 30px rgba(0,0,0,0.16)",
              }}
            >
              <Dot tone="wait" />
              <Text style={{ flexShrink: 1, fontSize: 14.5, color: colors.text, numberOfLines: 1 }}>
                <Text style={{ fontWeight: "600" }}>New decision {t().ref}</Text> · {t().text}
              </Text>
              <Text style={{ fontSize: 14, fontWeight: "600", color: colors.accent }}>View</Text>
            </View>
          </View>
        )}
      </If>

      <HelpSheet open={help()} onClose={() => help.set(false)} />
    </View>
  );
}

// ---------------------------------------------------------------- connect

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  masked?: boolean;
  testID?: string;
  hint?: string;
  autoFocus?: boolean;
  keyboardType?: "email-address" | "number-pad" | "url";
  autoComplete?: "email" | "one-time-code" | "url";
  maxLength?: number;
  big?: boolean;
}) {
  const focused = signal(false);
  return (
    <View style={{ gap: 7 }}>
      <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{props.label}</Text>
      <Input
        testID={props.testID}
        value={props.value}
        masked={props.masked}
        autoFocus={props.autoFocus}
        keyboardType={props.keyboardType}
        autoComplete={props.autoComplete}
        maxLength={props.maxLength}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={props.placeholder}
        class="placeholder:text-faint"
        submitBehavior="submit"
        onSubmit={() => props.onSubmit?.()}
        onChange={({ value }) => props.onChange(value)}
        onFocus={() => focused.set(true)}
        onBlur={() => focused.set(false)}
        style={{
          height: props.big ? 56 : 44,
          paddingHorizontal: 14,
          borderRadius: radius.control,
          borderWidth: 1,
          borderColor: focused() ? colors.accent : colors.fieldBorder,
          backgroundColor: colors.field,
          fontSize: 16,
          color: colors.text,
          ...(props.big ? { fontSize: 26, letterSpacing: 10, textAlign: "center", fontVariant: ["tabular-nums"] } : {}),
          ...(focused() ? { outlineStyle: "solid", outlineWidth: 3, outlineColor: alpha(colors.accent, 0.12) } : {}),
        }}
      />
      <If when={props.hint}>
        <Text style={{ fontSize: 13, lineHeight: 19, color: colors.muted }}>{props.hint}</Text>
      </If>
    </View>
  );
}

const RESEND = 60;

async function postJson(url: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  let r: Response;
  try {
    r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("unreachable");
  }
  let data: Record<string, unknown> = {};
  try {
    data = ((await r.json()) ?? {}) as Record<string, unknown>;
  } catch {
    /* no body */
  }
  return { status: r.status, data };
}

/** Login: the email gets a one-time code. On the web served by the hub the server is the page's own origin. */
function Login(props: { url: string; served: boolean; email: string; notice?: string; onLogin: (c: Config) => void }) {
  const url = signal(props.url);
  const editUrl = signal(!props.served);
  const email = signal(props.email);
  const code = signal("");
  const step = signal<"email" | "code">("email");
  const error = signal(props.notice ?? "");
  const busy = signal(false);
  const wait = signal(0);
  let timer: ReturnType<typeof setInterval> | undefined;
  cleanup(() => clearInterval(timer));
  const server = () => normalizeUrl(url());
  const unreachable = () => `Can't reach the server ${server()}. Check the address and your network`;

  const viaCli = signal(false); // email not set up yet: the code is shown by `noop login` on the owner's machine
  async function sendCode() {
    const e = email().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return error.set("Enter a valid email address");
    if (!server()) return error.set("Enter the server address");
    busy.set(true);
    error.set("");
    try {
      const r = await postJson(`${server()}/api/auth/start`, { email: e });
      if (r.status === 429) throw new Error(String(r.data.error ?? "Too many requests; try again later"));
      if (r.status === 503) throw new Error("The server has no email sending configured, so email sign-in isn't available yet");
      if (r.status >= 400) throw new Error(`The server returned ${r.status}; this address may not be a noop server`);
      await Storage.setItem(KEYS.email, e);
      viaCli.set(r.data.delivery === "cli");
      code.set("");
      step.set("code");
      wait.set(RESEND);
      clearInterval(timer);
      timer = setInterval(() => {
        wait.update((w) => Math.max(0, w - 1));
        if (untracked(wait) === 0) clearInterval(timer);
      }, 1000);
    } catch (err) {
      error.set(err instanceof Error && err.message !== "unreachable" ? err.message : unreachable());
    } finally {
      busy.set(false);
    }
  }

  async function verify() {
    const c = code().replace(/\D/g, "");
    if (c.length !== 6 || busy()) return;
    busy.set(true);
    error.set("");
    try {
      const r = await postJson(`${server()}/api/auth/verify`, { email: email().trim(), code: c });
      if (r.status === 401) throw new Error("The code is wrong or expired; enter it again");
      if (r.status === 429) throw new Error(String(r.data.error ?? "Too many attempts; try again later"));
      if (r.status >= 400 || typeof r.data.session !== "string") throw new Error(`The server returned ${r.status}`);
      await Storage.setItem(KEYS.url, server());
      await Storage.setItem(KEYS.token, r.data.session);
      props.onLogin({ url: server(), token: r.data.session });
    } catch (err) {
      code.set("");
      error.set(err instanceof Error && err.message !== "unreachable" ? err.message : unreachable());
    } finally {
      busy.set(false);
    }
  }
  const onCode = (v: string) => {
    const digits = v.replace(/\D/g, "").slice(0, 6);
    code.set(digits);
    if (digits.length === 6) verify();
  };

  return (
    <Scroll style={{ flex: 1, backgroundColor: colors.background }} keyboardShouldPersistTaps="handled">
      <View style={{ minHeight: windowSize().height - (touch ? safeArea().top : 0), alignItems: "center", justifyContent: "center", paddingHorizontal: 16, paddingTop: 48, paddingBottom: 48 }}>
        <View style={{ width: "100%", maxWidth: 440, gap: 24 }}>
          <View style={{ alignItems: "center", gap: 12 }}>
            <Mark size={48} />
            <Text style={{ fontSize: 28, fontWeight: "600", color: colors.text, letterSpacing: -0.3 }}>Sign in to Noop</Text>
            <Text style={{ fontSize: 15.5, lineHeight: 23, color: colors.muted, textAlign: "center" }}>
              {step() === "email" ? "Sign in with your email: we'll send you a 6-digit code." : viaCli() ? "No sender email is configured: run noop login in your host's terminal to see the code." : `We sent a code to ${email().trim()}. Check your inbox.`}
            </Text>
          </View>
          <View style={{ gap: 18, padding: 22, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
            <If
              when={step() === "code"}
              else={
                <>
                  <Field
                    label="Email"
                    value={email()}
                    onChange={(v) => email.set(v)}
                    onSubmit={sendCode}
                    placeholder="you@example.com"
                    keyboardType="email-address"
                    autoComplete="email"
                    autoFocus
                    testID="email"
                  />
                  <If
                    when={editUrl()}
                    else={
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        <Dot tone="on" />
                        <Text style={{ flex: 1, fontSize: 14, color: colors.muted, numberOfLines: 1 }}>Server: {server()}</Text>
                        <View role="button" accessibilityLabel="Change server" onPress={() => editUrl.set(true)} hoverStyle={hovered()} style={{ height: 30, justifyContent: "center", paddingHorizontal: 8, borderRadius: 6 }}>
                          <Text style={{ fontSize: 14, fontWeight: "500", color: colors.accent }}>Change</Text>
                        </View>
                      </View>
                    }
                  >
                    <Field label="Server address" value={url()} onChange={(v) => url.set(v)} onSubmit={sendCode} placeholder="https://noop.<your-account>.workers.dev" keyboardType="url" testID="url" hint="Your noop address: shown when installation finishes, or run noop status --brief on the host" />
                  </If>
                </>
              }
            >
              <Field
                label="Code"
                value={code()}
                onChange={onCode}
                onSubmit={verify}
                placeholder="······"
                keyboardType="number-pad"
                autoComplete="one-time-code"
                autoFocus
                big
                testID="code"
              />
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View role="button" accessibilityLabel="Use another email" onPress={() => { step.set("email"); error.set(""); }} hoverStyle={hovered()} style={{ height: 30, justifyContent: "center", paddingHorizontal: 8, borderRadius: 6 }}>
                  <Text style={{ fontSize: 14, color: colors.muted }}>‹ Use another email</Text>
                </View>
                <View style={{ flex: 1 }} />
                <View
                  role="button"
                  testID="resend"
                  accessibilityLabel="Resend"
                  accessibilityState={{ disabled: wait() > 0 }}
                  onPress={() => wait() === 0 && !busy() && sendCode()}
                  hoverStyle={wait() ? undefined : hovered()}
                  style={{ height: 30, justifyContent: "center", paddingHorizontal: 8, borderRadius: 6 }}
                >
                  <Text style={{ fontSize: 14, fontWeight: "500", color: wait() ? colors.faint : colors.accent, fontVariant: ["tabular-nums"] }}>
                    {wait() ? `Resend (${wait()}s)` : "Resend"}
                  </Text>
                </View>
              </View>
            </If>
            <If when={error()}>
              <View style={{ paddingHorizontal: 12, paddingVertical: 10, borderRadius: radius.control, backgroundColor: tints.danger }}>
                <Text testID="login-error" style={{ fontSize: 14, lineHeight: 20, color: colors.danger }}>{error()}</Text>
              </View>
            </If>
            <If
              when={step() === "code"}
              else={<Btn testID="send-code" label={busy() ? "Sending…" : "Send code"} kind="primary" busy={busy()} grow onPress={sendCode} />}
            >
              <Btn testID="verify" label={busy() ? "Signing in…" : "Sign in"} kind="primary" busy={busy()} disabled={code().length !== 6} grow onPress={verify} />
            </If>
          </View>
        </View>
      </View>
    </Scroll>
  );
}

// ---------------------------------------------------------------- app

function Connected(props: { config: Config; openRef: string | null; onExpired: () => void; onLogout: () => void }) {
  const hub = createHub(props.config);
  cleanup(hub.dispose);
  // The service worker answers decisions from notifications with the session.
  hostCall("setSession", { session: props.config.token, origin: props.config.url });
  // A 401 on any call: the session is gone, back to the login.
  effect(() => {
    if (hub.conn() === "unauthorized") props.onExpired();
  });
  return (
    <If when={hub.savedReady()} else={<View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }}><Spinner size={20} tint={colors.muted} /><Text style={{ color: colors.muted }}>Loading saved requests…</Text></View>}><Chat
      hub={hub}
      openRef={props.openRef}
      onConnection={props.onExpired}
      onDisconnect={async () => {
        const off = await hostCall<{ endpoint: string | null }>("pushDisable");
        if (off?.endpoint) await hub.api("POST", "/api/push/unsubscribe", { endpoint: off.endpoint });
        await hostCall("setSession", { session: null });
        for (const id of [...showing]) closeNotification(id);
        setBadge(0);
        await hub.logout();
        props.onLogout();
      }}
    /></If>
  );
}

function App() {
  if (hasWindow) {
    Window.setTitle("Noop");
    Window.setTitleBar({ style: "hidden", height: size.bar });
  }
  Scrollbar.setTheme(scrollbarTheme);
  watchUpdates();
  const ready = signal(false);
  const config = signal<Config | null>(null);
  const url = signal("");
  const served = signal(false);
  const email = signal("");
  const notice = signal("");
  let openRef: string | null = null;
  loadConfig().then((r) => {
    openRef = r.ref;
    config.set(r.config);
    url.set(r.config?.url ?? r.suggested);
    served.set(r.served);
    email.set(r.email);
    ready.set(true);
  });
  async function forget(message: string) {
    await Storage.removeItem(KEYS.token);
    email.set((await Storage.getItem(KEYS.email)) ?? untracked(email));
    notice.set(message);
    config.set(null);
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: touch && !(systemHeader && config()) ? safeArea().top : 0 }}>
      <If when={ready()}>
        <If
          when={config()}
          else={
            <Login
              url={url()}
              served={served()}
              email={email()}
              notice={notice()}
              onLogin={(c) => {
                notice.set("");
                url.set(c.url);
                config.set(c);
              }}
            />
          }
        >
          {(c) => <Connected config={c()} openRef={openRef} onExpired={() => forget("Your session expired. Please sign in again.")} onLogout={() => forget("")} />}
        </If>
      </If>
    </View>
  );
}

mount(App);
