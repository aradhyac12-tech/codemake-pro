# Universal Build Hub

Do a complete production-grade audit and repair of this APK/IPA builder website. Do NOT only explain problems. Inspect the entire codebase, find every bug, race condition, incorrect assumption, broken validation, CI failure, UI failure, dependency issue, GitHub dispatch issue, Capacitor issue, Android generation issue, signing issue, and artifact issue, then FIX them in the project.



This is a UNIVERSAL MULTI-PROJECT web builder. Do not hardcode DuoSpace, FamilySphere, or any single application. Every uploaded project must be handled dynamically.



PRIMARY GOAL:

A user uploads a web/Capacitor project ZIP → builder detects project → installs/resolves all dependencies → generates or repairs Capacitor Android project → installs/registers every required Capacitor plugin → applies permissions and deep links → builds web assets correctly → runs Capacitor sync → validates native project → signs APK/AAB → builds with Gradle on GitHub Actions → validates the actual APK → returns downloadable artifact and complete diagnostics.



The website itself must reliably start the build. No dead buttons, silent failures, infinite loading, false success states, or builds that proceed when prerequisites are missing.



IMPORTANT KNOWN FAILURES TO FIX:



1. WEB ASSET DIRECTORY FAILURE

We previously got:

"The web assets directory (./.output/public) must contain an index.html file."



The builder incorrectly resolved WEB_DIR=public while Capacitor actually expected .output/public for some TanStack Start projects.



Implement robust project detection:

- Detect Vite, React/Vite, Next, TanStack Start, static HTML, and existing Capacitor projects.

- Detect the actual build output directory AFTER running the project's build command.

- Never blindly assume public/ is the Capacitor webDir.

- Locate the directory containing the final index.html.

- Validate index.html before cap add/sync.

- For TanStack Start, correctly build first and resolve the generated public output.

- Make capacitor.config dynamically use the resolved webDir.

- If multiple possible outputs exist, use deterministic detection rules and log the selected directory.

- Never call cap add/sync with an invalid webDir.

- If no index.html exists, fail early with a clear actionable error instead of generating a broken Android project.



2. CAPACITOR PROJECT GENERATION MUST BE COMPLETE

The pipeline must correctly perform, in order:



dependency installation

→ project build

→ Capacitor initialization if required

→ Android platform generation if required

→ native configuration patching

→ plugin installation verification

→ Capacitor sync

→ native validation

→ Gradle build.



Use the project's actual package manager:

- npm if package-lock.json

- bun if bun.lock/bun.lockb

- pnpm if pnpm-lock.yaml

- yarn if yarn.lock



Do NOT assume npm or bun.



Before running Capacitor commands:

- verify Node

- verify package manager

- install dependencies

- verify @capacitor/core

- verify @capacitor/cli

- verify @capacitor/android

- verify every declared Capacitor plugin

- install missing required packages automatically where safe

- run the project's build command

- verify index.html exists

- only then run Capacitor.



3. CAPACITOR PLUGIN REGISTRATION BUG

We previously had:



"these Capacitor plugins were not registered in the native Android project"



and earlier:



"Browser plugin is not implemented on android"



The builder must NEVER consider a plugin installed merely because it exists in package.json.



After npm/bun/pnpm/yarn install:

- inspect package.json

- identify every Capacitor plugin

- verify package actually exists in node_modules

- run `npx cap sync android`

- inspect generated capacitor.plugins.json

- verify every required plugin is registered

- if registration is missing, automatically repair it by correctly installing/syncing the plugin

- rerun sync

- verify again

- do not proceed to Gradle until registration is complete.



Pay special attention to:

@capacitor/app

@capacitor/browser

@capacitor/device

@capacitor/geolocation

@capacitor/haptics

@capacitor/local-notifications

@capacitor/network

@capacitor/preferences

@capacitor/push-notifications

@capacitor/splash-screen

@capacitor/status-bar

and any third-party Capacitor plugins actually declared by the uploaded project.



Do NOT maintain a brittle hardcoded plugin list as the source of truth. Detect plugins dynamically from package.json and Capacitor metadata, while allowing a small critical-plugin validation list.



The dependency validator must also stop producing false positives for normal npm packages such as Radix UI packages. Only packages that actually require native Capacitor registration should be checked as native plugins.



4. @capacitor/browser MUST WORK ON ANDROID

The current DuoSpace symptom is:



Google sign-in opens the browser

Google authentication completes

the callback returns toward the APK

but authentication does not finish.



There was also:

"Browser plugin is not implemented on android"



Fix the builder so the generated APK actually contains and registers @capacitor/browser.



After sync, verify:

android/app/src/main/assets/capacitor.plugins.json



contains the Browser plugin.



Do not simply suppress the runtime error.



5. DUOSPACE AUTH DEEP LINK

For uploaded projects that use a native OAuth callback, support custom URL schemes generically.



