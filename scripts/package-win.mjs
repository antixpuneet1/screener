#!/usr/bin/env node
// Builds a self-contained Windows .exe using Node's official Single Executable
// Application (SEA) feature: bundle the app to one CJS file with esbuild, fetch
// the real Windows node.exe from nodejs.org, and inject the app's code into it
// with postject. No prebuilt-binary hosting service is involved (avoids relying
// on third-party GitHub release infrastructure for the Node runtime itself).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, cpSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUILD_DIR = path.join(ROOT, "build");
const RELEASE_DIR = path.join(ROOT, "release");
const NODE_VERSION = process.env.SEA_NODE_VERSION || "v22.23.2";
const NODE_EXE_URL = `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`;
const BASE_EXE_CACHE = path.join(BUILD_DIR, `node-win-x64-${NODE_VERSION}.exe`);
const OUTPUT_EXE = path.join(RELEASE_DIR, "fno-ol-screener.exe");

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT });
}

async function ensureBaseNodeExe() {
  if (existsSync(BASE_EXE_CACHE)) {
    console.log(`Using cached Windows Node.js ${NODE_VERSION} runtime: ${BASE_EXE_CACHE}`);
    return;
  }
  console.log(`Downloading Windows Node.js ${NODE_VERSION} runtime from nodejs.org...`);
  const res = await fetch(NODE_EXE_URL);
  if (!res.ok) throw new Error(`Failed to download ${NODE_EXE_URL}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(BUILD_DIR, { recursive: true });
  writeFileSync(BASE_EXE_CACHE, buf);
  console.log(`Saved ${(buf.length / 1e6).toFixed(1)} MB to ${BASE_EXE_CACHE}`);
}

async function main() {
  mkdirSync(BUILD_DIR, { recursive: true });
  mkdirSync(RELEASE_DIR, { recursive: true });

  console.log("\n== 1/5: Bundling app to a single CommonJS file ==");
  run("npx", [
    "esbuild",
    "src/server.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node18",
    "--outfile=build/server.cjs",
  ]);

  console.log("\n== 2/5: Fetching the Windows Node.js runtime ==");
  await ensureBaseNodeExe();

  console.log("\n== 3/5: Generating the SEA blob ==");
  const seaConfigPath = path.join(BUILD_DIR, "sea-config.json");
  writeFileSync(
    seaConfigPath,
    JSON.stringify(
      {
        main: "build/server.cjs",
        output: "build/sea-prep.blob",
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
      },
      null,
      2,
    ),
  );
  run("node", ["--experimental-sea-config", seaConfigPath]);

  console.log("\n== 4/5: Copying the base Windows runtime ==");
  copyFileSync(BASE_EXE_CACHE, OUTPUT_EXE);

  console.log("\n== 5/5: Injecting the app into the executable ==");
  run("npx", [
    "postject",
    OUTPUT_EXE,
    "NODE_SEA_BLOB",
    path.join(BUILD_DIR, "sea-prep.blob"),
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    "--overwrite",
  ]);

  console.log("\n== Assembling the release folder ==");
  cpSync(path.join(ROOT, "public"), path.join(RELEASE_DIR, "public"), { recursive: true });
  copyFileSync(path.join(ROOT, ".env.example"), path.join(RELEASE_DIR, ".env.example"));
  writeFileSync(path.join(RELEASE_DIR, "README-DIST.txt"), DIST_README);

  const sizeMb = (statSync(OUTPUT_EXE).size / 1e6).toFixed(1);
  console.log(`\nDone: ${OUTPUT_EXE} (${sizeMb} MB)`);
  console.log(`Release folder ready: ${RELEASE_DIR}`);
  console.log("Zip up and ship the whole release/ folder as-is — see README-DIST.txt inside it.");
}

const DIST_README = `F&O O=L Screener - Windows build
=================================

This folder is a complete, self-contained copy of the screener. Keep these
two items together in the same folder:

  fno-ol-screener.exe   <- the app
  public/               <- the dashboard's web assets (required)

Settings are entered in the app itself and saved to settings.json here.

Setup
-----
1. Double-click fno-ol-screener.exe. No config file editing needed.
2. Your browser opens to the dashboard. Click "Settings" (top right).
3. Paste your Upstox access token, click "Test token" to confirm it works,
   then "Save". The screener starts immediately - no restart required.

You do NOT need to create a .env file. It is supported (see .env.example)
if you prefer setting things that way, but the Settings page is the easy
path and overrides .env.

Getting an Upstox access token
-------------------------------
Tokens come from the Upstox OAuth login flow and EXPIRE DAILY around
3:30am IST, so expect to paste a fresh one each trading day. See the
project README for the four-step login flow.

Just want to see it work first?
--------------------------------
In Settings, set "Data source" to "Mock (simulated, no token needed)" and
tick "Scan outside market hours". Save. The dashboard fills with simulated
contracts so you can confirm everything runs before dealing with tokens.

What happens when you run it
-----------------------------
A console window opens (this is normal - it shows live log output) and your
default browser opens automatically to the live dashboard. Closing the
console window stops the screener. During market hours it continuously
rescans every NSE F&O stock's CE/PE contracts across all strikes/expiries
for Open = Low; outside market hours it stays idle rather than showing
stale data.

Where your token is stored
---------------------------
In settings.json, next to this executable, in PLAIN TEXT (file permissions
are restricted to your user account). Anyone with access to your Windows
account can read it. Use "Clear token" in Settings to remove it. The
dashboard listens on 127.0.0.1 only, so it is not reachable from other
machines on your network.

Troubleshooting
----------------
- Red banner "No Upstox access token configured" - expected on first run;
  open Settings and add your token.
- "Upstox rejected this token (401/403)" - the token is wrong or expired
  (they last less than a day). Generate a fresh one.
- Nothing shows up in the table - that's expected outside NSE market hours
  (09:15-15:30 IST, Mon-Fri) or before any contract has actually printed
  Open = Low today; check the status bar at the top of the dashboard.
- Windows SmartScreen warning on first run - this build isn't code-signed
  (it's a local/self-built tool), so Windows may warn about an unrecognized
  publisher. Choose "More info" -> "Run anyway" if you trust the build.
`;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
