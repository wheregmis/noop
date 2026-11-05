# Noop

Your own AI team, so your day can be a no-op.

[Website](https://huacnlee.github.io/noop/) · [Download the app](https://github.com/huacnlee/noop/releases) · [Install](#install)

<img width="2000" height="1385" alt="The Noop app: a team channel with agent updates and a decision card" src="website/public/screenshot.png" />

Noop runs a small team of Claude Code and Codex agents on your own computers. They do your daily work, decide what they can based on how you've decided before, and only ask you when something really needs you — with a short list of options you answer in one tap.

- **Works for you, not with you** — give it a goal in one sentence; it breaks the work down, runs it in parallel and comes back with results.
- **Learns how you decide** — starts cautious, asks more early on, and takes over more as it proves it decides like you.
- **Quiet** — no noise, no raw errors. You hear about results and decisions, nothing else.
- **Yours** — runs on your machines and your own free Cloudflare account. No shared service, no one else's server.

**If this helps you, please [sponsor me](https://github.com/sponsors/huacnlee).**

## Install

On an always-on machine (Linux or macOS), once — it becomes the primary:

```bash
curl -fsSL https://raw.githubusercontent.com/wheregmis/noop/wheregmis/install.sh | bash -s -- --primary
```

You'll be asked to log in to your Cloudflare account once (the free plan is enough).

A new team starts small with its routines off, so it spends no model quota until you ask it to. Turn routines on in Settings, and add specialists with `noop role list` and `noop role add <id>`.

Add more machines whenever you like — they help when they're online and are never waited for:

```bash
# macOS or Linux
curl -fsSL https://raw.githubusercontent.com/wheregmis/noop/wheregmis/install.sh | bash
```

```powershell
# Windows
irm https://raw.githubusercontent.com/wheregmis/noop/wheregmis/install.ps1 | iex
```

## Client apps

The Noop app talks to your Noop from any device. It is optional: your Noop address also works in a browser.

```bash
# macOS (Apple silicon, macOS 14+) and Linux (x86_64, GTK 4.14+, such as Ubuntu 24.04)
curl -fsSL https://raw.githubusercontent.com/wheregmis/noop/wheregmis/install-client.sh | bash
```

```powershell
# Windows
irm https://raw.githubusercontent.com/wheregmis/noop/wheregmis/install-client.ps1 | iex
```

From v0.1.5 the desktop apps update themselves: when a new version has downloaded, the sidebar offers a restart. Earlier versions update by running the same command again.

- **Android** (9+): download [Noop-android.apk](https://github.com/huacnlee/noop/releases/latest/download/Noop-android.apk) on your phone and open it.
- **iOS** (15+): [Noop-ios-unsigned.ipa](https://github.com/huacnlee/noop/releases/latest/download/Noop-ios-unsigned.ipa) is not signed, so sign and install it with your own Apple ID using a tool such as Sideloadly or AltStore.

## Use

Open your Noop address on any device and sign in with a code sent to your email. On your phone, add it to the home screen and turn on notifications.

Then just talk to it. When it needs you, you'll get a notification with the choices; answer right there.

## License

MIT

## More projects

- [Disktree](https://huacnlee.github.io/disktree/) — A native disk-space explorer for macOS and Linux. See what fills your disk as a nested treemap, and review every path before removing anything.
- [Omasend](https://huacnlee.github.io/omasend/) — A native LocalSend client. Share files, folders, screenshots, and text over your local network, with no account or cloud upload.
- [Omamail](https://huacnlee.github.io/omamail/) — A native email and calendar app with multiple accounts and keyboard navigation. Runs as an Omarchy plugin or a standalone desktop app.
- [huacnlee/cargo](https://huacnlee.github.io/cargo/) — A drop-in Cargo fork: every git worktree of a project shares one build directory, which stays under a size limit on its own.
- [omarchy-mihoro](https://github.com/huacnlee/omarchy-mihoro) — An Omarchy bar panel for Mihoro. Monitor your proxy, switch between Rule, Global, and Direct modes, and manage subscriptions.
- [omarchy-which-key](https://github.com/huacnlee/omarchy-which-key) — Which Key for the desktop. Hold Super to see a shortcut guide drawn from your active Omarchy and Hyprland keybindings.
