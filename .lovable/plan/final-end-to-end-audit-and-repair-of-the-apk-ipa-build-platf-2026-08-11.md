# Final end-to-end audit and repair of the APK/IPA build platform

No UI redesign, no new features. Everything below is reliability, correctness, or automatic repair inside the existing screens and pipeline.

## 0. The token rejection you just hit (first fix)

Today the GitHub token is validated in the browser: Settings calls `https://api.github.com/user` directly from the page and turns *any* non-OK response into the single string "GitHub rejected that token. Check scopes: repo + workflow." A genuine, working token fails here for reasons unrelated to scopes — a trailing newline or space from pasting, a preview-iframe/network failure that never reaches GitHub, or a fine-grained PAT that authenticates fine but answers that probe differently.

Fix:

- Move validation into a server function, so no browser-to-GitHub call is involved.
- Trim the pasted value; reject only if empty after trimming.
- Read `X-OAuth-Scopes` and report exactly which of `repo` / `workflow` is missing instead of guessing. Fine-grained PATs return no scope header — treat them as valid and verify capability by probing repo contents and Actions access.
- Distinguish 401 (bad/expired), 403 (blocked, or SSO authorization required — surface the SSO hint), 429/rate limit (show reset time), and network failure. Each gets its own message and a retry affordance.
- Store the detected account login, token type and granted scopes so later dispatch failures can name the missing permission rather than failing generically.

## 1. Build pipeline reliability

- All GitHub calls go through one client with bounded retry on 5xx/429 honouring `Retry-After`, request timeouts, and a typed error classifier (`unauthorized`, `forbidden_scope`, `sso_required`, `not_found`, `rate_limited`, `timeout`, `server_error`) mapped to a user-facing sentence plus a `retriable` flag.
- Dispatch order: create build row, upload sources, push workflow, dispatch, locate run with bounded polling. A failure at any step marks the build `failed` with the real GitHub error and the stage it died in — never left "starting".
- Stuck-build watchdog: each build carries a stage timestamp; a build with no progress past its stage budget is marked failed with "no runner progress for N minutes" and made retriable. Applied on every status refresh and on build-page load, so a refresh never shows an eternal spinner.
- Retry creates a fresh build row linked to the original instead of mutating a terminal one. Cancel calls the provider cancel endpoint and only then writes `cancelled`.
- Duplicate prevention keeps the atomic `pending -> queued` claim already landed, plus a dedupe check so retrying an already-running build is refused with a clear message rather than firing a second run.
- Finalize endpoints become idempotent and never overwrite a terminal status.

## 2. Universal Capacitor preparation (in the generated workflow)

Ordered, idempotent gates, each blocking the next:

1. Detect package manager from the real lockfile (bun / pnpm / yarn / npm) and Node from `.nvmrc` / `.node-version` / `engines`.
2. Install dependencies with the matching command; failures surface the actual installer output.
3. Detect the Capacitor major version from `package.json`, align `@capacitor/cli`, `core`, `android`, `ios` to that major, install any missing ones.
4. Run the project's build script; infer it from the framework when absent.
5. Resolve `webDir` from the built output and verify `index.html` exists; on failure report the directories actually found.
6. `cap init` only when no config exists; `cap add android` only when `android/` is absent or incomplete; repair a partial `android/` (missing gradlew, `capacitor.settings.gradle`, MainActivity) by regenerating instead of failing.
7. `cap sync android` then `cap copy android`. Gradle never runs before sync succeeds.

## 3. Plugin registration (the "Browser plugin is not implemented" class of bug)

- After sync, read `android/app/src/main/assets/capacitor.plugins.json` and diff it against every Capacitor plugin declared in `package.json`.
- On mismatch: reinstall the missing plugin, re-run `cap sync`, re-check once. Only a second failure is fatal, and the error names the exact unregistered plugins.
- The final APK check re-reads the packaged `capacitor.plugins.json` from the APK itself, so registration is proven in the artifact, not just the workspace.

