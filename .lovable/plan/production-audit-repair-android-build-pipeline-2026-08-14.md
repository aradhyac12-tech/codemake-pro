# Production audit & repair — Android build pipeline

Verified in the current repo before writing this plan:
- Both `bun.lock` and `package-lock.json` exist at the root, and the generated Android workflow mixes managers: it selects a PM (`android-workflow.ts:93-103`) but then runs raw `npm i` / `npm install` for the Capacitor CLI, `@capacitor/android`, plugin auto-install, sync repair and Browser install (lines 148, 167, 183-185, 253, 757, 847, 862, 1006, 1239).
- The web build is soft-failed: `[web] WARNING: build script failed — continuing with existing web assets` (`android-workflow.ts:421`). iOS already hard-fails (`ios-workflow.ts:198`).
- The Android source ZIP signed URL is 1 hour (`pipeline.functions.ts:264`) while the workflow allows `timeout-minutes: 75` (`android-workflow.ts:28`).
- Dispatch already uses an atomic `dispatching` stage and only sets `queued` after a run ID is found (`pipeline.functions.ts:100-107, 317`), and a stuck-build watchdog exists.
- `new-build.tsx` gates the button on a single `!canStart || creating`, with no distinct "checking requirements" / reason states.

Everything below repairs the existing pipeline in place. No new pipeline, no UI redesign, no iOS/Codemagic removal.

## Phase 1 — Deterministic toolchain (workflow generator)

1. Single package manager: resolve from `packageManager` first, then lockfile precedence (bun / pnpm / yarn / npm). If several lockfiles exist and `packageManager` is absent, pick the declared primary and log the decision explicitly; fail with an actionable diagnostic when genuinely ambiguous. Replace every hardcoded `npm i` / `npm install` with `$INSTALL_CMD` / `$ADD_CMD` / `$EXEC_CMD` helpers so one dependency tree is used end to end. Remove the "fall back to npm" branches inside the PM case statements.
2. Single Node version: resolve from `.nvmrc` / `.node-version` / `engines.node`, raise it to Capacitor's minimum when needed, and use that one version for install, web build, Capacitor CLI, `cap add`, `cap sync` and native prep — deleting the mid-run Node 24 switch. Fail before touching the native project if the requested version is unsupported.
3. Emit a dependency report (PM, lockfile, Node, Capacitor core/CLI/android, native plugins + versions, duplicate Capacitor copies, peer conflicts).

## Phase 2 — Web build & webDir

- Web build failure becomes fatal; stale-asset continuation is deleted. Clean generated output before building, then verify output dir exists, has `index.html`, is non-empty, and contains JS/CSS.
- webDir resolution order: explicit Capacitor `webDir` → framework mapping (TanStack Start / Nuxt `.output/public`, Next export `out`, Astro/Vite `dist`, CRA `build`, Angular `dist/<project>`, SvelteKit actual output) → directory that actually contains the generated `index.html` → generic. Existence alone never qualifies; `public/` never wins for TanStack Start. The post-build resolved dir is persisted separately from the ZIP-time guess.

## Phase 3 — ZIP / root / bundle ID (`validate-zip.ts`)

- Detect the real application root (supports `apps/mobile/…` monorepos), ignore `node_modules`, `.git`, `.idea`, `.vscode`, `__MACOSX`, caches, and normalize wrapper dirs. When several candidate roots have a build script + Capacitor/native project, report the candidates and require an explicit choice instead of guessing.
- Bundle ID search order: capacitor.config.* → `build.gradle` → `build.gradle.kts` → AndroidManifest → pbxproj → Info.plist → app.json → app.config.* → Expo android/ios ids → nested roots → derived fallback. Gradle matching handles both `applicationId "x"` and `applicationId = "x"`, plus `namespace` in both forms. Source is always shown, the value stays editable, and a valid detected ID is never overwritten.

## Phase 4 — Capacitor native generation & plugins

