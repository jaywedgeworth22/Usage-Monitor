# Usage Monitor — iOS apps

This directory holds **two** iOS products that share design tokens and some kit
code, but **not** the same money-truth.

| App | Scheme | Bundle ID | Purpose |
|---|---|---|---|
| **Usage Monitor** | `UsageMonitor` | `services.jays.usage.monitor` | Live-sync **client** of a Usage Monitor **server** (owner Oracle host, or your own Docker/VPS self-host). Full remote features, widgets, optional APNs registration against that server. |
| **Usage Monitor Local** | `UsageMonitorLocal` | `services.jays.usage.monitor.local` | **Standalone** on-device self-host. Keys in Keychain; budgets in local SQLite (GRDB). No server required. Separate App Store product. |

Design authority: [`docs/designs/2026-08-04-mobile-parity-and-phone-self-host.md`](../docs/designs/2026-08-04-mobile-parity-and-phone-self-host.md).  
Binding contract: [`UsageMonitor/ARCHITECTURE-CONTRACT.md`](UsageMonitor/ARCHITECTURE-CONTRACT.md).

## Which one should I use?

- **You run a server** (like the owner at `usage.jays.services`) and want live
  sync, OTLP/ingest from other machines, multi-device producers → install
  **Usage Monitor**, point Settings at your HTTPS origin, use read token /
  dashboard login.
- **You want the phone itself to be the whole product** (no VPS) → install
  **Usage Monitor Local** (Milestone A in progress).

Do **not** install both expecting a shared database — different app groups.

## Layout

```
ios/
  README.md                 ← this file
  UsageMonitor/             ← XcodeGen project (both app targets)
    project.yml
    App/                    ← Usage Monitor (remote client) shell
    LocalApp/               ← Usage Monitor Local shell
    UsageMonitorKit/        ← SPM package (remote features + LocalStore/LocalDataPlane)
    UsageMonitorWidget/     ← widget for remote client
    ARCHITECTURE-CONTRACT.md
```

## Generate & build

```bash
cd ios/UsageMonitor
xcodegen generate

# Remote client (owner / server self-host path)
xcodebuild -scheme UsageMonitor -destination 'platform=iOS Simulator,name=iPhone 16' build

# On-device Local product
xcodebuild -scheme UsageMonitorLocal -destination 'platform=iOS Simulator,name=iPhone 16' build

# Kit unit tests (includes LocalStore scaffold)
swift test --package-path UsageMonitorKit
```

Headless CI often passes `CODE_SIGNING_ALLOWED=NO`. Release/TestFlight signing
stays Automatic with team `CC8UTF7ATG` in `project.yml`.

## Self-host “the way the owner does”

That path is **server + Usage Monitor client**, not the Local app:

1. Deploy the Next.js app (Oracle production scripts or a future generic
   `deploy/self-host` profile) with SQLite on a persistent disk.
2. Set `DASHBOARD_PASSWORD`, `USAGE_READ_TOKEN`, `USAGE_INGEST_TOKEN`, etc.
3. Install **Usage Monitor**, set host to your HTTPS origin, verify token / log in.
4. Point producers (Congress.Trade, Socratic.Trade, Claude Code OTLP) at that host.

The Local app intentionally cannot receive fleet OTLP/ingest on a sleeping phone.

## Milestone A (Local)

Scaffolded today: `LocalStore` placeholder + `LocalRootView` shell.  
Next: GRDB DDL, Keychain CRUD, OpenRouter adapter, BudgetEngine — see the design PR plan.
