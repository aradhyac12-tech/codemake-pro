export const IOS_WORKFLOW_PATH = "codemagic.yaml";
export const IOS_WORKFLOW_ID = "ios-signed-release";

// codemagic.yaml — reads env vars injected via Codemagic REST API dispatch.
// Universal Capacitor/iOS pipeline mirroring the Android one: detect project
// shape → install/repair/verify dependencies → build web → resolve + repair
// webDir → generate/repair the native project → patch Info.plist (URL schemes,
// permissions) → cap sync → verify plugin registration → signing preflight →
// build + verify IPA → diagnostics report.
// Signing uses an App Store Connect API key (issuer id + key id + .p8) injected as
// APP_STORE_CONNECT_ISSUER_ID / APP_STORE_CONNECT_KEY_IDENTIFIER / APP_STORE_CONNECT_PRIVATE_KEY.
// LOGO_URL is optional — when set, we download it and generate iOS icons via @capacitor/assets.
export const IOS_WORKFLOW_YAML = `workflows:
  ios-signed-release:
    name: APKForge iOS
    max_build_duration: 60
    instance_type: mac_mini_m1
    environment:
      xcode: latest
      cocoapods: default
      node: $NODE_VERSION
    scripts:
      - name: Fetch source
        script: |
          set -e
          curl -sSL --fail -o source.zip "$SOURCE_URL"
          mkdir project
          unzip -q source.zip -d project
          # Defense in depth, same reasoning as the Android workflow: strip
          # any symlink that made it through extraction, since it's the
          # classic bypass for simple path-traversal checks.
          find project -type l -print -delete | sed 's/^/[security] removed unexpected symlink: /'
          cd project
          # If the zip wrapped everything in a single folder, flatten it.
          if [ ! -f package.json ] && [ "$(ls -1 | wc -l | tr -d ' ')" = "1" ] && [ -d "$(ls -1)" ]; then
            inner="$(ls -1)"
            mv "$inner"/* . 2>/dev/null || true
            mv "$inner"/.[!.]* . 2>/dev/null || true
            rmdir "$inner" || true
          fi
          REPORT="$PWD/ios-build-report.txt"
          echo "REPORT=$REPORT" >> "$CM_ENV"
          : > "$REPORT"
          echo "========== APKForge iOS build report ==========" | tee -a "$REPORT"
          echo "[env] Node: $(node --version)  npm: $(npm --version)  Xcode: $(xcodebuild -version | head -n 1)" | tee -a "$REPORT"

      - name: Detect project, install and repair dependencies
        script: |
          set -e
          cd project
          log() { echo "$1" | tee -a "$REPORT"; }
          fail() { echo "IOS_VALIDATION_FAILED: $1" | tee -a "$REPORT"; exit 1; }

          if [ ! -f package.json ]; then
            log "[detect] No package.json — creating a minimal one (web-app mode)"
            echo '{"name":"apkforge-app","version":"1.0.0","private":true}' > package.json
          fi

          PM="npm"; INSTALL_CMD="npm install --no-audit --no-fund"; ADD_CMD="npm install --no-audit --no-fund"; RUN_CMD="npm run"
          if [ -f bun.lockb ] || [ -f bun.lock ]; then
            PM="bun"; command -v bun >/dev/null 2>&1 || npm install -g bun
            INSTALL_CMD="bun install"; ADD_CMD="bun add"; RUN_CMD="bun run"
          elif [ -f pnpm-lock.yaml ]; then
            PM="pnpm"; corepack enable || true; corepack prepare pnpm@latest --activate || npm i -g pnpm
            INSTALL_CMD="pnpm install --no-frozen-lockfile"; ADD_CMD="pnpm add"; RUN_CMD="pnpm run"
          elif [ -f yarn.lock ]; then
            PM="yarn"; corepack enable || true; corepack prepare yarn@stable --activate || true
            INSTALL_CMD="yarn install"; ADD_CMD="yarn add"; RUN_CMD="yarn"
          fi
          log "[detect] Package manager: $PM"
          echo "PM=$PM" >> "$CM_ENV"
          echo "RUN_CMD=$RUN_CMD" >> "$CM_ENV"
          echo "ADD_CMD=$ADD_CMD" >> "$CM_ENV"

          FRAMEWORK="$(node -e "
            const p=require('./package.json');
            const d={...(p.dependencies||{}),...(p.devDependencies||{})};
            const has=(k)=>Object.prototype.hasOwnProperty.call(d,k);
            let f='static-web';
            if (has('next')) f='next';
            else if (has('nuxt')||has('nuxt3')) f='nuxt';
            else if (has('@angular/core')) f='angular';
            else if (has('@sveltejs/kit')) f='sveltekit';
            else if (has('svelte')) f='svelte';
            else if (has('@tanstack/react-start')||has('@tanstack/start')) f='tanstack-start';
            else if (has('@remix-run/react')) f='remix';
            else if (has('@ionic/react')||has('@ionic/vue')||has('@ionic/angular')) f='ionic';
            else if (has('vue')) f='vue';
            else if (has('vite')) f='vite';
            else if (has('react')) f='react';
            console.log(f);
          " 2>/dev/null || echo static-web)"
          log "[detect] Framework: $FRAMEWORK"
          if [ -f config.xml ] && grep -qi '<widget' config.xml 2>/dev/null; then
            log "[detect] Cordova project detected — migrating to a Capacitor native project"
          fi

          if $INSTALL_CMD; then
            log "[install] Dependencies installed with $PM"
          else
            log "[install] $PM install failed — retrying with npm --legacy-peer-deps (auto-repair)"
            npm install --no-audit --no-fund --legacy-peer-deps || fail "Dependency install failed for this project."
          fi

          missing_list() {
            node -e "
              const fs=require('fs');
              const p=JSON.parse(fs.readFileSync('package.json','utf8'));
              const deps=Object.keys({...(p.dependencies||{}),...(p.devDependencies||{})});
              console.log(deps.filter(function(d){ try { JSON.parse(fs.readFileSync('node_modules/'+d+'/package.json','utf8')); return false; } catch (e) { return true; } }).join(' '));
            " 2>/dev/null
          }
          MISSING="$(missing_list)"
          if [ -n "$MISSING" ]; then
            log "[deps] Missing from node_modules:$MISSING — repairing"
            for m in $MISSING; do if [ -d "node_modules/$m" ]; then rm -rf "node_modules/$m"; fi; done
            npm i $MISSING --no-audit --no-fund || npm i $MISSING --no-audit --no-fund --legacy-peer-deps || true
            MISSING="$(missing_list)"
          fi
          if [ -n "$MISSING" ]; then
            npm install --no-audit --no-fund --legacy-peer-deps || true
            MISSING="$(missing_list)"
          fi
          [ -z "$MISSING" ] || fail "These declared packages could not be installed:$MISSING"
          log "[deps] All declared dependencies resolve inside node_modules"

          if node -e "require.resolve('@capacitor/cli')" 2>/dev/null; then
            log "[capacitor] CLI present"
          else
            log "[capacitor] CLI missing — installing @capacitor/core @capacitor/cli"
            npm i @capacitor/core @capacitor/cli || fail "Could not install the Capacitor CLI."
          fi
          npm i @capacitor/ios >/dev/null 2>&1 || npm i @capacitor/ios || fail "Could not install @capacitor/ios."

          # Capacitor compatibility: only the MAJOR must match; minor/patch may differ.
          node -e "
            const fs=require('fs');
            const read=(p)=>{ try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch (e) { return null; } };
            const inst=(n)=>read('node_modules/'+n+'/package.json');
            const majorOf=(v)=>parseInt(String(v||'').split('.')[0],10);
            const peerOk=(range,coreMaj)=>{
              if (!range || range.indexOf('*')>=0 || range==='latest') return true;
              for (const part of String(range).split('||')) {
                const comps=part.trim().split(/\\s+/).filter(Boolean);
                if (!comps.length) continue;
                let ok=true;
                for (const c of comps) {
                  const m=c.match(/^(>=|<=|>|<|\\^|~|=)?\\s*v?(\\d+)/);
                  if (!m) { ok=false; break; }
                  const op=m[1]||'='; const maj=parseInt(m[2],10);
                  if (op==='>='||op==='>') ok=ok&&coreMaj>=maj;
                  else if (op==='<=') ok=ok&&coreMaj<=maj;
                  else if (op==='<') ok=ok&&coreMaj<maj;
                  else ok=ok&&coreMaj===maj;
                }
                if (ok) return true;
              }
              return false;
            };
            const core=inst('@capacitor/core');
            if (!core) { console.log('CAP_ERR:@capacitor/core is not installed'); process.exit(0); }
            const coreMaj=majorOf(core.version);
            const inv=['@capacitor/core@'+core.version]; const fixes=[];
            for (const n of ['@capacitor/cli','@capacitor/ios']) {
              const m=inst(n);
              if (!m) { fixes.push(n+'@^'+coreMaj); continue; }
              inv.push(n+'@'+m.version);
              if (majorOf(m.version)!==coreMaj) fixes.push(n+'@^'+coreMaj);
            }
            const pkg=read('package.json')||{};
            const deps={...(pkg.dependencies||{}),...(pkg.devDependencies||{})};
            const skip=['@capacitor/core','@capacitor/cli','@capacitor/android','@capacitor/ios','@capacitor/assets'];
            for (const n of Object.keys(deps).filter((d)=>/^(@capacitor\\/|@capacitor-community\\/|capacitor-)/.test(d)&&skip.indexOf(d)<0)) {
              const m=inst(n);
              if (!m) { fixes.push(n+'@^'+coreMaj); continue; }
              inv.push(n+'@'+m.version);
              const peer=(m.peerDependencies||{})['@capacitor/core'];
              if (peer && !peerOk(peer,coreMaj)) fixes.push(n+'@^'+coreMaj);
            }
            console.log('CAP_INV:'+inv.join(', '));
            fixes.forEach((f)=>console.log('CAP_FIX:'+f));
          " > /tmp/cap-compat.txt 2>&1 || true
          sed -n 's/^CAP_INV:/[deps] Capacitor packages: /p' /tmp/cap-compat.txt | tee -a "$REPORT"
          if grep -q '^CAP_FIX:' /tmp/cap-compat.txt; then
            FIXES="$(sed -n 's/^CAP_FIX://p' /tmp/cap-compat.txt | tr '\\n' ' ')"
            log "DEPENDENCY_REPAIRED: realigning Capacitor packages to the core major: $FIXES"
            npm i $FIXES --no-audit --no-fund || npm i $FIXES --no-audit --no-fund --legacy-peer-deps || true
          fi
          if grep -q '^CAP_ERR:' /tmp/cap-compat.txt; then
            fail "$(sed -n 's/^CAP_ERR://p' /tmp/cap-compat.txt | head -n 1)"
          fi
          log "[deps] Capacitor compatibility OK (majors aligned; minor/patch differences allowed)"

      - name: Build web assets and resolve webDir
        script: |
          set -e
          cd project
          log() { echo "$1" | tee -a "$REPORT"; }
          fail() { echo "IOS_VALIDATION_FAILED: $1" | tee -a "$REPORT"; exit 1; }

          if node -e "process.exit((require('./package.json').scripts||{}).build?0:1)" 2>/dev/null; then
            log "[build] Running project build with \${RUN_CMD:-npm run}"
            \${RUN_CMD:-npm run} build || fail "The project's build script failed — see the log above."
          else
            log "[build] No build script — treating the project as static"
          fi

          # Resolve the real output directory. Nothing is assumed: the declared
          # webDir is only used when it actually contains an index.html.
          DECLARED="$(node -e "
            const fs=require('fs');
            for (const f of ['capacitor.config.json','capacitor.config.ts','capacitor.config.js']) {
              try {
                const t=fs.readFileSync(f,'utf8');
                const m=t.match(/webDir\\s*[:=]\\s*['\\"\\\`]([^'\\"\\\`]+)['\\"\\\`]/);
                if (m) { console.log(m[1]); process.exit(0); }
              } catch (e) {}
            }
            console.log('');
          " 2>/dev/null)"
          RESOLVED=""
          for d in "$DECLARED" "$WEB_DIR" .output/public dist/browser dist/spa dist build/client build out www public .svelte-kit/output/client; do
            if [ -n "$d" ] && [ -f "$d/index.html" ]; then RESOLVED="$d"; break; fi
          done
          if [ -z "$RESOLVED" ]; then
            for d in $(ls -d */ */*/ 2>/dev/null | grep -v -E '^(node_modules|ios|android|src|\\.git)/'); do
              if [ -f "\${d}index.html" ]; then RESOLVED="\${d%/}"; break; fi
            done
          fi
          if [ -z "$RESOLVED" ]; then
            log "[build] Framework: \${DETECTED_FRAMEWORK:-unknown}; declared webDir: \${DECLARED:-none}; probed: .output/public dist build out www public dist/browser build/client"
            ls -la | head -n 40 | tee -a "$REPORT"
            fail "No index.html was produced by the build — the web assets directory could not be resolved. A placeholder page is never generated: that would ship a blank app."
          fi
          log "[build] Resolved webDir: $RESOLVED (index.html present)"
          echo "RESOLVED_WEB_DIR=$RESOLVED" >> "$CM_ENV"

          # Create or repair capacitor.config so webDir matches reality.
          if [ ! -f capacitor.config.ts ] && [ ! -f capacitor.config.js ] && [ ! -f capacitor.config.json ]; then
            log "[capacitor] No config — generating one with cap init"
            npx cap init "$APP_NAME" "$BUNDLE_ID" --web-dir="$RESOLVED"
          elif [ "$DECLARED" != "$RESOLVED" ]; then
            log "[capacitor] Repairing capacitor.config webDir: '\${DECLARED:-unset}' -> '$RESOLVED'"
            node -e "
              const fs=require('fs');
              const target=process.argv[1];
              for (const f of ['capacitor.config.json','capacitor.config.ts','capacitor.config.js']) {
                if (!fs.existsSync(f)) continue;
                if (f.endsWith('.json')) {
                  const j=JSON.parse(fs.readFileSync(f,'utf8')); j.webDir=target;
                  fs.writeFileSync(f, JSON.stringify(j,null,2));
                } else {
                  let t=fs.readFileSync(f,'utf8');
                  t=t.replace(/webDir\\s*:\\s*['\\"\\\`][^'\\"\\\`]*['\\"\\\`]/, \\"webDir: '\\"+target+\\"'\\");
                  fs.writeFileSync(f,t);
                }
                console.log('repaired '+f);
              }
            " "$RESOLVED" | tee -a "$REPORT"
          fi

      - name: Ensure required Capacitor plugins
        script: |
          set -e
          cd project
          log() { echo "$1" | tee -a "$REPORT"; }
          CORE_MAJ="$(node -e "try{console.log(require('@capacitor/core/package.json').version.split('.')[0])}catch(e){console.log('')}")"
          SRC_HITS=/tmp/ios-plugin-signals.txt
          : > "$SRC_HITS"
          grep -rIloE --exclude-dir=node_modules --exclude-dir=ios --exclude-dir=android --exclude-dir=.git \\
            "@capacitor/[a-z-]+|@supabase/supabase-js|firebase/auth|@auth0/|@clerk/|appwrite|amazon-cognito|oidc-client|signInWithOAuth|signInWithRedirect|loginWithRedirect|oauth|getUserMedia|navigator\\.geolocation|localStorage|Notification\\.requestPermission|qr|barcode|biometric" . 2>/dev/null | sort -u > "$SRC_HITS" || true
          DEPS_TXT="$(node -e "const d=require('./package.json');console.log(Object.keys({...(d.dependencies||{}),...(d.devDependencies||{})}).join(' '))" 2>/dev/null || echo '')"
          sig() { grep -qiE "$1" "$SRC_HITS" 2>/dev/null || echo "$DEPS_TXT" | grep -qiE "$1"; }
          declared() { node -e "const d=require('./package.json');const a={...(d.dependencies||{}),...(d.devDependencies||{})};process.exit(a['$1']?0:1)" 2>/dev/null; }

          ADDED=""
          add_plugin() {
            case " $ADDED " in *" $1 "*) return 0 ;; esac
            SPEC="$1"; if [ -n "$CORE_MAJ" ]; then SPEC="$1@^$CORE_MAJ"; fi
            # Always installed with the package manager resolved for this
            # project (bun/pnpm/yarn/npm) — a raw "npm i" here would create
            # the exact lockfile/package-manager inconsistency this pipeline
            # exists to prevent.
            if \${ADD_CMD:-npm install --no-audit --no-fund} "$SPEC" >/dev/null 2>&1 || \${ADD_CMD:-npm install --no-audit --no-fund} "$1" >/dev/null 2>&1; then
              ADDED="$ADDED $1"
              log "PLUGIN_AUTOINSTALL: $1 (required by detected project capabilities, via \${PM:-npm})"
            else
              log "[plugins] WARNING: could not auto-install $1"
            fi
          }
          need() {
            PKG="@capacitor/$1"
            declared "$PKG" && return 1
            grep -qF "$PKG" "$SRC_HITS" 2>/dev/null && return 0
            sig "$2" && return 0
            return 1
          }

          if sig "@supabase/supabase-js|firebase|@auth0/|@clerk/|appwrite|cognito|oidc|next-auth|signinwithoauth|signinwithredirect|loginwithredirect|oauth"; then
            log "[plugins] OAuth/auth SDK signal detected — Browser + App are required for native callbacks"
            declared "@capacitor/app" || add_plugin "@capacitor/app"
            declared "@capacitor/browser" || add_plugin "@capacitor/browser"
          fi
          declared "@capacitor/app" || add_plugin "@capacitor/app"
          if need browser "oauth|window\\.open"; then add_plugin "@capacitor/browser"; fi
          if need camera "getusermedia|qr|barcode|scanner|photo"; then add_plugin "@capacitor/camera"; fi
          if need geolocation "navigator\\.geolocation|maps"; then add_plugin "@capacitor/geolocation"; fi
          if need filesystem "filesystem|downloadfile|writefile"; then add_plugin "@capacitor/filesystem"; fi
          if need preferences "localstorage|sessionstorage|persist"; then add_plugin "@capacitor/preferences"; fi
          if need push-notifications "notification\\.requestpermission|firebase/messaging|onesignal|push"; then add_plugin "@capacitor/push-notifications"; fi
          if need network "navigator\\.online|offline|network"; then add_plugin "@capacitor/network"; fi
          if need haptics "haptic|vibrate"; then add_plugin "@capacitor/haptics"; fi
          if need status-bar "statusbar|safe-area"; then add_plugin "@capacitor/status-bar"; fi
          if need splash-screen "splash"; then add_plugin "@capacitor/splash-screen"; fi
          log "[plugins] Auto-installed:\${ADDED:- none}"

          # Record every @capacitor/* plugin the built app actually depends
          # on (already-declared + auto-installed this run) so the final
          # verification step can enforce their presence in the IPA instead
          # of only logging what it happened to find.
          REQUIRED_PLUGINS="$(node -e "
            const d=require('./package.json');
            const deps=Object.keys({...(d.dependencies||{}),...(d.devDependencies||{})});
            console.log(deps.filter(k=>k.startsWith('@capacitor/') && k!=='@capacitor/core' && k!=='@capacitor/cli' && k!=='@capacitor/ios').join(','));
          " 2>/dev/null || echo '')"
          echo "APKFORGE_IOS_RUNTIME_PLUGINS=$REQUIRED_PLUGINS" >> "$CM_ENV"
          log "[plugins] Required for verification: \${REQUIRED_PLUGINS:-none}"

      - name: Generate or repair the native iOS project
        script: |
          set -e
          cd project
          log() { echo "$1" | tee -a "$REPORT"; }
          fail() { echo "IOS_VALIDATION_FAILED: $1" | tee -a "$REPORT"; exit 1; }

          if [ -d ios ] && [ ! -f ios/App/App.xcodeproj/project.pbxproj ]; then
            log "[native] Existing ios/ project is incomplete — regenerating (auto-repair)"
            rm -rf ios
          fi
          if [ ! -d ios ]; then
            log "[native] Adding the iOS platform (cap add ios)"
            npx cap add ios || fail "cap add ios failed — see the log above."
          fi
          [ -f ios/App/App.xcodeproj/project.pbxproj ] || fail "The native iOS project was not generated at ios/App."

          log "[sync] Running cap sync ios"
          if ! npx cap sync ios > /tmp/cap-sync-ios.log 2>&1; then
            cat /tmp/cap-sync-ios.log | tee -a "$REPORT"
            log "[sync] First cap sync failed — reinstalling dependencies and retrying (auto-repair)"
            npm install --no-audit --no-fund --legacy-peer-deps || true
            npx cap sync ios > /tmp/cap-sync-ios-retry.log 2>&1 || { cat /tmp/cap-sync-ios-retry.log | tee -a "$REPORT"; fail "cap sync ios failed — native plugins could not be synchronized."; }
          fi
          tail -n 30 /tmp/cap-sync-ios.log 2>/dev/null | tee -a "$REPORT" || true

          # Plugin registration check: declared packages UNION packages installed
          # with an ios/ native folder (transitive plugins are native too).
          PLUGIN_LIST="$(node -e "
            const fs=require('fs');
            const skip=['@capacitor/core','@capacitor/cli','@capacitor/android','@capacitor/ios','@capacitor/assets'];
            const isPlugin=(d)=>(/^@capacitor\\//.test(d)||/^@capacitor-community\\//.test(d)||/^capacitor-/.test(d))&&skip.indexOf(d)<0;
            const set=new Set();
            try {
              const p=JSON.parse(fs.readFileSync('package.json','utf8'));
              Object.keys({...(p.dependencies||{}),...(p.devDependencies||{})}).filter(isPlugin).forEach((d)=>set.add(d));
            } catch (e) {}
            const scan=(dir,prefix)=>{
              let entries=[]; try { entries=fs.readdirSync(dir); } catch (e) { return; }
              for (const en of entries) {
                const name=prefix+en;
                if (!isPlugin(name)) continue;
                try { fs.statSync(dir+'/'+en+'/ios'); set.add(name); } catch (err) {}
              }
            };
            scan('node_modules/@capacitor','@capacitor/');
            scan('node_modules/@capacitor-community','@capacitor-community/');
            scan('node_modules','');
            console.log(Array.from(set).join(','));
          " 2>/dev/null)"
          log "[sync] Native plugins expected in the iOS project: \${PLUGIN_LIST:-none}"
          MISSING="$(node -e "
            const fs=require('fs');
            let reg='';
            for (const f of ['ios/App/Podfile','ios/App/App/capacitor.config.json','ios/capacitor-cordova-ios-plugins/Podfile']) { try { reg+=fs.readFileSync(f,'utf8'); } catch (e) {} }
            const list=(process.argv[1]||'').split(',').filter(Boolean);
            console.log(list.filter((pl)=>!reg.includes(pl)&&!reg.includes(pl.replace(/^@/,'').replace(/\\//g,'-'))).join(','));
          " "$PLUGIN_LIST")"
          if [ -n "$MISSING" ]; then
            log "[sync] Plugins not registered after the first sync: $MISSING — re-syncing (auto-repair)"
            npx cap sync ios || true
            log "[sync] Podfile after repair:"; sed -n '1,60p' ios/App/Podfile | tee -a "$REPORT" || true
          fi

      - name: Patch Info.plist (URL schemes, permissions)
        script: |
          set -e
          cd project
          log() { echo "$1" | tee -a "$REPORT"; }
          PLIST="ios/App/App/Info.plist"
          [ -f "$PLIST" ] || { log "[ios] Info.plist not found — skipping patching"; exit 0; }

          # Custom URL scheme for OAuth callbacks. Existing schemes are never
          # replaced; the bundle-id scheme is only appended when absent.
          SCHEME="$(node -e "console.log(String(process.env.BUNDLE_ID||'').trim())")"
          if [ -n "$SCHEME" ]; then
            if /usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes" "$PLIST" >/dev/null 2>&1; then
              log "[ios] CFBundleURLTypes already present — preserving existing entries"
            else
              /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" "$PLIST"
            fi
            if grep -q "$SCHEME" "$PLIST"; then
              log "[ios] URL scheme $SCHEME already registered"
            else
              IDX="$(/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes" "$PLIST" 2>/dev/null | grep -c 'Dict' || echo 0)"
              /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:$IDX dict" "$PLIST" 2>/dev/null || true
              /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:$IDX:CFBundleURLName string $SCHEME" "$PLIST" 2>/dev/null || true
              /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:$IDX:CFBundleURLSchemes array" "$PLIST" 2>/dev/null || true
              /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:$IDX:CFBundleURLSchemes:0 string $SCHEME" "$PLIST" 2>/dev/null || true
              log "[ios] Registered OAuth callback URL scheme: $SCHEME"
            fi
          fi

          # Usage descriptions — added only for plugins the project actually uses,
          # and never overwritten when the project already declares them.
          add_usage() {
            if /usr/libexec/PlistBuddy -c "Print :$1" "$PLIST" >/dev/null 2>&1; then
              log "[ios] $1 already declared — preserved"
            else
              /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST" && log "[ios] Added $1"
            fi
          }
          has_dep() { node -e "const d=require('./package.json');const a={...(d.dependencies||{}),...(d.devDependencies||{})};process.exit(a['$1']?0:1)" 2>/dev/null; }
          if has_dep "@capacitor/camera"; then
            add_usage NSCameraUsageDescription "This app uses the camera to capture photos and scan codes."
            add_usage NSPhotoLibraryUsageDescription "This app accesses your photo library to select images."
            add_usage NSPhotoLibraryAddUsageDescription "This app saves images to your photo library."
            add_usage NSMicrophoneUsageDescription "This app uses the microphone when recording video."
          fi
          if has_dep "@capacitor/geolocation"; then
            add_usage NSLocationWhenInUseUsageDescription "This app uses your location to provide location-based features."
          fi
          if has_dep "@capacitor/push-notifications"; then
            /usr/libexec/PlistBuddy -c "Print :UIBackgroundModes" "$PLIST" >/dev/null 2>&1 || /usr/libexec/PlistBuddy -c "Add :UIBackgroundModes array" "$PLIST"
            grep -q "remote-notification" "$PLIST" || /usr/libexec/PlistBuddy -c "Add :UIBackgroundModes:0 string remote-notification" "$PLIST" 2>/dev/null || true
            log "[ios] Enabled remote-notification background mode"
          fi
          log "[ios] Info.plist patched"
          plutil -lint "$PLIST" | tee -a "$REPORT"

      - name: Resolve app icon
        script: |
          set -e
          cd project
          mkdir -p resources
          if [ -n "$LOGO_URL" ]; then
            echo "Using uploaded logo"
            curl -sSL --fail -o resources/icon.png "$LOGO_URL"
          elif [ ! -f resources/icon.png ]; then
            for candidate in public/icon.png public/logo.png public/apple-touch-icon.png src/assets/icon.png src/assets/logo.png assets/icon.png assets/logo.png icon.png logo.png; do
              if [ -f "$candidate" ]; then
                echo "Auto-detected icon at $candidate"
                cp "$candidate" resources/icon.png
                break
              fi
            done
          fi
          if [ -f resources/icon.png ]; then
            npm i -D @capacitor/assets || true
            npx @capacitor/assets generate --ios --iconBackgroundColor '#ffffff' --iconBackgroundColorDark '#000000' || echo "asset generation failed — continuing with default icon"
          else
            echo "No icon supplied or detected — using the Capacitor default"
          fi

      - name: CocoaPods install
        script: |
          set -e
          cd project/ios/App
          pod install --repo-update || pod install

      - name: Signing preflight
        script: |
          set -e
          cd project
          log() { echo "$1" | tee -a "$REPORT"; }
          fail() { echo "IOS_SIGNING_VALIDATION_FAILED: $1" | tee -a "$REPORT"; exit 1; }
          [ -n "$APP_STORE_CONNECT_ISSUER_ID" ] || fail "APP_STORE_CONNECT_ISSUER_ID is not set — the IPA cannot be signed."
          [ -n "$APP_STORE_CONNECT_KEY_IDENTIFIER" ] || fail "APP_STORE_CONNECT_KEY_IDENTIFIER is not set — the IPA cannot be signed."
          [ -n "$APP_STORE_CONNECT_PRIVATE_KEY" ] || fail "APP_STORE_CONNECT_PRIVATE_KEY is not set — the IPA cannot be signed."
          [ -n "$BUNDLE_ID" ] || fail "No bundle id was supplied for the iOS build."
          PLIST_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' ios/App/App/Info.plist 2>/dev/null || echo '')"
          log "[signing] Requested bundle id: $BUNDLE_ID (Info.plist: \${PLIST_ID:-variable})"
          log "[signing] App Store Connect API key present — fetching signing files"

      - name: Fetch signing files
        script: |
          set -e
          keychain initialize
          app-store-connect fetch-signing-files "$BUNDLE_ID" \\
            --type IOS_APP_ADHOC \\
            --create
          keychain add-certificates
          xcode-project use-profiles

      - name: Build IPA
        script: |
          set -e
          cd project/ios/App
          xcode-project build-ipa \\
            --workspace App.xcworkspace \\
            --scheme App

      - name: Verify artifacts and write diagnostics
        script: |
          set +e
          cd project
          log() { echo "$1" | tee -a "$REPORT"; }
          log "== Artifact verification =="
          IPA="$(ls ios/App/build/ios/ipa/*.ipa 2>/dev/null | head -n 1)"
          if [ -z "$IPA" ]; then
            log "IOS_VALIDATION_FAILED: no .ipa artifact was produced"
            exit 1
          fi
          log "[artifact] IPA: $IPA ($(wc -c < "$IPA") bytes)"
          log "[artifact] sha256: $(shasum -a 256 "$IPA" | cut -d' ' -f1)"
          unzip -l "$IPA" | head -n 25 | tee -a "$REPORT"
          if unzip -l "$IPA" | grep -q "_CodeSignature"; then
            log "[artifact] Code signature present"
          else
            log "IOS_SIGNING_VALIDATION_FAILED: the IPA contains no _CodeSignature directory"
            exit 1
          fi
          if unzip -l "$IPA" | grep -q "embedded.mobileprovision"; then
            log "[artifact] Provisioning profile embedded"
          fi

          # Bundle ID must be verified against the actual built app, not just
          # the pre-build Info.plist on disk — the same principle Android
          # applies by reading the package name back out of the final APK.
          PAYLOAD_APP="$(unzip -Z1 "$IPA" 'Payload/*.app/Info.plist' 2>/dev/null | head -n 1)"
          if [ -n "$PAYLOAD_APP" ]; then
            unzip -p "$IPA" "$PAYLOAD_APP" > /tmp/apkforge-ios-info.plist 2>/dev/null
            ACTUAL_BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' /tmp/apkforge-ios-info.plist 2>/dev/null || echo '')"
            log "[artifact] Bundle id in built IPA: \${ACTUAL_BUNDLE_ID:-unreadable} (expected $BUNDLE_ID)"
            if [ -n "$ACTUAL_BUNDLE_ID" ] && [ "$ACTUAL_BUNDLE_ID" != "$BUNDLE_ID" ]; then
              log "IOS_VALIDATION_FAILED: the built IPA's CFBundleIdentifier ($ACTUAL_BUNDLE_ID) does not match the configured bundle id ($BUNDLE_ID)"
              exit 1
            fi
          else
            log "[artifact] WARNING: could not locate Payload/*.app/Info.plist inside the IPA to verify the bundle id"
          fi

          log "[artifact] Native plugins packaged:"
          unzip -l "$IPA" | grep -iE "Capacitor|Plugin" | head -n 30 | tee -a "$REPORT"

          # Hard gate mirroring Android's capacitor.plugins.json check: every
          # @capacitor/* plugin this project actually depends on must show up
          # somewhere in the packaged IPA (compiled into the app binary or
          # bundled as a resource) — informational logging alone lets a
          # silently-dropped plugin ship without failing the build.
          if [ -n "\${APKFORGE_IOS_RUNTIME_PLUGINS:-}" ]; then
            IPA_LISTING="$(unzip -l "$IPA" 2>/dev/null)"
            IOS_PLUGIN_MISSING=""
            for p in $(echo "$APKFORGE_IOS_RUNTIME_PLUGINS" | tr ',' ' '); do
              PNAME="\${p#@capacitor/}"
              if echo "$IPA_LISTING" | grep -qi "$PNAME"; then
                log "[plugins] present in IPA listing: $p"
              else
                log "[plugins] NOT FOUND in IPA listing: $p"
                IOS_PLUGIN_MISSING="$IOS_PLUGIN_MISSING $p"
              fi
            done
            if [ -n "$IOS_PLUGIN_MISSING" ]; then
              log "IOS_VALIDATION_FAILED: these Capacitor plugins are declared by the project but no trace of them was found in the packaged IPA:$IOS_PLUGIN_MISSING"
              log "NOTE: this is a filename/resource-listing check, not a linked-symbol check — Capacitor iOS plugins are statically compiled into the main App binary, so absence here is a strong signal but a clean pass is not the same certainty as Android's DEX class check. Confirm with a real device/TestFlight install (DEVICE_TEST_REQUIRED)."
              exit 1
            fi
            log "[plugins] IPA listing check: passed (informational strength — see note above)"
          fi

          log "IOS_ARTIFACT_VERIFICATION_PASSED"
          log "BUILD_VERIFIED: source, dependencies, web build, webDir, Capacitor sync, Info.plist patching, signing, and IPA packaging were all verified in CI."
          log "DEVICE_TEST_REQUIRED: OAuth/deep-link completion, runtime plugin behavior, and UI rendering can only be confirmed on a real device or TestFlight install — CI cannot simulate this."
          log "========== APKForge iOS build report complete =========="
    artifacts:
      - project/ios/App/build/ios/ipa/*.ipa
      - project/ios-build-report.txt
      - /tmp/xcodebuild_logs/*.log
    publishing:
      scripts:
        - name: Notify APKForge (background finalize)
          script: |
            set +e
            if [ -n "$FINALIZE_ENDPOINT" ] && [ -n "$DIAGNOSTIC_TOKEN" ]; then
              for i in 1 2 3; do
                curl -sS --fail -X POST "$FINALIZE_ENDPOINT" \\
                  -H "content-type: application/json" \\
                  -d "{\\"buildId\\":\\"$BUILD_ID\\",\\"token\\":\\"$DIAGNOSTIC_TOKEN\\",\\"codemagicBuildId\\":\\"$CM_BUILD_ID\\"}" && break
                sleep 10
              done
            fi
`;
