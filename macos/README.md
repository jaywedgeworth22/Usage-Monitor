# Usage Monitor for macOS

Usage Monitor for macOS is a read-only client for local Claude, Codex, Antigravity, Cursor, Grok, MiniMax, Kimi Code, and Gemini CLI quota adapters.  It can also read an optional HTTPS `GET /api/quota-windows` endpoint with a Keychain token.  It presents the latest quota windows with their source timestamps and keeps missing quota data visible instead of inventing values.

The app supports menu bar, Dock, or both surfaces.  Both is the default.  The server read token is stored in macOS Keychain, scoped to its endpoint URL.  The endpoint and display preferences are stored in UserDefaults.  Local CLI credentials are read in memory and are never copied into the app's preferences or logs.

Quota refreshes run every five minutes, on wake, and on demand.  Readings older than 30 minutes are stale.  A passed reset time means awaiting refresh; it never restores a cap without a new reading.  Missing percentages remain unknown.  Absolute request/credit caps are shown only when the provider explicitly reports them.  No quota is inferred from token spend, plan prices, or normalized percentages.

Closing the main window keeps the app running.  Open it again from its menu bar panel or Dock icon.  Settings → Show In changes the mode immediately.  Quit from the app menu or the menu bar panel's More menu.  There is no LaunchAgent or login item.

Antigravity displays exactly four shared windows: Gemini Models and Third-Party Models, each with a 5-hour and weekly cap.  Repeated model observations are not additional quotas.  Missing weekly data stays unavailable with no invented reset.  GitHub Copilot, Windsurf, DeepSeek, and additional platforms can be supplied by the server; they have no built-in local reader yet.  Expired local sessions require signing in again in the provider's app or CLI.

From the repository root:

```sh
swift test --package-path macos
./script/build_and_run.sh --build-only
./script/build_and_run.sh
./script/build_and_run.sh --verify
./script/build_and_run.sh --install
```

`--build-only` stages and ad hoc signs `macos/dist/Usage Monitor.app` without terminating or launching an app.  The default command terminates only the staged app executable, then builds and opens the bundle.  `--install` copies only over an existing bundle with identifier `com.jays.usage-monitor.mac`; it refuses any other bundle.

Local builds use ad hoc signing for development.  This repository does not claim notarized distribution.
