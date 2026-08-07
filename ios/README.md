# Usage Monitor — iOS apps

Two App Store products that share kit code but **not** money-truth or identity.

| App (user-visible name) | Scheme | Bundle ID | Purpose |
|---|---|---|---|
| **Usage Client Monitor** | `UsageMonitor` | `services.jays.usage.client.monitor` | Live-sync **client** of a Usage Monitor **server** you host (or the owner fleet). Widget: `services.jays.usage.client.monitor.widget`. |
| **Usage Local Monitor** | `LocalUsageMonitor` | `services.jays.usage.local.monitor` | **Free App Store candidate** — on-device only. Keys in Keychain; budgets in local SQLite. **No server required.** |

User-facing copy uses the **plain app name** only. Show `name` + `bundle ID` together only on identity/debug surfaces.

Design authority: [`docs/designs/2026-08-04-mobile-parity-and-phone-self-host.md`](../docs/designs/2026-08-04-mobile-parity-and-phone-self-host.md).  
Binding contract: [`UsageMonitor/ARCHITECTURE-CONTRACT.md`](UsageMonitor/ARCHITECTURE-CONTRACT.md).

### Product identity (do not swap)

| | Usage Client Monitor | Usage Local Monitor |
|---|---|---|
| Bundle ID | `services.jays.usage.client.monitor` | `services.jays.usage.local.monitor` |
| App group | `group.services.jays.usage.client.monitor` | `group.services.jays.usage.local.monitor` |
| Deep link | `usageclientmonitor://` | `usagelocalmonitor://` |
| ASC name | Usage Client Monitor | Usage Local Monitor |
| ASC SKU | `usage-client-monitor` | `usage-local-monitor` |
| TestFlight ship | `bash scripts/ios-ship-testflight.sh` | `bash scripts/ios-ship-testflight-local.sh` |

Never reuse one app’s bundle ID for the other (App Store Connect, TestFlight, and device installs must stay separate).

## Which one should I use?

- Server + live sync → **Usage Client Monitor** (self-host the free server code, then point the app at your URL)
- Phone is the whole product / free public App Store → **Usage Local Monitor**

They do **not** share an app group, Keychain, or database.

## Generate & build

```bash
cd ios/UsageMonitor
xcodegen generate
xcodebuild -scheme UsageMonitor -destination 'generic/platform=iOS Simulator' build
xcodebuild -scheme LocalUsageMonitor -destination 'generic/platform=iOS Simulator' build
```

## Installing both on one phone

| Scheme | Bundle ID | Home-screen name |
|---|---|---|
| `UsageMonitor` | `services.jays.usage.client.monitor` | Usage Client Monitor |
| `LocalUsageMonitor` | `services.jays.usage.local.monitor` | Usage Local Monitor |

1. Scheme menu → **UsageMonitor** → Run.  
2. Stop or leave running.  
3. Scheme menu → **LocalUsageMonitor** → Run.  
4. Two icons on the home screen.

Delete any old install under legacy IDs if you tested earlier:

- `services.jays.usage.monitor`
- `services.jays.usage.monitor.local`
- `services.jays.local.usage.monitor`

Canonical IDs are only the **client** / **local** rows in the table above.

## TestFlight

```bash
# Usage Client Monitor (server-backed)
bash scripts/ios-ship-testflight.sh

# Usage Local Monitor (on-device only)
bash scripts/ios-ship-testflight-local.sh
```

ASC: create apps with the **new** bundle IDs before first upload (API key cannot create apps — Account Holder / Admin in the ASC UI).

## Local provider catalog

**Usage Local Monitor** ships a fleet-aligned catalog (LLM, hosting, market data, infra).

- **Poll (API key):** OpenRouter, OpenAI org costs, DeepSeek balance, Anthropic Admin cost report
- **API vs chat split:** OpenAI (API) + ChatGPT (subscription); Anthropic (API) + Claude (subscription); xAI + SuperGrok (subscription).
- **Connection chips:** Polls Cost / Polls Balance / Recurring Fee / Optional Key / Fee Only — never raw `subscription_only`.
- **+ → Add Missing Providers** creates inactive $0 cards for every known service (private SQLite; survives app updates; no keys/fees invented).
