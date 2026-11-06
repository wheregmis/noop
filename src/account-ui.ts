// Machine-local account controls: only safe status and short-lived sign-in challenges leave this host.
import { machineAccountPath, printableAccountName } from "../cloud/src/machine-requests";
import { PROVIDER_IDS } from "../cloud/src/providers";
import { AccountSourceError, accounts, accountStatus, cancelLogin, fileAccounts, hasPendingLogin, loginInfo, setAccountNames, startLogin, submitLoginCode, validAccountName } from "./accounts";
import { hostName, loadConfig, type Cfg } from "./core";
import { providerAvailable, providerHealth } from "./providers";

export function accountView(cfg: Cfg) {
  return { host: hostName(cfg), providers: providerHealth(cfg), accounts: PROVIDER_IDS.flatMap((cli) => accounts(cfg, cli)).map((account) => ({
    cli: account.cli, name: account.name, default: account.default === true, ...accountStatus(account), login: loginInfo(account),
  })) };
}
const json = (data: unknown, status = 200) => Response.json(data, { status });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).length === allowed.length && allowed.every((key) => Object.hasOwn(value, key));
const loginId = (value: unknown): value is string => typeof value === "string" && /^L-\d{4,}$/.test(value);

export async function accountRequest(req: Request): Promise<Response> {
  const route = machineAccountPath(new URL(req.url).pathname);
  if (!route) return json({ error: "Account route not found" }, 404);
  const allowed = route.action ? req.method === "POST" : route.cli ? req.method === "DELETE" : ["GET", "POST", "PUT"].includes(req.method);
  if (!allowed) return json({ error: "method not allowed" }, 405);
  let body: Record<string, unknown> = {};
  if (req.method === "POST" || req.method === "PUT") {
    const text = await req.text();
    if (text.length > 16_384) return json({ error: "Account form is too large" }, 413);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return json({ error: "Invalid account form" }, 400); }
    if (!object(parsed)) return json({ error: "Invalid account form" }, 400);
    body = parsed;
    if (req.method === "PUT" && (!keys(body, ["cli", "names"]) || typeof body.cli !== "string" || !PROVIDER_IDS.includes(body.cli) || body.names !== null && (!Array.isArray(body.names) || body.names.length > 100 || body.names.some((name) => !printableAccountName(name)) || new Set(body.names).size !== body.names.length)))
      return json({ error: "Choose a tool and a unique ordered list of its selected accounts, or null to restore file defaults" }, 400);
    if (req.method === "POST" && !route.cli && (!keys(body, ["cli", "name"]) || typeof body.cli !== "string" || !PROVIDER_IDS.includes(body.cli) || !validAccountName(body.name)))
      return json({ error: "Choose a supported tool and an account name using lowercase letters, numbers, dashes or underscores" }, 400);
    if (route.action === "code" && (!keys(body, ["id", "code"]) || !loginId(body.id) || typeof body.code !== "string" || !body.code.trim() || body.code.length > 8192 || /[\r\n\0]/.test(body.code)))
      return json({ error: "Provide the pending sign-in ID and its authorization code" }, 400);
    if (route.action === "cancel" && (!keys(body, ["id"]) || !loginId(body.id))) return json({ error: "Provide the pending sign-in ID" }, 400);
    if (route.action === "login" && Object.keys(body).length) return json({ error: "Send an empty object to start sign-in" }, 400);
  }
  try {
    const cfg = loadConfig();
    if (route.host !== hostName(cfg)) return json({ error: "Account changes must run on the selected machine" }, 403);
    if (req.method === "GET") return json(accountView(cfg));
    if (!route.cli) {
      const cli = String(body.cli), current = accounts(cfg, cli);
      if (req.method === "PUT") {
        if (body.names === null) {
          const inherited = fileAccounts(cfg, cli);
          if (current.some((account) => hasPendingLogin(account) && !inherited.some((restored) => restored.name === account.name && restored.dir === account.dir && !!restored.default === !!account.default)))
            return json({ error: "Cancel pending sign-ins before restoring file defaults that remove those accounts" }, 409);
          setAccountNames(cli, null);
        } else {
          const names = body.names as string[];
          if (names.length !== current.length || names.some((name) => !current.some((account) => account.name === name)))
            return json({ error: "The selected accounts changed. Reload before reordering; use Add or Remove to change the selection." }, 409);
          setAccountNames(cli, names);
        }
      } else setAccountNames(cli, [...current.map((account) => account.name), String(body.name)]);
    } else {
      const account = accounts(cfg, route.cli).find((item) => item.name === route.name);
      if (!account) return json({ error: "No such account is selected on this machine" }, 404);
      if (req.method === "DELETE") {
        if (hasPendingLogin(account)) return json({ error: "Cancel this account's pending sign-in before removing it" }, 409);
        setAccountNames(account.cli, accounts(cfg, account.cli).filter((item) => item.name !== account.name).map((item) => item.name));
      } else if (route.action === "login") {
        if (account.cli === "hermes") return json({ error: "Hermes sign-in requires its native model setup on this machine. Select another tool until setup is complete." }, 409);
        if (!providerAvailable(account.cli)) return json({ error: "This AI tool cannot launch on this machine. Check its installation before signing in." }, 409);
        await startLogin(account, cfg, { notify: false });
      } else if (route.action === "code") {
        if (!submitLoginCode(String(body.id), String(body.code), account)) return json({ error: "This authorization code does not match an active sign-in for this account. Start sign-in again if it expired." }, 409);
      } else if (route.action === "cancel") {
        if (!cancelLogin(account, String(body.id))) return json({ error: "No matching sign-in is pending for this account" }, 409);
      }
    }
    return json(accountView(loadConfig()));
  } catch (error) {
    if (error instanceof AccountSourceError) return json({ error: error.message }, 409);
    console.error("local account request failed", error);
    return json({ error: "Could not read or change accounts on this machine. Check its local logs and try again." }, 500);
  }
}
