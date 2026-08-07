# Usage Monitor — iOS apps

This directory holds **two** iOS products that share design tokens and some kit
code, but **not** the same money-truth.

| App | Scheme / product | Bundle ID | Purpose |
|---|---|---|---|
| **Usage Monitor** | `UsageMonitor` | `services.jays.usage.monitor` | Live-sync **client** of a Usage Monitor **server** (owner Oracle host, or your own Docker/VPS self-host). Widget: `services.jays.usage.monitor.widget`. |
| **Local Usage Monitor** | `LocalUsageMonitor` | **`services.jays.local.usage.monitor`** | **Free App Store candidate** — standalone on-device product. Keys in Keychain; budgets in local SQLite. **No server required.** App group: `group.services.jays.local.usage.monitor`. |

Design authority: [`docs/designs/2026-08-04-mobile-parity-and-phone-self-host.md`](../docs/designs/2026-08-04-mobile-parity-and-phone-self-host.md).  
Binding contract: [`UsageMonitor/ARCHITECTURE-CONTRACT.md`](UsageMonitor/ARCHITECTURE-CONTRACT.md).

### Product identity (do not swap)

| | Remote client | Local (this free App Store path) |
|---|---|---|
| Bundle ID | `services.jays.usage.monitor` | **`services.jays.local.usage.monitor`** |
| App group | `group.services.jays.usage.monitor` | `group.services.jays.local.usage.monitor` |
| Deep link | `usagemonitor://` | `localusagemonitor://` |
| TestFlight ship | `bash scripts/ios-ship-testflight.sh` | `bash scripts/ios-ship-testflight-local.sh` |
| ASC app record | “Usage Monitor” | Create as **Local Usage Monitor** with the local bundle ID |

Never reuse the remote client’s bundle ID for the free on-device app (App Store
Connect, TestFlight, and device installs must stay separate).

## Which one should I use?

- Server + live sync (how the owner runs) → **Usage Monitor**
- Phone is the whole product / free public App Store → **Local Usage Monitor**

They do **not** share an app group, Keychain, or database.

## Generate & build

```bash
cd ios/UsageMonitor
xcodegen generate
xcodebuild -scheme UsageMonitor -destination 'generic/platform=iOS Simulator' build
xcodebuild -scheme LocalUsageMonitor -destination 'generic/platform=iOS Simulator' build
```

## Installing both on one phone

| Scheme | Bundle ID | Home-screen name | Icon |
|---|---|---|---|
| `UsageMonitor` | `services.jays.usage.monitor` | Usage Monitor | Purple ring |
| `LocalUsageMonitor` | `services.jays.local.usage.monitor` | Local Usage Monitor | Teal ring |

1. Scheme menu (toolbar, next to the device picker) → **UsageMonitor** → Run.  
2. **Stop** the debugger (■) or leave the app running on the phone — either is fine.  
3. Scheme menu → **LocalUsageMonitor** (not UsageMonitor) → Run.  
4. Two icons on the home screen.

### “Replace UsageMonitor?” dialog

That dialog means Xcode is trying to **debug the same scheme again**. It is
**not** proof that the two apps share an identity.

Look at the scheme name in the toolbar (and in the dialog title). If it says
**UsageMonitor**, you are re-running the remote client. Switch the scheme to
**LocalUsageMonitor** first — then Play installs/launches the local app under
`services.jays.local.usage.monitor` without replacing the remote client.

Also open **Product → Scheme → Manage Schemes…** and confirm both
`UsageMonitor` and `LocalUsageMonitor` are checked (shared). After `xcodegen
generate`, re-open the project if the second scheme is missing from the menu.

Delete any old install of `services.jays.usage.monitor.local` / “UM Local” if
you tested under a pre-rename identity. Canonical local ID is only
`services.jays.local.usage.monitor`.

## TestFlight

```bash
# Remote client (server-backed)
bash scripts/ios-ship-testflight.sh

# Local free App Store candidate (on-device only)
bash scripts/ios-ship-testflight-local.sh
# or: bash /Users/jay/apps/ios-fleet/ship-testflight.sh usage-local --repo-root "$PWD"
```

ASC: create an App Store Connect app with bundle ID
`services.jays.local.usage.monitor` before the first Local upload.


## Local provider catalog

**Local Usage Monitor** ships a fleet-aligned catalog (LLM, hosting, market data, infra).

- **Poll (API key):** OpenRouter, OpenAI org costs, DeepSeek balance, Anthropic Admin cost report
- **API vs chat split:** OpenAI (API) + ChatGPT (subscription); Anthropic (API) + Claude (subscription); xAI + SuperGrok (subscription).
- **Connection chips:** Polls Cost / Polls Balance / Recurring Fee / Optional Key / Fee Only — never raw `subscription_only`.
- **+ → Add Missing Providers** creates inactive $0 cards for every known service (private SQLite; survives app updates; no keys/fees invented).