For DuoSpace:

duospace://auth

duospace://auth/reset-password



The Android native manifest must contain the appropriate VIEW intent filter:

ACTION_VIEW

DEFAULT

BROWSABLE

scheme=duospace

host=auth



Do not hardcode DuoSpace globally. Read the configured native scheme/host from the project's configuration when available.



Ensure:

- MainActivity receives deep links

- correct launchMode is used where required

- onNewIntent is handled correctly

- Capacitor App plugin receives appUrlOpen

- cold-start callbacks are handled with getLaunchUrl

- duplicate callback events cannot exchange the same PKCE code twice

- exchangeCodeForSession cannot hang forever

- browser is closed after callback where appropriate

- callback errors are surfaced clearly.



The existing diagnostic indicates the source-level PKCE/deep-link implementation already has appUrlOpen/getLaunchUrl handling and duplicate/race protection, so do not unnecessarily rewrite working authentication code. Focus on making the GENERATED NATIVE PROJECT actually contain the required native configuration and plugins. 



6. SUPABASE REDIRECT VALIDATION

Do not silently change authentication URLs.



For projects using Supabase:

- detect configured redirect URIs

- validate native redirect URI

- validate web redirect URI

- expose missing redirect URLs in build diagnostics

- do not claim OAuth is fixed unless the native callback is actually configured.



For DuoSpace the expected native callback is:

duospace://auth



and reset:

duospace://auth/reset-password



7. ANDROID NATIVE PROJECT MUST BE FULLY GENERATED WITHOUT ANDROID STUDIO

The GitHub runner must perform everything normally done manually through Android Studio/terminal:



- install dependencies

- generate Capacitor Android

- install/register plugins

- generate Android project

- patch manifest

- patch permissions

- configure Gradle

- configure application ID

- configure app name

- configure version/versionCode

- copy web assets

- generate resources/icons

- sync Capacitor

- clean Gradle

- assemble APK/AAB

- sign artifact

- validate artifact.



The user must NOT need Android Studio.



8. GRADLE TOOLCHAIN

Detect and use compatible:

- Java/JDK

- Gradle wrapper

- Android Gradle Plugin

- compileSdk

- targetSdk

- minSdk.



Do not blindly upgrade versions.



Use the Gradle wrapper generated/provided by the project where possible.



Run:

./gradlew --version

./gradlew clean

./gradlew assembleRelease



Capture the real failure rather than hiding it.



9. SIGNING

Previously Gradle failed with:



"No key with alias '***' found in keystore"



Implement proper signing preflight.



Before Gradle release build:

- verify keystore exists

- verify keystore is readable

- verify alias exists

- verify password works

- verify signing configuration points to the same keystore

- never expose passwords in logs

- never print private signing material

- fail BEFORE Gradle if signing is invalid

- clearly identify whether the problem is keystore, alias, password, or configuration.



If unsigned/debug APK is requested, build debug APK without release signing.



If release signing is requested and credentials are missing/invalid, stop with a precise error.



10. ICONS AND RESOURCES

Do not allow icon generation/sync to break Capacitor.



Validate:

- launcher icons

- adaptive icons

- splash assets

- Android resources

- package/application ID

- manifest references.



If an icon tool/package is missing, install/use a reliable compatible mechanism or fall back safely.



11. GITHUB ACTIONS

Audit the complete GitHub workflow.



Fix:

- checkout

- Node setup

- Java setup

- Android SDK setup

- package-manager setup

- dependency installation

- caching

- build

- artifact upload

- build status reporting

- diagnostics upload

- finalization callback.



The workflow must never depend on Android Studio.



Avoid unnecessary repeated npm/bun installs.



Every shell command must have proper error handling.



Do not swallow stderr.



Do not turn a failed command into a successful build.



12. BUILD BUTTON / WEBSITE BUGS

The "Start Android Build" button currently has cases where it cannot be clicked or does nothing.



Audit the entire frontend build flow:

- button disabled conditions

- form validation

- upload state

- build state

- authentication state

- project selection

- missing configuration

- stale build records

- network errors

- GitHub dispatch errors

- Supabase errors

- loading states

- race conditions

- React query/mutation states

- optimistic state updates.



The button must:

- always have a deterministic enabled/disabled reason

- show why it is disabled

- prevent double submission

- create exactly one build

- immediately show build ID/status

- survive page refresh

- recover from network interruption

- allow retry

- never remain permanently loading.



13. GITHUB PUSH / WORKFLOW DISPATCH

Audit all GitHub integration.



Handle:

- missing token

- expired token

- invalid token

- wrong repository

- wrong owner

- private repository permissions

- workflow permissions

- workflow file missing

- branch mismatch

- dispatch failure

- GitHub API rate limits

- network timeout

- artifact retrieval failure.



Never show "Build started" unless GitHub actually accepted the workflow dispatch.



Never wait forever for GitHub.



