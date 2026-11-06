import { AGENT_PROVIDERS, enabledProviders, type ProviderStatus } from "../cloud/src/providers";
export { enabledProviders } from "../cloud/src/providers";
export type ProviderHealth = ProviderStatus;
const cache = new Map<string, { at: number; installed: boolean; available: boolean; reason?: string }>();
/** Version checks never start an agent or read conversation history. Cache slow or broken launchers too. */
const probeProvider = (id: string) => {
  const binary = Bun.which(id, { PATH: process.env.PATH });
  if (!binary) return { installed: false, available: false, reason: "Not installed on this machine" };
  try {
    const result = Bun.spawnSync([binary, "--version"], { timeout: 3000, stdout: "pipe", stderr: "pipe" });
    return { installed: true, available: result.exitCode === 0, ...(result.exitCode === 0 ? {} : { reason: `Launcher failed (exit ${result.exitCode}); repair this tool's installation` }) };
  } catch { return { installed: true, available: false, reason: "Could not start the installed tool" }; }
};
export function providerHealth(cfg: Record<string, any>, probe = probeProvider): ProviderHealth[] {
  const selected = enabledProviders(cfg);
  return AGENT_PROVIDERS.map((provider) => {
    const key = `${provider.id}:${Bun.which(provider.id, { PATH: process.env.PATH }) ?? "missing"}`;
    let value = probe === probeProvider ? cache.get(key) : undefined;
    if (!value || Date.now() - value.at > 300_000) {
      value = { ...probe(provider.id), at: Date.now() };
      if (probe === probeProvider) cache.set(key, value);
    }
    return { ...provider, installed: value.installed, available: value.available, enabled: selected.includes(provider.id), ...(value.reason ? { reason: value.reason } : {}) };
  });
}
export const providerAvailable = (id: string) => providerHealth({}).some((provider) => provider.id === id && provider.available);
