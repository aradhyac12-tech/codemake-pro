import JSZip from "jszip";

export const MAX_COMPRESSED_BYTES = 500 * 1024 * 1024; // 500 MB
export const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
export const MAX_ENTRIES = 50_000;

const STRIP_PREFIXES = [
  "node_modules/",
  ".git/",
  "build/",
  ".next/",
  ".output/",
  ".turbo/",
  ".cache/",
  "android/.gradle/",
  "android/app/build/",
  "android/build/",
  "ios/Pods/",
  "ios/build/",
  "ios/DerivedData/",
];

const STRIP_SUFFIXES = [".DS_Store"];

function normalize(path: string): string {
  return path.replace(/\\/g, "/");
}

export type ProjectKind = "capacitor-full" | "capacitor-partial" | "web-app";

export type NodeRequirement = {
  raw: string;
  source: "engines" | "nvmrc";
  major?: number;
  /** true when the spec pins a single major (e.g. "22", "22.x", "^22.5.0", or an .nvmrc line). */
  strict: boolean;
};

export type ValidationOk = {
  ok: true;
  originalSize: number;
  strippedSize: number;
  strippedZip: Blob;
  entryCount: number;
  strippedEntryCount: number;
  projectKind: ProjectKind;
  capacitorVersion?: string;
  packageName?: string;
  appName?: string;
  bundleId?: string;
  /** Where the bundle ID came from, so the UI can explain itself. */
  bundleIdSource?:
    | "capacitor-config"
    | "build.gradle"
    | "AndroidManifest.xml"
    | "xcode-project"
    | "app.json"
    | "derived";
  webDir?: string;
  hasAndroid: boolean;
  hasIos: boolean;
  hasCapConfig: boolean;
  nodeRequirement?: NodeRequirement;
  warnings: string[];
};

export type ValidationErr = { ok: false; reason: string };
export type ValidationResult = ValidationOk | ValidationErr;
export type ProgressFn = (phase: string, pct?: number) => void;

/** Android/iOS both require reverse-DNS ids: 2+ segments, letters first, no keywords. */
const JAVA_KEYWORDS = new Set([
  "abstract",
  "assert",
  "boolean",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "class",
  "const",
  "continue",
  "default",
  "do",
  "double",
  "else",
  "enum",
  "extends",
  "final",
  "finally",
  "float",
  "for",
  "goto",
  "if",
  "implements",
  "import",
  "instanceof",
  "int",
  "interface",
  "long",
  "native",
  "new",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "short",
  "static",
  "strictfp",
  "super",
  "switch",
  "synchronized",
  "this",
  "throw",
  "throws",
  "transient",
  "try",
  "void",
  "volatile",
  "while",
  "true",
  "false",
  "null",
]);

export function isValidBundleId(id: string): boolean {
  if (!id) return false;
  const parts = id.split(".");
  if (parts.length < 2) return false;
  return parts.every(
    (p) => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(p) && !JAVA_KEYWORDS.has(p.toLowerCase()),
  );
}

/** Build a safe reverse-DNS id from a free-form project name. */
export function deriveBundleId(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const slug = name
    .replace(/^@/, "")
    .replace(/[/\\]/g, ".")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "");
  const segs = slug
    .split(".")
    .filter(Boolean)
    .map((s) => (/^[a-z]/.test(s) ? s : `a${s}`))
    .map((s) => (JAVA_KEYWORDS.has(s) ? `${s}app` : s));
  if (segs.length === 0) return undefined;
  const candidate = ["app", ...segs].join(".");
  return isValidBundleId(candidate) ? candidate : undefined;
}

/**
 * Validate a project zip and produce a stripped version ready to upload.
 * Accepts full Capacitor projects, partial Capacitor projects, or plain web apps
 * (Vite/CRA/Next/etc.) — the workflow will auto-inject Capacitor when needed.
 */
