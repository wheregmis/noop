// Shared provider identifiers keep the UI, validators and scheduler in agreement.
export const AGENT_PROVIDERS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "hermes", label: "Hermes" },
] as const;
export const PROVIDER_IDS: string[] = AGENT_PROVIDERS.map((provider) => provider.id);
export const DEFAULT_PROVIDERS = ["claude", "codex"];
export const LEARNING_SOURCES = [...PROVIDER_IDS, "noop"];
export const providerLabel = (id: string) => AGENT_PROVIDERS.find((provider) => provider.id === id)?.label ?? (id === "noop" ? "Noop chat and decisions" : id);
export function enabledProviders(cfg: Record<string, any>): string[] {
  const selected = cfg.clis?.enabled ?? DEFAULT_PROVIDERS;
  return Array.isArray(selected) ? [...new Set(selected.filter((id) => PROVIDER_IDS.includes(id)))] : [];
}
export function providerOrders(ids: string[]): string[][] {
  const orders: string[][] = [[]];
  const add = (prefix: string[], remaining: string[]) => { for (const id of remaining) { const next = [...prefix, id]; orders.push(next); add(next, remaining.filter((other) => other !== id)); } };
  add([], ids); return orders;
}

export type ProviderStatus = { id: string; label: string; installed: boolean; available: boolean; enabled: boolean; reason?: string; host?: string };

export type ToolPolicy = {
  configured: string[] | null; effective: string[];
  source: "ui" | "local_file" | "shared_file" | "default";
  file_default: string[] | null; file_source: "local_file" | "shared_file" | "default";
  invalid?: boolean; file_invalid?: boolean;
};
export type ToolPolicyView = { version: 1; team: ToolPolicy };
export type ToolSettingsPatch = { preference?: string[] | null; agents?: Record<string, string[] | null> };

/** A reset removes a UI choice; null explicitly inherits instead of revealing a file setting. */
export function toolSettingsPatch(input: unknown): { values: ToolSettingsPatch; reset: string[] } | { error: string } {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const member = (id: string) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(id) && !["__proto__", "constructor", "prototype"].includes(id);
  const order = (value: unknown): value is string[] | null => value === null || Array.isArray(value)
    && value.length <= PROVIDER_IDS.length && value.every((id) => typeof id === "string" && PROVIDER_IDS.includes(id)) && new Set(value).size === value.length;
  if (!object(input) || Object.keys(input).some((key) => !["preference", "agents", "reset"].includes(key))) return { error: "Choose supported task tool settings" };
  const values: ToolSettingsPatch = {};
  if (Object.hasOwn(input, "preference")) {
    if (!order(input.preference)) return { error: "Choose a unique supported task tool order, an empty list, or Automatic" };
    values.preference = input.preference === null ? null : [...input.preference];
  }
  if (Object.hasOwn(input, "agents")) {
    if (!object(input.agents) || Object.entries(input.agents).some(([id, value]) => !member(id) || !order(value)))
      return { error: "Choose a unique supported tool order for each member, an empty list to pause, or the team default" };
    values.agents = Object.fromEntries(Object.entries(input.agents).map(([id, value]) => [id, value === null ? null : [...value as string[]]]));
  }
  if (Object.hasOwn(input, "reset") && (!Array.isArray(input.reset) || input.reset.some((path) => typeof path !== "string"
    || path !== "preference" && !(path.startsWith("agents.") && member(path.slice(7)))) || new Set(input.reset).size !== input.reset.length))
    return { error: "Choose each team or member tool setting to restore once" };
  const reset = [...(input.reset as string[] | undefined ?? [])];
  if (reset.some((path) => path === "preference" ? Object.hasOwn(values, "preference") : Object.hasOwn(values.agents ?? {}, path.slice(7))))
    return { error: "Choose either a task tool value or a file reset for the same setting" };
  return { values, reset };
}