Use bounded polling with timeout and clear status transitions.



14. "RUNTIME OAUTH CALLBACK SMOKE TEST" TIMEOUT

We previously had a GitHub action named:

"Runtime OAuth callback smoke test"

that timed out after 15 minutes.



This must NOT block the production APK build indefinitely.



Separate:

BUILD validation

from

DEVICE/RUNTIME OAuth validation.



A real Android device is required for some runtime OAuth tests.



If the runner cannot perform a genuine device test:

- mark it as NOT_RUN or ENVIRONMENT_LIMITATION

- do not call it FAILED

- do not hang for 15 minutes

- enforce a short timeout

- continue the APK build when compilation is otherwise valid.



15. BUILD STATE MACHINE

Implement a reliable state machine:



QUEUED

→ PREPARING

→ INSTALLING_DEPENDENCIES

→ BUILDING_WEB

→ GENERATING_NATIVE

→ SYNCING_CAPACITOR

→ VALIDATING_NATIVE

→ BUILDING_ANDROID

→ SIGNING

→ VALIDATING_ARTIFACT

→ COMPLETED



Failure states should identify the exact stage.



Never show generic:

"Workflow failure. See logs."



Instead show:

stage

error category

actual error

probable cause

recommended action

retriable/non-retriable.



16. ARTIFACT VALIDATION

After APK generation, inspect the actual APK.



Validate:

- APK exists

- APK is non-zero

- APK can be opened as ZIP

- AndroidManifest.xml exists

- package/application ID is correct

- version/versionCode exists

- expected Capacitor plugin metadata exists

- Browser plugin exists if declared

- App plugin exists

- deep-link intent filter exists when configured

- APK signing is valid

- APK is installable according to available static validation.



Do not mark build COMPLETED merely because Gradle returned 0.



17. NO FALSE VALIDATION

Remove validators that incorrectly fail valid projects.



Especially:

- do not classify Radix UI packages as Capacitor plugins

- do not require every npm dependency to appear in capacitor.plugins.json

- do not assume every project has android/

- do not assume every project uses public/

- do not assume every project uses npm

- do not assume every project uses Vite

- do not assume every project uses Supabase

- do not assume every project uses OAuth.



18. AUTO-REPAIR

Where safe, automatically repair:

- missing Capacitor config

- missing Android platform

- missing npm/bun/pnpm/yarn dependencies

- missing Capacitor platform package

- missing native plugin registration

- missing Capacitor sync

- stale native project

- missing manifest deep-link configuration

- missing generated web output.



Do not silently modify application business logic.



19. DIAGNOSTICS

Create one structured build diagnostic report containing:



project detection

package manager

Node version

Capacitor version

web build command

resolved webDir

index.html path

native platform

all Capacitor packages

registered native plugins

missing plugins

manifest checks

deep-link checks

Gradle version

Java version

Android SDK

signing status

GitHub workflow status

artifact path

artifact validation

final result.



20. IDE/TYPECHECK/LINT

Before committing fixes:

- run TypeScript typecheck

- run lint

- run build

- validate all modified scripts

- validate workflow YAML

- validate package.json

- ensure no broken imports

- ensure no dead code

- ensure no duplicate configuration.



21. DO NOT JUST PATCH THE CURRENT ERROR

Trace the entire pipeline end-to-end and fix the architecture so the next predictable failure is caught before reaching Gradle.



Use defensive programming, explicit validation gates, deterministic state transitions, bounded timeouts, structured logging, and actionable errors.



After implementing everything:

1. run all available checks

2. inspect every modified file

3. test the Start Android Build UI flow

4. test project upload

5. test project detection

6. test dependency installation logic

7. test web output detection

8. test Capacitor generation logic

9. test plugin registration validation

10. test GitHub dispatch logic

11. test failure/retry states

12. test artifact handling.



Do not stop after fixing one error.



At the end, provide:

- exact files changed

- exact bugs found

- exact fixes implemented

- remaining limitations that genuinely require GitHub/device credentials

- final build pipeline sequence

- commands/workflows used for validation.



IMPORTANT:

Do not fabricate successful APK/iOS builds. If the Lovable environment cannot execute native compilation, implement and validate the complete pipeline code and GitHub workflow, and clearly distinguish source-level validation from real runner/device validation.

Also solve no budle id detected issue

The final website must be a reliable UNIVERSAL APK/IPA BUILD PLATFORM, not a DuoSpace-specific builder.

Pull the app and in repo and make it avl for preview

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://codemake-pro.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/34d70abe-2650-4343-b266-28d2e6e4d2e0).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? This repo uses [Bun](https://bun.sh) as its sole package manager (see `bunfig.toml` / `bun.lock`) — do not run `npm install` here, it will regenerate a stray `package-lock.json` that drifts from `bun.lock`.

```sh
git clone <this-repository-url>
cd <repository-name>
bun install
bun run dev
```
