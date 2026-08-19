# Fix: GitHub 403 dispatch failure + Android Preferences plugin not registered

Two blocking defects, minimum robust changes, no unrelated UI work.

## 1. GitHub 403 — build cannot start

### What the code actually does today

- `upsertFile`/`upsertFileOnRepo` build the Contents API URL with `encodeURIComponent(path)`, so `.github/workflows/android-build.yml` is sent as `.github%2Fworkflows%2Fandroid-build.yml`. GitHub does not accept percent-encoded path separators on the Contents API; that request can never succeed and comes back 403/404 regardless of token permissions. This is the first thing to fix.
- `ensureRepo` always creates via `POST /user/repos`, which fails when the connected `github_login` is an organization.
- No branch is sent on the Contents write, but the build row is hardcoded to `branch: "main"`.
- `dispatchBuild` flips the row to `queued` *before* touching GitHub, so the UI shows "Queued on GitHub" during a dispatch that has not happened yet.
- `assertRepoWritable` only checks `permissions.push`; it never probes the workflow-file write, which is a separate PAT permission.

### Changes

- Encode Contents API paths per segment (never encode `/`), and pass an explicit `branch` equal to the repository's real default branch on both read and write. Store that same branch on the build row instead of a hardcoded `main`.
- `ensureRepo`: try `POST /user/repos` when the login is the authenticated user, otherwise `POST /orgs/{login}/repos`; resolve which one applies from `GET /user`.
- Preflight before any state change: verify repo access, push permission, and a real write to `.github/workflows/` (the workflow-permission probe). Any 401/403/404 stops the dispatch with the existing actionable `explainGithubError` message naming the exact missing permission.
- Dispatch state machine: keep the row in `pending` while claiming it with a short-lived claim marker so a double-click or retry still cannot dispatch twice; move to `queued` only after GitHub confirms both the dispatch and a matching run id. On any failure the row lands in `failed` with the real GitHub message and stays retryable.
- Verify the full flow end to end: dispatch -> run id correlation -> `refreshBuildStatus` -> `/api/public/build-finalize` -> artifact download, and confirm the finalize path cannot resurrect a failed dispatch.

### UI state correction (only this)

On the build page the three stage rows currently treat `failed` as "done" for "Queued on GitHub" and "Building APK". They will be derived from real progress instead: queued is only complete when a `github_run_id` exists, building is only complete when the run actually started, and a dispatch-stage failure marks the first stage failed rather than green.

## 2. Android: "Preferences plugin is not implemented on android"

### What the code actually does today

- The plugin audit treats a plugin as registered when it appears in `capacitor.settings.gradle` **and** `capacitor.build.gradle`. Presence in `android/app/src/main/assets/capacitor.plugins.json` is logged but never enforced — yet that file is exactly what the Android bridge reads to register plugin classes at runtime. A plugin can pass the current gate and still be "not implemented" in the APK.
- `@capacitor/preferences` is only auto-installed when a heuristic regex (`localstorage|sessionstorage|persist`) or a literal source hit fires, so a project that imports it only in bundled/transpiled output can reach `cap sync` without the package present.

### Changes

- Make `capacitor.plugins.json` registration a hard gate: for every resolved native plugin that ships an `@CapacitorPlugin` class, require an entry in `capacitor.plugins.json` in addition to the Gradle wiring. Missing entries feed the existing repair ladder (reinstall at core major -> `cap sync` -> `cap update` -> full native regeneration) and, if still missing, fail the build with a precise diagnostic naming each unregistered package.
- Widen plugin discovery so imports found in built web assets (not just `src/`) count, and detect `@capacitor/preferences` from any `Preferences` usage of the Capacitor API — applied generically to every plugin, not special-cased for Preferences.
- Keep the ordering explicit and enforced: install -> web build -> platform generation/repair -> `cap sync android` -> native plugin validation -> manifest/deep-link/MainActivity patches -> Gradle -> APK verification. The native-config repair step already runs after sync; confirm the last-resort `rm -rf android` regeneration inside the sync step also re-runs before those patches so nothing is lost.
- Extend the post-build APK verification to unzip the release APK and assert `assets/capacitor.plugins.json` inside the APK lists every expected plugin, so a stale or overwritten asset cannot ship.
- No JS fallback, no error suppression.
-  **Alsosometimes it doent get the dns id of app even if the app file have it solve that as well**

## Technical notes

- Files touched: `src/lib/github.server.ts`, `src/lib/pipeline.functions.ts`, `src/lib/android-workflow.ts`, `src/routes/_authenticated/build.$id.tsx`. A small migration may be needed for the dispatch claim marker.
- Tokens stay in the database and server runtime only; nothing new is logged or returned to the client except the human-readable GitHub error text.
- Validation: typecheck, plus assertions over the generated workflow YAML confirming the new gates and step order exist.