## 4. OAuth and deep links (generic, driven by project config)

Scheme and host come from the uploaded project's configuration — nothing hardcoded to a single app; a project configured with `duospace://auth` gets exactly that.

- Manifest: VIEW/BROWSABLE intent-filter for the configured scheme and host, `MainActivity` with `launchMode="singleTask"` so a warm app receives the callback in the existing activity.
- The workflow asserts the intent-filter and launch mode in the merged manifest, then re-asserts them against the built APK's manifest.
- Diagnostics (reported, never silently rewritten): the redirect URL the project's auth config uses, whether `@capacitor/browser` and `@capacitor/app` are installed and registered, whether an `appUrlOpen` listener exists in the source, and whether PKCE is configured so the verifier survives the browser round-trip.
- Cold-start, warm-app, cancel and expired-callback paths are covered by those manifest/launch-mode/listener checks. The web login path is untouched.

## 5. Permissions

Derived from what the project actually uses: INTERNET always; camera, microphone, notifications, location, Bluetooth, biometric and storage only when a matching plugin or manifest usage is detected. Background location is never added automatically. Storage permissions are emitted per API level. Everything added is listed in the diagnostics.

## 6. Signing

Preflight before Gradle: keystore decodes, is a valid keystore, the password opens it, the alias exists in it, and the Gradle signing config points at that same file and alias. A mismatch fails before `packageRelease` with a precise message. Debug/unsigned requests skip release signing entirely. Secrets are masked everywhere. After Gradle the signature is verified with `apksigner` and the artifact is labelled unsigned / debug-signed / release-signed.

## 7. Toolchain

The workflow pins JDK 17, sets up the Android SDK, build-tools and platform without Android Studio, uses the Gradle wrapper with caching, and checks the Capacitor to Android Gradle Plugin pairing, upgrading the wrapper when that pairing requires it.

## 8. Final APK validation

APK opens as a ZIP; applicationId and versionCode match the request; app label and icon present; `capacitor.plugins.json` present with the expected plugins; required permissions present; deep-link intent-filter present when configured; signature verified for release. Gradle exit 0 alone never marks a build successful.

## 9. iOS readiness

Same structure for iOS: install, build, `cap add/sync ios`, plugin registration check, URL-scheme and `Info.plist` usage descriptions, signing preflight, archive/export, IPA collection — with certificate and provisioning requirements reported as external prerequisites. iOS configuration problems can never fail an Android build.

## 10. Dashboard reliability

A pass over upload, detection, build creation, Start Android / Start iOS (each disabled state carries a visible reason), logs, polling (bounded, stops on terminal, resumes after refresh), artifact download (signed-URL refresh on expiry), retry, cancel, GitHub connection and settings, plus the Cloud queries and storage paths behind them. Dead buttons, null states and stale polling get fixed in place.

## Verification

Typecheck, lint, production build, YAML validation of both generated workflows, a unit pass over the detection / derivation / plugin-diff / permission-derivation helpers, and a browser pass over connect-token, upload, detect, start, dispatch-error, retry, download.

## Honest limits

Native compilation, real signing, real APK inspection and on-device OAuth run only on the GitHub or macOS runner with your token, keystore and Apple credentials. Everything here is validated at source and workflow level; I will not report a runner result I did not observe. Apple certificates/provisioning profiles and a valid GitHub token with `repo` + `workflow` remain external requirements.

## Files in scope

`src/routes/_authenticated/settings.tsx`, `new-build.tsx`, `build.$id.tsx`, `dashboard.tsx`, `src/lib/github.server.ts`, `pipeline.functions.ts`, `android-workflow.ts`, `ios-workflow.ts`, `validate-zip.ts`, `codemagic.server.ts`, `src/routes/api/public/*`, plus a Cloud migration for watchdog timestamps and token metadata.

&nbsp;

**Also add auto delete builds older than 1 month even those which are in github workflow** 