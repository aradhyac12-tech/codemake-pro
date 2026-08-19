# Import the APK/IPA builder, then audit and repair the pipeline

This project is currently an empty starter. Step one is to bring the uploaded `webtonative-forge-main` codebase in so it runs in preview; step two is the production audit and repair pass across the whole build pipeline.

## Phase 1 — Get the app running in preview

1. Copy the uploaded source into the project (excluding `node_modules`, `.env`, and any git metadata): routes, `src/lib`, `src/integrations`, UI components, styles, config.
2. Enable Lovable Cloud and apply the project's database migrations (builds, build_logs, keystores, github_connections, storage buckets for `build-sources` / `build-artifacts`), including grants and RLS. Two migration files in the upload are empty and will be dropped.
3. Reconcile dependencies (jszip, tweetnacl, supabase, etc.), install, and confirm `/`, `/auth`, `/dashboard`, `/new-build`, `/build/$id`, `/settings` all render.
4. Verify typecheck, lint and build pass before touching pipeline logic.

## Phase 2 — Upload, detection and validation fixes

- **Bundle ID detection**: today only `capacitor.config.*` `appId` is read, so most zips report "no bundle ID detected". Extend detection to `android/app/build.gradle` (`applicationId`/`namespace`), `AndroidManifest.xml` package, `app.json`/`app.config`, iOS `PRODUCT_BUNDLE_IDENTIFIER`, then a safe derived suggestion from the app name (`com.<slug>.app`) the user can edit. Show the source of the detected value.
- **webDir guessing**: stop preferring `public/`. Treat the zip-time value as a hint only, add `.output/public`, `dist/client`, `build/client`, `.next`/`out`, and mark TanStack Start / Nitro / Next projects as "resolve after build".
- **False-positive validators**: only packages whose metadata actually declares Capacitor native code are treated as plugins — Radix and ordinary npm packages are never flagged.
- Clear, actionable failure reasons for every rejection path instead of generic text.

## Phase 3 — Start Android Build UI reliability

- Deterministic enabled/disabled state with a visible reason for every disabled case (no GitHub connection, no keystore for release, missing bundle ID, upload in flight, invalid Node, existing in-flight build).
- Single-submission guard: mutation lock + idempotent build creation, so double clicks cannot create two builds.
- The build row is created and its ID shown before dispatch; dispatch failure marks the build `failed` with the real GitHub error rather than leaving it stuck in "starting".
- No infinite spinners: bounded polling with timeouts, refresh-safe state (status resumed from the database), retry that works after network loss.
- "Build started" is shown only after GitHub returns an accepted `workflow_dispatch` and the run is located.

## Phase 4 — GitHub dispatch and workflow hardening

- Classify GitHub failures explicitly: missing/expired/invalid token, missing scopes, repo or workflow file missing, branch mismatch, rate limit, timeout — each mapped to a specific user-facing message and retriable flag.
- Bounded `findRunForBuild` polling with timeout instead of open-ended waiting.
- Workflow YAML audit: package-manager selection from the real lockfile (npm / bun / pnpm / yarn), no duplicate installs, `set -euo pipefail` everywhere, stderr preserved, no command failure converted into success, correct Java/Android SDK setup, caching, artifact + diagnostics upload, finalize callback.

## Phase 5 — Native generation, plugins, signing, artifact

- Ordered gates: deps → build → resolve webDir from actual output → validate `index.html` → cap init → `cap add android` → patch manifest/permissions/deep links → install and verify plugins → `cap sync` → verify `capacitor.plugins.json` registration (repair + re-sync once, then hard fail) → Gradle.
- Deep links driven by the project's configured scheme/host (no hardcoded DuoSpace), with `launchMode`, `onNewIntent` and the VIEW/BROWSABLE intent filter verified in the generated manifest.
- Supabase redirect validation is reported in diagnostics only — auth URLs are never rewritten silently.
- Signing preflight before Gradle: keystore present, readable, correct format, password valid, alias present, Gradle signing config points at the same file; secrets never printed. Debug/unsigned path skips release signing entirely.
- Artifact validation: APK opens as a ZIP, manifest present, package ID and versionCode match, plugin metadata packaged, deep-link filter present when configured, signature verified. Gradle exit 0 alone never marks a build `COMPLETED`.
- The runtime OAuth smoke test is separated from build validation, given a short timeout, and reported as `NOT_RUN` / `ENVIRONMENT_LIMITATION` — it can never block or fail the APK build.

## Phase 6 — State machine, diagnostics, verification

- Explicit stages: `QUEUED → PREPARING → INSTALLING_DEPENDENCIES → BUILDING_WEB → GENERATING_NATIVE → SYNCING_CAPACITOR → VALIDATING_NATIVE → BUILDING_ANDROID → SIGNING → VALIDATING_ARTIFACT → COMPLETED`, with failures carrying stage, category, real error, probable cause, recommended action, and a retriable flag.
- One structured diagnostic report per build (detection, package manager, Node/Capacitor/Gradle/Java versions, resolved webDir, plugins declared vs registered, manifest and deep-link checks, signing status, artifact validation) surfaced on the build page.
- Close with typecheck, lint, production build, workflow YAML validation, and a browser pass over upload → detection → Start Build enable/disable → dispatch error → retry.

## Honest limitations

Native compilation, real signing, and device OAuth cannot execute inside Lovable. Those paths are validated at source and workflow level; the actual APK is produced only on the GitHub runner with your token and keystore. Any result from a real run will be reported as such, never fabricated.

## Technical notes

Files in scope: `src/lib/validate-zip.ts`, `src/lib/android-workflow.ts`, `src/lib/ios-workflow.ts`, `src/lib/github.server.ts`, `src/lib/pipeline.functions.ts`, `src/routes/_authenticated/new-build.tsx`, `build.$id.tsx`, `settings.tsx`, the `api/public/*` callbacks, and the Cloud migrations.