- Existing `android/` is inspected, not blindly regenerated; regeneration is reported and followed by re-patching (permissions, deep links, MainActivity), `cap sync`, and full re-validation. `cap add` failure is only tolerated when the scaffold is provably valid.
- Generic plugin verification chain per plugin: JS package → node_modules → Android source → `@CapacitorPlugin` class → `capacitor.settings.gradle` module → `capacitor.build.gradle` dependency → `capacitor.plugins.json` entry → compiled class in the APK DEX. Any missing layer fails the build with a precise diagnostic.
- Discovery from source imports, dynamic imports, built JS, `registerPlugin("X")`, dependencies and node_modules native metadata — with a mapper so Radix/UI packages are never treated as native plugins. `@capacitor/preferences`, `@capacitor/browser` and `@capacitor/app` get explicit end-to-end gates.
- MainActivity validation: must extend `BridgeActivity`, preserve `super.onCreate` / `super.onNewIntent` / `setIntent`, and never introduce a partial explicit plugin registration list. Diagnostics injection stays additive.

## Phase 5 — Permissions, deep links, signing

- Replace the broad regex permission mapping with a plugin/API-driven matrix validated against target/min SDK; no obsolete storage or unrelated location permissions.
- Custom scheme derived from Capacitor config / auth redirect in source / native project / user input, bundle ID only as fallback — no hardcoded `duospace`. Verify VIEW+DEFAULT+BROWSABLE and the scheme inside the final APK manifest, plus `singleTask` where the callback needs it. Supabase redirect URLs are reported, never modified.
- Signing pre-Gradle: decode keystore, verify format, store password, alias enumeration, key password, private-key entry, certificate; post-Gradle verify APK signature and record the certificate SHA-256. Debug builds skip release signing. No password ever printed.

## Phase 6 — APK inspection & artifact

- Strengthen post-Gradle checks: valid ZIP, manifest present, package ID equals configured bundle ID, versionCode/versionName, signature valid and expected cert, web assets, `assets/capacitor.plugins.json` complete, required plugin classes present in `classes*.dex`, deep-link filters, non-truncated, SHA-256 recorded.
- Remove the long runtime OAuth smoke test as a blocking gate; real-device OAuth is reported as `DEVICE_TEST_REQUIRED`.
- Artifact retrieval: run completed → artifact exists → release APK extracted → validated → uploaded → storage object verified → only then `success`, with bounded exponential-backoff retries and no full re-downloads on every poll.

## Phase 7 — Server, state machine and UI

- Signed URLs: source ZIP lifetime raised well beyond the 75-minute CI budget (6h); same review applied to icon and callback URLs. Artifact download URL stays short-lived.
- Make finalizer and polling idempotent — terminal states are never resurrected or overwritten; success only after artifact validation.
- Explicit stages (`QUEUED … COMPLETED`) persisted, and the build page derives every stage marker from real evidence (run ID, stage rows, artifact) so a dispatch failure can never render green Queued/Building.
- GitHub error mapping made explicit for 401/403/404/409/422/429/5xx/timeout with the actionable text from the brief; dispatch preflight keeps token → repo → push → workflow-write → default branch → write → verify → dispatch → match run ordering, and removes the permission-probe file afterwards.
- Upload/create ordering: validate → upload source → verify object → create build row → dispatch; orphaned logo/source cleaned up on failure; no build row without a verified source; no dispatch without a row; dispatch failure leaves a failed/retryable build. Retry keeps creating a new row and never double-dispatches.
- `Start Android Build` gets explicit states: Checking requirements / Ready / Missing GitHub / Missing keystore / Invalid bundle ID / Uploading source / Creating build / Dispatching / Dispatch failed, with the failure reason and a retry action instead of a silently disabled button, and a single-submission guard.

## Phase 8 — iOS parity (non-breaking)

Apply the same PM determinism, fatal web build, webDir resolution, bundle-ID logic, plugin verification, Info.plist/signing validation and finalization idempotency to the Codemagic path without changing its architecture.

## Validation

Typecheck, lint, production build, plus programmatic assertions on the generated Android YAML: no remaining `npm` calls on a non-npm path, no soft web-build failure, no mid-build Node switch, source URL lifetime > CI timeout, and Preferences/Browser/App verified through APK DEX. Anything requiring a physical device is reported as NOT DEVICE VERIFIED.

## Notes

- The repo keeps both lockfiles for the APKForge site itself; the determinism rules above apply to uploaded projects. I can also drop `package-lock.json` from this repo (Bun is the site's manager) if you want that cleaned up too.