export async function validateAndStrip(
  file: File,
  onProgress?: ProgressFn,
): Promise<ValidationResult> {
  if (!/\.zip$/i.test(file.name)) {
    return { ok: false, reason: "File must be a .zip archive." };
  }
  if (/\.(apk|aab|ipa)$/i.test(file.name)) {
    return {
      ok: false,
      reason:
        "This looks like a compiled mobile binary. We build from source only — upload the project zip instead.",
    };
  }
  if (file.size > MAX_COMPRESSED_BYTES) {
    return {
      ok: false,
      reason: `Zip is ${(file.size / 1024 / 1024).toFixed(0)} MB — larger than the 500 MB limit. Strip node_modules/build folders locally before zipping.`,
    };
  }

  onProgress?.("Reading zip", 5);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch (e) {
    return { ok: false, reason: `Could not read zip: ${(e as Error).message}` };
  }

  const files = Object.values(zip.files);
  if (files.length > MAX_ENTRIES) {
    return {
      ok: false,
      reason: `Zip has ${files.length} entries (max ${MAX_ENTRIES}). Suspicious archive — refusing to process.`,
    };
  }

  // Reject path traversal / absolute paths / symlink entries outright — a
  // malicious entry name like "../../../etc/cron.d/evil" would otherwise be
  // carried verbatim into the repackaged source zip we upload for the CI
  // runner to extract. This is the authoritative point to stop it: refusing
  // here means the unsafe content is never even packaged, regardless of
  // whatever protections the runner's own `unzip` may or may not have.
  const unsafeEntries: string[] = [];
  for (const f of files) {
    const n = normalize(f.name);
    const isSymlink = (f as unknown as { unixPermissions?: number }).unixPermissions
      ? (((f as unknown as { unixPermissions: number }).unixPermissions >>> 16) & 0xf000) === 0xa000
      : false;
    if (
      n.startsWith("/") ||
      n.startsWith("~") ||
      /^[a-zA-Z]:/.test(n) || // Windows drive letter, e.g. "C:\..."
      n.split("/").some((seg) => seg === "..") ||
      isSymlink
    ) {
      unsafeEntries.push(f.name);
    }
  }
  if (unsafeEntries.length > 0) {
    return {
      ok: false,
      reason: `Zip contains ${unsafeEntries.length} unsafe entr${unsafeEntries.length === 1 ? "y" : "ies"} (path traversal, absolute path, or symlink) — refusing to process: ${unsafeEntries.slice(0, 5).join(", ")}${unsafeEntries.length > 5 ? ", …" : ""}`,
    };
  }

  // Detect wrapper directory
  const topDirs = new Set<string>();
  for (const f of files) {
    const p = normalize(f.name);
    // Archive noise (macOS resource forks, editor metadata) must not defeat
    // wrapper-directory detection — otherwise every path stays prefixed and
    // nothing (bundle id, config, gradle) is ever found.
    if (/^(__MACOSX|\.DS_Store|\.git|\.idea|\.vscode)(\/|$)/.test(p)) continue;
    const first = p.split("/")[0];
    if (first) topDirs.add(first);
  }
  const wrapperPrefix =
    topDirs.size === 1 && !files.some((f) => normalize(f.name) === Array.from(topDirs)[0])
      ? Array.from(topDirs)[0] + "/"
      : "";

  const rel = (name: string) => {
    const n = normalize(name);
    return wrapperPrefix && n.startsWith(wrapperPrefix) ? n.slice(wrapperPrefix.length) : n;
  };

  let uncompressedTotal = 0;
  let hasPackageJson = false;
  let hasCapConfig = false;
  let hasAndroid = false;
  let hasIos = false;
  let hasIndexHtml = false;
  let hasPubspec = false;
  let hasReactNative = false;
  let packageJsonEntry: JSZip.JSZipObject | null = null;
  let capConfigEntry: JSZip.JSZipObject | null = null;
  let nvmrcEntry: JSZip.JSZipObject | null = null;
  let gradleEntry: JSZip.JSZipObject | null = null;
  let manifestEntry: JSZip.JSZipObject | null = null;
  let pbxprojEntry: JSZip.JSZipObject | null = null;
  let appJsonEntry: JSZip.JSZipObject | null = null;
  // Nested/monorepo fallbacks: same files found at any depth. Only used when
  // the canonical root-relative path is absent, shallowest path wins.
  let looseCapConfig: { depth: number; f: JSZip.JSZipObject } | null = null;
  let looseGradle: { depth: number; f: JSZip.JSZipObject } | null = null;
  let looseManifest: { depth: number; f: JSZip.JSZipObject } | null = null;
  let looseInfoPlist: { depth: number; f: JSZip.JSZipObject } | null = null;
  const seenDirs = new Set<string>();

  for (const f of files) {
    if (f.dir) continue;
    const usize: number =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (f as any)?._data?.uncompressedSize ?? 0;
    uncompressedTotal += usize;
    if (uncompressedTotal > MAX_UNCOMPRESSED_BYTES) {
      return {
        ok: false,
        reason: `Uncompressed contents exceed 2 GB — refusing to process (possible zip bomb).`,
      };
    }
    const r = rel(f.name);
    if (/(^|\/)(__MACOSX|node_modules)\//.test(r)) continue;
    const depth = r.split("/").length;
    const keepShallowest = (
      cur: { depth: number; f: JSZip.JSZipObject } | null,
    ): { depth: number; f: JSZip.JSZipObject } => (cur && cur.depth <= depth ? cur : { depth, f });
    if (/(^|\/)capacitor\.config\.(ts|mts|cts|js|mjs|cjs|json)$/.test(r)) {
      looseCapConfig = keepShallowest(looseCapConfig);
    }
    if (/(^|\/)android\/app\/build\.gradle(\.kts)?$/.test(r)) looseGradle = keepShallowest(looseGradle);
    if (/(^|\/)android\/app\/src\/main\/AndroidManifest\.xml$/.test(r)) {
      looseManifest = keepShallowest(looseManifest);
    }
    if (/(^|\/)ios\/.*\/Info\.plist$/.test(r)) looseInfoPlist = keepShallowest(looseInfoPlist);

    if (/^[^/]+\.(apk|aab|ipa)$/i.test(r)) {
      return {
        ok: false,
        reason: `Found compiled binary "${r}" in the zip. Upload source code, not built artifacts.`,
      };
    }

    if (r === "package.json") {
      hasPackageJson = true;
      packageJsonEntry = f;
    }
    if (/^capacitor\.config\.(ts|mts|cts|js|mjs|cjs|json)$/.test(r)) {
      hasCapConfig = true;
      capConfigEntry = f;
    }
    if (r === "android/app/build.gradle" || r === "android/app/build.gradle.kts") gradleEntry = f;
    if (r === "android/app/src/main/AndroidManifest.xml") manifestEntry = f;
    if (/^ios\/.*\.xcodeproj\/project\.pbxproj$/.test(r)) pbxprojEntry = f;
    if (r === "app.json") appJsonEntry = f;
    if (r === "index.html" || r === "public/index.html") hasIndexHtml = true;
    if (r === ".nvmrc" || r === ".node-version") nvmrcEntry = f;
    if (r === "pubspec.yaml") hasPubspec = true;
    if (r === "metro.config.js" || (r === "app.json" && !hasCapConfig)) {
      // hint of RN — will confirm below
    }
    if (r.startsWith("android/")) hasAndroid = true;
    if (r.startsWith("ios/")) hasIos = true;

    // track top-ish dirs
    const parts = r.split("/");
    if (parts.length > 1) seenDirs.add(parts[0]);
  }

  // Fall back to nested copies (monorepos, wrapped archives) before classifying.
  if (!capConfigEntry && looseCapConfig) {
    capConfigEntry = looseCapConfig.f;
    hasCapConfig = true;
  }
  if (!gradleEntry && looseGradle) gradleEntry = looseGradle.f;
  if (!manifestEntry && looseManifest) manifestEntry = looseManifest.f;
  if (gradleEntry || manifestEntry) hasAndroid = true;
  if (pbxprojEntry || looseInfoPlist) hasIos = true;

  // Reject Flutter
  if (hasPubspec) {
    return {
      ok: false,
      reason:
        "This looks like a Flutter project. We only build Capacitor / web-app projects — Flutter support isn't available.",
    };
  }

  // Parse package.json (needed for RN detection + Capacitor version + build script)
  type Pkg = {
    name?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    engines?: { node?: string };
  };
  let pkg: Pkg | null = null;
  if (packageJsonEntry) {
    try {
      pkg = JSON.parse(await packageJsonEntry.async("string")) as Pkg;
    } catch {
      /* not fatal */
    }
  }

  // Detect required Node — .nvmrc wins over engines.node when both exist.
  let nodeRequirement: NodeRequirement | undefined;
  if (nvmrcEntry) {
    try {
      const raw = (await nvmrcEntry.async("string")).trim();
      if (raw) nodeRequirement = parseNodeSpec(raw, "nvmrc");
    } catch {
      /* ignore */
    }
  }
  if (!nodeRequirement && pkg?.engines?.node) {
    nodeRequirement = parseNodeSpec(pkg.engines.node, "engines");
  }
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (deps["react-native"] && !hasCapConfig) {
    hasReactNative = true;
  }
  if (hasReactNative) {
    return {
      ok: false,
      reason: "This looks like a React Native project. We only build Capacitor / web-app projects.",
    };
  }

  // Classify project kind
  let projectKind: ProjectKind;
  if (hasCapConfig && (hasAndroid || hasIos)) {
    projectKind = "capacitor-full";
  } else if (hasCapConfig) {
    projectKind = "capacitor-partial";
  } else if (hasPackageJson || hasIndexHtml) {
    projectKind = "web-app";
  } else {
    return {
      ok: false,
      reason:
        "Couldn't detect a Capacitor project or a web app. Include a package.json (with a build script) or an index.html at the root of the zip.",
    };
  }

  const capacitorVersion = deps["@capacitor/core"] ?? undefined;

  // App name — Capacitor config first, else package.json
  let appName: string | undefined;
  let bundleId: string | undefined;
  let bundleIdSource: ValidationOk["bundleIdSource"];
  let capWebDir: string | undefined;
  if (capConfigEntry) {
    try {
      const capText = await capConfigEntry.async("string");
      const mId = capText.match(/appId\s*[:=]\s*['"`]([^'"`]+)['"`]/);
      if (mId && isValidBundleId(mId[1])) {
        bundleId = mId[1];
        bundleIdSource = "capacitor-config";
      }
      const mName = capText.match(/appName\s*[:=]\s*['"`]([^'"`]+)['"`]/);
      if (mName) appName = mName[1];
      const mWeb = capText.match(/webDir\s*[:=]\s*['"`]([^'"`]+)['"`]/);
      if (mWeb) capWebDir = mWeb[1].replace(/^\.\//, "").replace(/\/$/, "");
    } catch {
      /* ignore */
    }
  }

  // Fallback bundle-ID sources — native project files, then Expo-style app.json.
  if (!bundleId && gradleEntry) {
    try {
      const t = await gradleEntry.async("string");
      const m =
        t.match(/applicationId\s*=?\s*['"]([A-Za-z0-9_.]+)['"]/) ??
        t.match(/namespace\s*=?\s*['"]([A-Za-z0-9_.]+)['"]/);
      if (m && isValidBundleId(m[1])) {
        bundleId = m[1];
        bundleIdSource = "build.gradle";
      }
    } catch {
      /* ignore */
    }
  }
  if (!bundleId && manifestEntry) {
    try {
      const t = await manifestEntry.async("string");
      const m = t.match(/package\s*=\s*"([A-Za-z0-9_.]+)"/);
      if (m && isValidBundleId(m[1])) {
        bundleId = m[1];
        bundleIdSource = "AndroidManifest.xml";
      }
    } catch {
      /* ignore */
    }
  }
  if (!bundleId && pbxprojEntry) {
    try {
      const t = await pbxprojEntry.async("string");
      const m = t.match(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([A-Za-z0-9_.-]+)"?\s*;/);
      if (m && isValidBundleId(m[1])) {
        bundleId = m[1];
        bundleIdSource = "xcode-project";
      }
    } catch {
      /* ignore */
    }
  }
  if (!bundleId && appJsonEntry) {
    try {
      const j = JSON.parse(await appJsonEntry.async("string")) as {
        expo?: {
          android?: { package?: string };
          ios?: { bundleIdentifier?: string };
          name?: string;
        };
        name?: string;
      };
      const cand = j.expo?.android?.package ?? j.expo?.ios?.bundleIdentifier;
      if (cand && isValidBundleId(cand)) {
        bundleId = cand;
        bundleIdSource = "app.json";
      }
      if (!appName) appName = j.expo?.name ?? j.name;
    } catch {
      /* ignore */
    }
  }
  if (!appName) appName = pkg?.name;
  // iOS Info.plist, when the Xcode project itself only holds a build variable.
  if (!bundleId && looseInfoPlist) {
    try {
      const t = await looseInfoPlist.f.async("string");
      const m = t.match(
        /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/,
      );
      const cand = m?.[1]?.trim();
      if (cand && !cand.includes("$(") && isValidBundleId(cand)) {
        bundleId = cand;
        bundleIdSource = "xcode-project";
      }
    } catch {
      /* ignore */
    }
  }
  // Last resort: derive a valid reverse-DNS id so the build is never blocked.
  if (!bundleId) {
    const derived = deriveBundleId(appName ?? pkg?.name ?? file.name.replace(/\.zip$/i, ""));
    if (derived) {
      bundleId = derived;
      bundleIdSource = "derived";
    }
  }

  // Guess webDir (only meaningful for web-app / capacitor-partial)
  const knownWebDirs = ["www", "dist", "build", "out", "public"];
  let webDir: string | undefined;
  if (capWebDir) webDir = capWebDir;
  for (const d of knownWebDirs) {
    if (webDir) break;
    if (seenDirs.has(d)) {
      webDir = d;
      break;
    }
  }
  if (!webDir && projectKind === "web-app") {
    // Guess by build script content
    const buildScript = pkg?.scripts?.build ?? "";
    if (deps["@tanstack/react-start"] || deps["@tanstack/start"]) webDir = ".output/public";
    else if (deps["next"] && /export/.test(buildScript)) webDir = "out";
    else if (deps["astro"]) webDir = "dist";
    else if (deps["nuxt"]) webDir = ".output/public";
    else if (/vite/.test(buildScript) || deps["vite"]) webDir = "dist";
    else if (deps["react-scripts"]) webDir = "build";
    else if (deps["next"]) webDir = "out";
    else if (deps["@angular/cli"]) webDir = "dist";
    else webDir = "dist";
  }
  if (!webDir) webDir = "www";

  onProgress?.("Stripping heavy folders", 40);

  const outZip = new JSZip();
  let strippedEntries = 0;
  let processed = 0;
  const total = files.length;

  for (const f of files) {
    processed++;
    if (processed % 250 === 0) {
      onProgress?.("Stripping heavy folders", 40 + Math.floor((processed / total) * 40));
    }
    if (f.dir) continue;
    const r = rel(f.name);
    // Never strip the detected webDir if it's a static-only project (no package.json)
    const preserveWebDir = !hasPackageJson && webDir && r.startsWith(`${webDir}/`);
    if (!preserveWebDir) {
      if (STRIP_PREFIXES.some((p) => r.startsWith(p))) continue;
      // strip `dist/` only if it's not the source root
      if (r.startsWith("dist/") && hasPackageJson) continue;
    }
    if (STRIP_SUFFIXES.some((s) => r.endsWith(s))) continue;
    if (r.includes("/node_modules/")) continue;

    const content = await f.async("uint8array");
    outZip.file(r, content);
    strippedEntries++;
  }

  onProgress?.("Compressing", 85);
  // This zip only exists to be re-extracted by CI moments later — it's a
  // transport artifact, not long-term storage, so spending CPU time on a
  // tight compression ratio buys nothing. DEFLATE level 6 (the "balanced"
  // default) run synchronously on the main thread is what was making large
  // — but well under the 2GB cap — projects look stuck for minutes with no
  // feedback between 85% and 100%. Level 1 (fastest) plus a real progress
  // callback fixes both the actual duration and the perceived-stuck issue.
  const strippedZip = await outZip.generateAsync(
    {
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 1 },
    },
    (meta: { percent: number; currentFile: string | null }) => {
      onProgress?.("Compressing", 85 + Math.floor((meta.percent / 100) * 14));
    },
  );
  onProgress?.("Done", 100);

  const warnings: string[] = [];
  if (projectKind === "web-app") {
    warnings.push(
      `No Capacitor detected — we'll auto-add Capacitor in the cloud build (webDir: ${webDir}).`,
    );
  } else if (projectKind === "capacitor-partial") {
    warnings.push(
      "Capacitor config found but native folders missing — we'll add them in the cloud build.",
    );
  }
  if (!bundleId) {
    warnings.push(
      "Couldn't detect or derive a bundle ID — enter one on the next step (e.g. com.acme.app).",
    );
  } else if (bundleIdSource === "derived") {
    warnings.push(
      `No bundle ID found in the project — using "${bundleId}". Edit it on the next step if you already have one registered.`,
    );
  }
  if (nodeRequirement) {
    const src = nodeRequirement.source === "nvmrc" ? ".nvmrc" : "engines.node";
    if (nodeRequirement.major && (nodeRequirement.major < 20 || nodeRequirement.major > 24)) {
      warnings.push(
        `Project ${src} requires Node ${nodeRequirement.raw}, which is outside the supported 20–24 range. The build will likely fail.`,
      );
    }
  }

  return {
    ok: true,
    originalSize: file.size,
    strippedSize: strippedZip.size,
    strippedZip,
    entryCount: files.length,
    strippedEntryCount: strippedEntries,
    projectKind,
    capacitorVersion,
    packageName: pkg?.name,
    appName,
    bundleId,
    bundleIdSource,
    webDir,
    hasAndroid,
    hasIos,
    hasCapConfig,
    nodeRequirement,
    warnings,
  };
}

/**
 * Parse a Node version spec from .nvmrc or package.json engines.node.
 * Returns the required major when we can determine one, and marks the spec as
 * strict when it pins a single major (so the UI can hard-block mismatches).
 */
function parseNodeSpec(raw: string, source: "nvmrc" | "engines"): NodeRequirement {
  const cleaned = raw.trim().replace(/^v/i, "");
  // First integer we can find is the required (minimum) major.
  const m = cleaned.match(/(\d{1,2})/);
  const major = m ? parseInt(m[1], 10) : undefined;
  let strict = false;
  if (source === "nvmrc") {
    strict = true;
  } else {
    // engines.node: strict when the spec pins one major (e.g. "22", "22.x",
    // "^22.5.0", "~22.5.0"). Ranges like ">=20", ">=20 <25", "*" are loose.
    if (/^\s*[\^~]?\d+(\.\d+)*(\.\d+)*\s*$/.test(cleaned) || /^\s*\d+\.x\s*$/i.test(cleaned)) {
      strict = true;
    }
  }
  return { raw, source, major, strict };
}
