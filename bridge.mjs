#!/usr/bin/env node
import { spawn, execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { WebSocketServer } from "ws";

// ─── Constants ────────────────────────────────────────────────────────────────

const HOME             = os.homedir();
const POCKETHOST_DIR   = path.join(HOME, "pockethost");
const PAPER_DIR        = path.join(POCKETHOST_DIR, "paper");
const PLUGINS_DIR      = path.join(PAPER_DIR, "plugins");
const RES_PACKS_DIR    = path.join(PAPER_DIR, "resourcepacks");
const SERVER_PROPERTIES_PATH = path.join(PAPER_DIR, "server.properties");
const EULA_PATH        = path.join(PAPER_DIR, "eula.txt");
const PAPER_JAR_PATH   = path.join(PAPER_DIR, "paper.jar");
const GEYSER_JAR_PATH  = path.join(PLUGINS_DIR, "Geyser-Spigot.jar");
const VIAVERSION_JAR_PATH  = path.join(PLUGINS_DIR, "ViaVersion-5.9.1.jar");
const VIABACKWARDS_JAR_PATH = path.join(PLUGINS_DIR, "ViaBackwards-5.9.1.jar");

// Playit — proot-Debian approach.
// BEFORE: downloaded a native ARM64 binary and ran it directly in Termux.
// AFTER: PROVEN BROKEN by real device testing — playitd's IPC socket bind fails with
//        ENOENT because Termux has no /run directory (confirmed twice, including with an
//        XDG_RUNTIME_DIR workaround that did NOT fix it). Confirmed working instead: playitd
//        runs correctly inside a proot-distro Debian container. Every command and log line
//        referenced below was run/observed on a real device before being written here.
const PLAYIT_DIR          = path.join(POCKETHOST_DIR, "playit");
const PLAYIT_TUNNELS_FILE = path.join(PLAYIT_DIR, "tunnels.json");    // saved addresses (our own cache)
const DEBIAN_DISTRO       = "debian";
// Confirmed real: `proot-distro login debian -- playitd` starts the daemon non-interactively.
// Confirmed real success line: "playit connected; tunnels loaded agent_id=... tunnel_count=2
//   ... account_status=\"verified\"". Confirmed real shutdown: SIGINT triggers a clean
//   shutdown sequence ("Received Ctrl+C, shutting down" -> "playitd shutdown complete").
// Confirmed real claim flow from your own shell history: `playitd` in one session,
//   `playit setup` in a second session while the daemon is running.

const GEYSER_URL       = "https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/spigot";
const VIAVERSION_URL   = "https://github.com/ViaVersion/ViaVersion/releases/download/5.9.1/ViaVersion-5.9.1.jar";
const VIABACKWARDS_URL = "https://github.com/ViaVersion/ViaBackwards/releases/download/5.9.1/ViaBackwards-5.9.1.jar";
// BEFORE: "https://api.papermc.io/v2/projects/paper" — PaperMC's v2 downloads API was
//         deprecated Dec 31, 2025 and fully shut off July 1, 2026, returning HTTP 410 Gone.
// AFTER: PaperMC's replacement is the "Fill" API (confirmed at docs.papermc.io/misc/downloads-service/).
const PAPER_API_BASE   = "https://fill.papermc.io/v3/projects/paper";
// PaperMC's docs explicitly state requests must send a non-generic User-Agent with contact info,
// or they "may be rejected or rate-limited." wget's default UA is exactly what they reject.
const PAPER_USER_AGENT = "PocketHost/1.0 (+https://github.com/MRCube-code/Pocket-host-)";
const READY_PATTERNS   = [/Done \(/i, /\[Server thread\/INFO\].*Done/i];
const ALLOWED_BASE     = POCKETHOST_DIR;
// Persists the user's Java-only vs Java+Bedrock choice across bridge restarts —
// state.settings is in-memory only otherwise.
const MODE_FILE        = path.join(POCKETHOST_DIR, "server-mode.json");

// Confirmed real: `pkg install proot-distro -y` then `proot-distro install debian`
// (you ran this exact sequence, install took 5-8 minutes, one time only).
async function installProotDebian() {
  log("[Bridge] Installing proot-distro...");
  await runCmd("pkg", ["install", "-y", "proot-distro"]);
  log("[Bridge] Installing Debian (this takes 5-8 minutes, one time only)...");
  await runCmd("proot-distro", ["install", DEBIAN_DISTRO]);
  log("[Bridge] Debian installed");
}

// Confirmed real, run inside Debian: apt update && apt install -y curl gpg ca-certificates
//                                    && curl -fsSL https://packages.playit.gg/install.sh | bash
//
// BEFORE: treated any non-zero exit as a hard failure.
// AFTER: real evidence from your device shows the installer script's OWN final step asks
//        "Would you like to start playit now to finish setup? [Y/n]" and then tries to use
//        systemctl to start/check the service — which always fails in proot (confirmed
//        three times now: your original Debian test, this install hook, and running bare
//        `playit` interactively — all hit the exact same "not booted with systemd" error).
//        That failure happens AFTER dpkg has already installed the actual playitd binary,
//        so a non-zero exit here doesn't mean the install failed. We no longer throw on
//        this specific command's exit code — ensurePlayitReady() re-verifies with the
//        already-trusted `which playitd` check right after calling this, and only that
//        re-check decides real success or failure.
async function installPlayitInDebian() {
  log("[Bridge] Installing playit inside Debian...");
  try {
    await runCmd("proot-distro", ["login", DEBIAN_DISTRO, "--", "bash", "-c",
      "apt update && apt install -y curl gpg ca-certificates && curl -fsSL https://packages.playit.gg/install.sh | bash"
    ]);
    log("[Bridge] playit installed inside Debian");
  } catch (err) {
    log(`[Bridge] Install script exited non-zero (${err.message.slice(0, 150)}) — this is expected if it's the known systemd post-install hook; verifying playitd exists anyway...`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getLocalIp() {
  try {
    const r = execSync("ip -4 addr 2>/dev/null", { encoding: "utf8" });
    const ip = [...r.matchAll(/inet\s+([\d.]+)/g)].map(m => m[1]).find(x => !x.startsWith("127."));
    if (ip) return ip;
  } catch {}
  try {
    const r = execSync("ifconfig 2>/dev/null", { encoding: "utf8" });
    const ip = [...r.matchAll(/inet\s+(?:addr:)?([\d.]+)/g)].map(m => m[1]).find(x => !x.startsWith("127."));
    if (ip) return ip;
  } catch {}
  try {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const a of ifs[name] || []) {
        if (a.family === "IPv4" && !a.internal) return a.address;
      }
    }
  } catch {}
  return "check-wifi";
}

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  serverStatus: "stopped",
  logs: [],
  players: [],
  stats: { cpuPercent: 0, ramUsedMb: 0, ramLimitMb: 2048, tps: 20, uptimeSeconds: 0 },
  settings: {
    gamemode: "survival", difficulty: "normal", maxPlayers: 20, ramMb: 2048,
    port: 25565, bedrockPort: 19132, serverName: "PocketHost Server",
    motd: "Powered by PocketHost", onlineMode: false, viewDistance: 8,
    pvp: true, allowFlight: false, whiteList: false,
    mode: null, // 'java' | 'java_bedrock' — null means not yet chosen; set by loadServerMode()
  },
  worlds: [],
  packs: [],
  tunnel: {
    online:          false,
    // Five states the UI displays
    state:           "disconnected",  // 'connecting'|'waiting_auth'|'connected'|'disconnected'|'error'
    claimUrl:        "",              // populated when state === 'waiting_auth'
    javaAddress:     "",
    bedrockAddress:  "",
    method:          "playit",
  },
  startedAtMs: 0,
};

let serverProcess = null, playitProcess = null, playitRestartTimer = null, statsInterval = null;
let claimSetupProcess = null;   // tracks `playit setup` while it's running, so we don't
                                 // spawn duplicates and can clean it up when appropriate
const clients = new Set();

// ─── Logging & broadcast ──────────────────────────────────────────────────────

function log(line) {
  const formatted = `[${new Date().toLocaleTimeString()}] ${line}`;
  state.logs = [formatted, ...state.logs].slice(0, 500);
  broadcast("console.log", { line: formatted });
  process.stdout.write(formatted + "\n");
}

function broadcast(event, payload) {
  const msg = JSON.stringify({ type: "event", event, payload });
  for (const c of clients) { if (c.readyState === 1) try { c.send(msg); } catch {} }
}

function snapshot() {
  return {
    bridgeConnected: true,
    serverStatus:    state.serverStatus,
    logs:            state.logs,
    players:         state.players,
    stats:           state.stats,
    worlds:          state.worlds,
    packs:           state.packs,
    settings:        state.settings,
    tunnel:          state.tunnel,
    localIp:         getLocalIp(),
  };
}

// ─── Core utilities ───────────────────────────────────────────────────────────

// BEFORE: wget(url, dest) took no extra args — no way to send a required header.
// AFTER: optional extraArgs lets callers (Paper downloads) attach --header for User-Agent.
function wget(url, dest, extraArgs = []) {
  return runCmd("wget", ["-q", "--show-progress", ...extraArgs, "-O", dest, url]);
}

// BEFORE: getLatestPaperVersion/getLatestPaperBuild each hand-rolled a spawn("wget", ["-q", ...])
//         with -q suppressing wget's real stderr, so every failure just said "wget Paper API failed"
//         with zero diagnostic value (this is exactly what cost a full debugging round-trip).
// AFTER: single JSON-fetch helper that always sends the required User-Agent header and, on
//        failure, includes wget's actual exit code and stderr in the thrown error.
function wgetJson(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn("wget", ["-q", "-O", "-", "--header", `User-Agent: ${PAPER_USER_AGENT}`, url], { stdio: ["ignore", "pipe", "pipe"] });
    let data = "", stderr = "";
    proc.stdout.on("data", d => { data += String(d); });
    proc.stderr.on("data", d => { stderr += String(d); });
    proc.on("close", code => {
      if (code !== 0) { reject(new Error(`wget failed (exit ${code}) for ${url}: ${stderr.trim().slice(0, 200) || "no stderr"}`)); return; }
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error(`JSON parse failed for ${url}: ${e.message}`)); }
    });
    proc.on("error", reject);
  });
}

// Generic dotted-numeric version comparator — used to find the true latest version
// rather than trusting the API's object key order (mirrors the `sort -V -r` approach
// PaperMC's own example scripts use as a fallback).
function compareVersions(a, b) {
  const pa = String(a).split(".").map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stderr = "";
    proc.stdout.on("data", d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => log(`[setup] ${l}`)));
    proc.stderr.on("data", d => { stderr += String(d); String(d).split(/\r?\n/).filter(Boolean).forEach(l => log(`[setup] ${l}`)); });
    proc.on("error", reject);
    proc.on("close", code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 200)}`)));
  });
}

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function ensureDirs() {
  for (const d of [POCKETHOST_DIR, PAPER_DIR, PLUGINS_DIR, RES_PACKS_DIR, PLAYIT_DIR])
    await fs.mkdir(d, { recursive: true });
}

// Persists the Java-only vs Java+Bedrock choice so it survives bridge restarts.
// For an existing install that already has Geyser downloaded, infers "java_bedrock"
// from the actual file on disk rather than forcing a re-choice; a genuinely new
// install gets `mode: null`, which the UI treats as "not yet chosen."
async function loadServerMode() {
  try {
    const data = JSON.parse(await fs.readFile(MODE_FILE, "utf8"));
    if (data.mode === "java" || data.mode === "java_bedrock") { state.settings.mode = data.mode; return; }
  } catch {}
  if (await exists(GEYSER_JAR_PATH)) {
    state.settings.mode = "java_bedrock";
    await saveServerMode("java_bedrock").catch(() => {});
  } else {
    state.settings.mode = null;
  }
}

async function saveServerMode(mode) {
  await fs.mkdir(POCKETHOST_DIR, { recursive: true });
  await fs.writeFile(MODE_FILE, JSON.stringify({ mode }));
}

async function setupPhAlias() {
  try {
    const bashrc = path.join(HOME, ".bashrc");
    const alias  = `alias ph='pkill -f bridge.mjs 2>/dev/null; sleep 1; cd ~/Pocket-host-/termux && node bridge.mjs'`;
    const content = await fs.readFile(bashrc, "utf8").catch(() => "");
    if (!content.includes("alias ph=")) {
      await fs.appendFile(bashrc, `\n${alias}\n`);
      log("[Bridge] Added 'ph' shortcut — type 'ph' anytime to start bridge");
    }
  } catch {}
}

// ─── Playit (proot-Debian) ─────────────────────────────────────────────────────

// BEFORE: downloaded a native ARM64 binary — proven broken (no /run directory in Termux).
// AFTER: ensures Debian is installed (checked via `proot-distro list`'s real confirmed
//        output format) and playitd exists inside it (checked via `which`, a standard
//        Unix command, not a playit-specific guess).
async function ensurePlayitReady() {
  await fs.mkdir(PLAYIT_DIR, { recursive: true });

  // Confirmed real output format:
  //   Installed containers:
  //     * debian
  //   Log in with: proot-distro login <name>
  let listOutput = "";
  try {
    listOutput = execSync("proot-distro list 2>&1", { encoding: "utf8" });
  } catch (e) {
    listOutput = String(e.stdout || "");
  }
  const debianInstalled = new RegExp(`\\*\\s*${DEBIAN_DISTRO}\\b`).test(listOutput);

  if (!debianInstalled) {
    await installProotDebian();
  }

  let hasPlayitd = false;
  try {
    const r = execSync(`proot-distro login ${DEBIAN_DISTRO} -- which playitd 2>&1`, { encoding: "utf8" });
    hasPlayitd = r.trim().length > 0 && !r.includes("not found");
  } catch {
    hasPlayitd = false;
  }

  if (!hasPlayitd) {
    await installPlayitInDebian();
    // Re-verify with the same trusted check — this is the real authority on success,
    // not the install script's own exit code (see comment on installPlayitInDebian).
    try {
      const r2 = execSync(`proot-distro login ${DEBIAN_DISTRO} -- which playitd 2>&1`, { encoding: "utf8" });
      hasPlayitd = r2.trim().length > 0 && !r2.includes("not found");
    } catch {
      hasPlayitd = false;
    }
    if (!hasPlayitd) {
      throw new Error("playitd still not found after install attempt — real failure, not just the known systemd hook");
    }
  }
}

// Parse every line emitted by playitd running inside Debian.
//
// BEFORE: patterns were based on generic playit-agent behavior researched online, never
//         confirmed against this project's actual runtime.
// AFTER: the CONNECTED pattern is copied verbatim from a real confirmed log line from your
//        device: "playit connected; tunnels loaded agent_id=... tunnel_count=2
//        pending_tunnel_count=0 disabled_tunnel_count=0 account_status=\"verified\"".
//        The WAITING_AUTH pattern ("Waiting for frontend secret provisioning") is from your
//        own documented first-time-setup test. Tunnel address extraction is NOT yet
//        confirmed against a real address line (your test was Ctrl+C'd before one appeared) —
//        marked clearly as best-effort so it isn't mistaken for verified fact like the rest.
function parsePlayitLine(line) {
  const clean = line
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return;

  log(`[playit] ${clean}`);
  let changed = false;

  // ── CONFIRMED REAL: successful connection ─────────────────────────────────
  const connectedMatch = clean.match(/playit connected;\s*tunnels loaded.*?tunnel_count=(\d+).*?account_status="?(\w+)"?/i);
  if (connectedMatch) {
    state.tunnel.state    = "connected";
    state.tunnel.online   = true;
    state.tunnel.claimUrl = "";
    changed = true;
    log(`[playit] Connected — ${connectedMatch[1]} tunnel(s), account ${connectedMatch[2]}`);
  }

  // ── CONFIRMED REAL: not yet claimed ────────────────────────────────────────
  if (/waiting for frontend secret provisioning/i.test(clean)) {
    state.tunnel.state  = "waiting_auth";
    state.tunnel.online = false;
    changed = true;
    // Auto-trigger the claim command the instant we know we're unclaimed —
    // this is what makes the link "appear fast" instead of needing a second tap.
    startClaimSetup();
  }

  // ── Reconnection churn — CONFIRMED to happen even during a successful run,
  //    so this must NOT be treated as an error ─────────────────────────────
  if (/control session expired; reconnecting/i.test(clean)) {
    // no-op — normal, observed during your successful test too
  }

  // ── Real errors observed: network-level ping failures. Your real test showed
  //    these recovering automatically within ~2 seconds and then connecting — so
  //    don't flip to "error" here; the timeout in startPlayit() handles genuine stalls.
  if (/network unreachable|failed to (send initial ping|ping tunnel server)/i.test(clean) && state.tunnel.state !== "connected") {
    // intentionally no state change — see comment above
  }

  // ── Clean shutdown — CONFIRMED real sequence from your Ctrl+C test ────────
  if (/playitd shutdown complete/i.test(clean)) {
    state.tunnel.online = false;
    if (state.tunnel.state !== "waiting_auth") state.tunnel.state = "disconnected";
    changed = true;
  }

  // ── Tunnel address extraction — BEST EFFORT, unconfirmed against a real
  //    address line from this daemon. ply.gg is a real confirmed playit.gg
  //    domain; kept as a reasonable attempt but flagged honestly as unverified. ──
  const mapMatch = clean.match(/([a-z0-9.-]+\.ply\.gg:\d+)\s*(?:=>|->)?\s*[\d.]*:?(\d+)?/i);
  if (mapMatch) {
    const addr = mapMatch[1];
    const localPort = mapMatch[2] ? parseInt(mapMatch[2], 10) : null;
    const isBedrock = localPort != null && (localPort === state.settings.bedrockPort || localPort === 19132);
    const isUdp = /\budp\b/i.test(clean);
    if (isBedrock || isUdp) { state.tunnel.bedrockAddress = addr; log(`[playit] Bedrock → ${addr} (unconfirmed format)`); }
    else                    { state.tunnel.javaAddress    = addr; log(`[playit] Java → ${addr} (unconfirmed format)`); }
    fs.writeFile(PLAYIT_TUNNELS_FILE, JSON.stringify({
      java:    state.tunnel.javaAddress,
      bedrock: state.tunnel.bedrockAddress,
    })).catch(() => {});
    changed = true;
  }

  if (changed) broadcast("tunnel.status", { tunnel: state.tunnel });
}

async function startPlayit() {
  if (playitProcess) return;

  try {
    await ensurePlayitReady();
  } catch (err) {
    log(`[playit] Setup failed: ${err.message}`);
    state.tunnel.state  = "error";
    state.tunnel.online = false;
    broadcast("tunnel.status", { tunnel: state.tunnel });
    return;
  }

  try {
    const t = JSON.parse(await fs.readFile(PLAYIT_TUNNELS_FILE, "utf8"));
    if (t.java)    state.tunnel.javaAddress    = t.java;
    if (t.bedrock) state.tunnel.bedrockAddress = t.bedrock;
  } catch {}

  state.tunnel.state    = "connecting";
  state.tunnel.online   = false;
  state.tunnel.claimUrl = "";
  broadcast("tunnel.status", { tunnel: state.tunnel });
  log("[playit] Starting playitd inside Debian...");

  // CONFIRMED REAL on your device: `proot-distro login debian -- playitd` starts the
  // daemon non-interactively and streams stdout/stderr normally.
  // detached: true puts this in its own process group so stopPlayit() can signal the
  // whole proot-distro/proot/playitd tree at once — a plain single-PID kill isn't
  // guaranteed to reach playitd inside the proot jail, and that specific propagation
  // path wasn't part of what you tested (only interactive Ctrl+C was confirmed, which
  // the terminal itself broadcasts to the whole foreground process group automatically).
  playitProcess = spawn("proot-distro", ["login", DEBIAN_DISTRO, "--", "playitd"], {
    stdio:    ["ignore", "pipe", "pipe"],
    detached: true,
  });

  const handleLine = (l) => {
    const cl = l.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (cl) parsePlayitLine(cl);
  };
  playitProcess.stdout.on("data", chunk => String(chunk).split(/\r?\n/).filter(Boolean).forEach(handleLine));
  playitProcess.stderr.on("data", chunk => String(chunk).split(/\r?\n/).filter(Boolean).forEach(handleLine));

  // If neither "connected" nor "waiting_auth" shows up within a generous window, something
  // is wrong that we don't have a confirmed pattern for — surface it honestly as an error
  // with a concrete next step, rather than leaving the UI stuck on "connecting" forever.
  // 25s is well above the ~4s connect time seen in your real test.
  const stuckTimer = setTimeout(() => {
    if (state.tunnel.state === "connecting") {
      log("[playit] No connection after 25s. If this is the first time, run the one-time claim from the Terminal tab: proot-distro login debian -- playit setup");
      state.tunnel.state = "error";
      broadcast("tunnel.status", { tunnel: state.tunnel });
    }
  }, 25000);

  playitProcess.on("error", err => {
    clearTimeout(stuckTimer);
    log(`[playit] Spawn error: ${err.message}`);
    state.tunnel.state  = "error";
    state.tunnel.online = false;
    broadcast("tunnel.status", { tunnel: state.tunnel });
    playitProcess = null;
    schedulePlayitRestart();
  });

  playitProcess.on("close", code => {
    clearTimeout(stuckTimer);
    log(`[playit] Exited (${code ?? 0})`);
    playitProcess = null;
    if (state.tunnel.state !== "waiting_auth") {
      state.tunnel.state = (code === 0) ? "disconnected" : "error";
    }
    state.tunnel.online = false;
    broadcast("tunnel.status", { tunnel: state.tunnel });
    if (serverProcess) schedulePlayitRestart();
  });
}

// BEFORE: gated auto-restart on a marker file that guessed at playit's internal auth state.
// AFTER: starting playitd is safe regardless of claim status (confirmed: it just prints
//        "Waiting for frontend secret provisioning" and idles if unclaimed, doesn't error) —
//        so this can simply retry unconditionally while the Minecraft server is running.
async function schedulePlayitRestart() {
  if (playitRestartTimer) return;
  playitRestartTimer = setTimeout(async () => {
    playitRestartTimer = null;
    if (!serverProcess) return;
    startPlayit();
  }, 30000);
}

// BEFORE: plain playitProcess.kill("SIGTERM") on the native binary.
// AFTER: CONFIRMED real behavior is that SIGINT (Ctrl+C) triggers playitd's graceful
//        shutdown sequence — SIGTERM was never tested. Signals the whole process group
//        (see detached: true above) with a plain-kill fallback if that fails.
async function stopPlayit() {
  if (playitRestartTimer) { clearTimeout(playitRestartTimer); playitRestartTimer = null; }
  if (claimSetupProcess) {
    try { claimSetupProcess.kill("SIGKILL"); } catch {}
    claimSetupProcess = null;
  }
  if (playitProcess) {
    const pid = playitProcess.pid;
    try {
      process.kill(-pid, "SIGINT");
    } catch {
      try { playitProcess.kill("SIGINT"); } catch {}
    }
    playitProcess = null;
  }
  state.tunnel.online   = false;
  state.tunnel.state    = "disconnected";
  state.tunnel.claimUrl = "";
  broadcast("tunnel.status", { tunnel: state.tunnel });
}

// BEFORE (playit.claim handler used to do this inline): buffered ALL output and only
//         returned it after the process closed OR after a 20-second timeout that force-
//         killed it. Real evidence from your device: `playit setup` DOES print a genuine
//         claim URL (confirmed format: https://playit.gg/claim/<code>), but it keeps running
//         afterward waiting for you to complete the browser step — the 20s kill kept cutting
//         it off before you could finish, and each restart minted a brand new URL.
// AFTER: parses output line-by-line as it streams in. The moment the confirmed real URL
//        pattern appears, it's written to state.tunnel.claimUrl and broadcast immediately —
//        no waiting for the process to finish. The process itself is left running (not
//        killed) so it can complete the IPC handoff to the already-running daemon once you
//        finish in the browser; the daemon's own confirmed "connected" signal is what
//        ultimately marks success. Only a generous real safety-net timeout (10 minutes, far
//        beyond any realistic human claim time) cleans it up if it's genuinely abandoned.
async function startClaimSetup() {
  if (claimSetupProcess) return;   // already running, don't spawn a duplicate

  log("[playit] Running one-time claim setup...");
  claimSetupProcess = spawn("proot-distro", ["login", DEBIAN_DISTRO, "--", "playit", "setup"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const handleLine = (l) => {
    const clean = l.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!clean) return;
    log(`[playit setup] ${clean}`);
    const urlMatch = clean.match(/https:\/\/playit\.gg\/claim\/[a-zA-Z0-9]+/);
    if (urlMatch && state.tunnel.claimUrl !== urlMatch[0]) {
      state.tunnel.claimUrl = urlMatch[0];
      state.tunnel.state    = "waiting_auth";
      broadcast("tunnel.status", { tunnel: state.tunnel });
      log(`[playit] Claim link ready: ${urlMatch[0]}`);
    }
  };
  claimSetupProcess.stdout.on("data", chunk => String(chunk).split(/\r?\n/).filter(Boolean).forEach(handleLine));
  claimSetupProcess.stderr.on("data", chunk => String(chunk).split(/\r?\n/).filter(Boolean).forEach(handleLine));

  const safetyTimer = setTimeout(() => {
    if (claimSetupProcess) {
      log("[playit] Claim setup abandoned after 10 minutes — cleaning up.");
      try { claimSetupProcess.kill("SIGKILL"); } catch {}
      claimSetupProcess = null;
    }
  }, 10 * 60 * 1000);

  claimSetupProcess.on("close", code => {
    clearTimeout(safetyTimer);
    log(`[playit] Claim setup process exited (${code ?? 0})`);
    claimSetupProcess = null;
    // Deliberately not inferring success/failure from this exit code — the confirmed
    // real success signal is the daemon's own "connected" line, already handled above.
  });

  claimSetupProcess.on("error", err => {
    clearTimeout(safetyTimer);
    log(`[playit] Claim setup spawn error: ${err.message}`);
    claimSetupProcess = null;
  });
}

// ─── Paper API ────────────────────────────────────────────────────────────────

// BEFORE: v2 response was `{ versions: ["1.20.1", "1.20.2", ...] }` — a flat array,
//         last element assumed latest.
// AFTER: v3 response is `{ versions: { "1.21": ["1.21.10","1.21.11"], "1.20": [...] } }` —
//        grouped by major version. Flatten every group, then pick the true latest via
//        compareVersions() rather than trusting object/array order.
// BEFORE: getLatestPaperVersion() picked the single highest version number and handed it
//         straight to getLatestStablePaperBuild(), which threw if that version had zero
//         STABLE builds. This is exactly what happened with "26.2-rc-2" — the newest entry
//         in the version list was a release candidate with no stable build yet, so install
//         failed completely even though fully-stable versions existed one step back.
// AFTER: mirrors PaperMC's own documented pattern (docs.papermc.io/misc/downloads-service/,
//        "Downloading the latest stable build" script): if the requested/latest version has
//        no STABLE build, walk backward through the version list until one is found.
async function getAllPaperVersionsSorted() {
  const data   = await wgetJson(PAPER_API_BASE);
  const groups = data.versions || {};
  const all    = Object.values(groups).flat();
  if (!all.length) throw new Error("No Paper versions returned by Fill API");
  all.sort(compareVersions);   // ascending; last element = newest
  return all;
}

// Returns { version, build, url, sha256 } for a specific version, or null if that version
// has no STABLE-channel build (not an error — RC/pre-release versions commonly have none).
async function tryGetStablePaperBuild(version) {
  try {
    const builds = await wgetJson(`${PAPER_API_BASE}/versions/${version}/builds`);
    const stable = (Array.isArray(builds) ? builds : []).filter(b => b.channel === "STABLE");
    if (!stable.length) return null;
    stable.sort((a, b) => b.id - a.id);
    const top = stable[0];
    const dl  = top.downloads && top.downloads["server:default"];
    if (!dl || !dl.url) return null;
    return { version, build: top.id, url: dl.url, sha256: dl.checksums?.sha256 || "" };
  } catch {
    return null;
  }
}

// The actual "give me something installable" entry point — always succeeds if ANY
// version has a stable build, regardless of whether the newest version does.
async function getLatestStablePaper() {
  const all = await getAllPaperVersionsSorted();
  for (let i = all.length - 1; i >= 0; i--) {
    const result = await tryGetStablePaperBuild(all[i]);
    if (result) {
      if (i !== all.length - 1) {
        log(`[Bridge] Newest version ${all[all.length - 1]} has no stable build yet — using ${all[i]} instead`);
      }
      return result;
    }
  }
  throw new Error("No Paper version with a stable build was found");
}

async function getPaperVersionList() {
  try {
    const all = await getAllPaperVersionsSorted();
    const latest20 = all.slice(-20).reverse();
    return { versions: latest20.map(v => ({ tag: v, name: `Paper ${v}`, url: "", mcVersion: v, published: "" })) };
  } catch {
    return { versions: [] };
  }
}

// ─── Server setup ─────────────────────────────────────────────────────────────

async function writeGeyserConfig(force = false) {
  const dir = path.join(PLUGINS_DIR, "Geyser-Spigot");
  const cfg = path.join(dir, "config.yml");
  await fs.mkdir(dir, { recursive: true });
  if (!force && await exists(cfg)) return;
  const config = [
    `bedrock:`, `  address: 0.0.0.0`, `  port: ${state.settings.bedrockPort}`,
    `  clone-remote-port: false`, `  motd1: "${state.settings.serverName || "PocketHost"}"`,
    `  motd2: "${state.settings.motd || "Powered by PocketHost"}"`,
    `  server-name: "${state.settings.serverName || "PocketHost"}"`,
    `remote:`, `  address: 127.0.0.1`,
    `  port: ${state.settings.port}`, `  auth-type: offline`,
    `metrics:`, `  enabled: false`, `  uuid: 00000000-0000-0000-0000-000000000000`,
  ].join("\n") + "\n";
  await fs.writeFile(cfg, config);
}

async function initServerProperties() {
  if (await exists(SERVER_PROPERTIES_PATH)) return;
  const lines = [
    `online-mode=false`, `gamemode=${state.settings.gamemode}`,
    `difficulty=${state.settings.difficulty}`, `max-players=${state.settings.maxPlayers}`,
    `server-port=${state.settings.port}`, `motd=${state.settings.motd}`,
    `view-distance=${state.settings.viewDistance}`, `pvp=${state.settings.pvp}`,
    `allow-flight=${state.settings.allowFlight}`, `white-list=${state.settings.whiteList}`,
    `level-name=world`, `spawn-protection=0`, `enable-rcon=false`, `enable-command-block=true`,
  ];
  await fs.writeFile(SERVER_PROPERTIES_PATH, lines.join("\n") + "\n");
}

async function removeOldViaJars() {
  const entries = await fs.readdir(PLUGINS_DIR).catch(() => []);
  for (const f of entries) {
    if (f.startsWith("ViaVersion") || f.startsWith("ViaBackwards")) {
      if (f === "ViaVersion-5.9.1.jar" || f === "ViaBackwards-5.9.1.jar") continue;
      await fs.rm(path.join(PLUGINS_DIR, f), { force: true, recursive: true });
      log(`[Bridge] Removed old Via: ${f}`);
    }
  }
}

// BEFORE: installPaper() always spawned the bare "java" command with no version awareness.
//         Newer Paper builds (26.1+) require Java 25+; older Termux installs commonly only
//         have openjdk-21. This produced a silent crash: Paper printed a clear error to
//         stderr and exited, but bridge.mjs never read that error or acted on it.
// AFTER: JAVA_BIN is resolved dynamically and can be upgraded at runtime. Confirmed real via
//        termux/termux-packages issue #27045 (Oct 2025): `pkg install openjdk-25` is a real,
//        current Termux package, installing to $PREFIX/lib/jvm/java-25-openjdk/bin/java —
//        we use that exact path rather than hoping the "java" symlink updates itself, since
//        Termux allows multiple openjdk-* packages to coexist.
let JAVA_BIN = "java";

function termuxJvmPath(majorVersion) {
  const prefix = process.env.PREFIX || "/data/data/com.termux/files/usr";
  return path.join(prefix, "lib/jvm", `java-${majorVersion}-openjdk`, "bin", "java");
}

// Installs a specific Java major version via Termux's pkg manager if not already present.
// Returns true and updates JAVA_BIN on success, false on failure (caller decides what to do).
async function ensureJavaAtLeast(majorVersion) {
  const jvmPath = termuxJvmPath(majorVersion);
  if (await exists(jvmPath)) { JAVA_BIN = jvmPath; return true; }
  log(`[Bridge] This Paper build needs Java ${majorVersion}+ — installing openjdk-${majorVersion} via pkg...`);
  try {
    await runCmd("pkg", ["install", "-y", `openjdk-${majorVersion}`]);
  } catch (err) {
    log(`[Bridge] pkg install openjdk-${majorVersion} failed: ${err.message}`);
    return false;
  }
  if (await exists(jvmPath)) {
    JAVA_BIN = jvmPath;
    log(`[Bridge] openjdk-${majorVersion} installed successfully`);
    return true;
  }
  log(`[Bridge] pkg reported success but ${jvmPath} still doesn't exist`);
  return false;
}

async function installPaper() {
  await ensureDirs();
  try { execSync(`"${JAVA_BIN}" -version`, { stdio: "ignore" }); }
  catch { throw new Error("Java not found. Run: pkg install openjdk-21"); }

  if (!(await exists(PAPER_JAR_PATH))) {
    log("[Bridge] Finding latest stable Paper version...");
    const { version, build, url } = await getLatestStablePaper();
    log(`[Bridge] Downloading Paper ${version} build ${build}...`);
    await wget(url, PAPER_JAR_PATH, ["--header", `User-Agent: ${PAPER_USER_AGENT}`]);
    log(`[Bridge] Paper ${version} ready`);
  }

  // BEFORE: Geyser + ViaVersion + ViaBackwards were always downloaded, with no way to run
  //         Java-only. Every install pulled Bedrock support whether wanted or not.
  // AFTER: only installed when the user has chosen (or been inferred into) java_bedrock mode.
  if (state.settings.mode === "java_bedrock") {
    if (!(await exists(GEYSER_JAR_PATH))) {
      log("[Bridge] Downloading Geyser-Spigot (Bedrock support)...");
      await wget(GEYSER_URL, GEYSER_JAR_PATH);
      log("[Bridge] Geyser-Spigot ready");
    }
    await removeOldViaJars();
    if (!(await exists(VIAVERSION_JAR_PATH))) {
      log("[Bridge] Downloading ViaVersion 5.9.1...");
      await wget(VIAVERSION_URL, VIAVERSION_JAR_PATH);
      log("[Bridge] ViaVersion 5.9.1 ready");
    }
    if (!(await exists(VIABACKWARDS_JAR_PATH))) {
      log("[Bridge] Downloading ViaBackwards 5.9.1...");
      await wget(VIABACKWARDS_URL, VIABACKWARDS_JAR_PATH);
      log("[Bridge] ViaBackwards 5.9.1 ready");
    }
    await writeGeyserConfig();
  } else {
    log("[Bridge] Java-only mode — skipping Geyser/Bedrock download");
  }

  await fs.writeFile(EULA_PATH, "eula=true\n");
  await initServerProperties();
}

// BEFORE: used fs.stat(directory).size which returns the inode metadata size (~4 KB),
//         so every world showed 1 MB due to Math.max(1, ...).
// AFTER: uses `du -sm` to get the real recursive folder size in megabytes.
async function getWorlds() {
  await ensureDirs();
  const worlds = [];
  const KNOWN  = ["world", "world_nether", "world_the_end"];
  const entries = await fs.readdir(PAPER_DIR, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const wp         = path.join(PAPER_DIR, e.name);
    const isKnown    = KNOWN.includes(e.name);
    const hasLevelDat = await exists(path.join(wp, "level.dat"));
    if (!isKnown && !hasLevelDat) continue;
    let sizeMb = 1;
    try {
      const r = execSync(`du -sm "${wp}" 2>/dev/null`, { encoding: "utf8" });
      sizeMb = Math.max(1, parseInt(r.trim().split("\t")[0], 10) || 1);
    } catch {}
    worlds.push({
      id:            `world_${e.name}`,
      name:          e.name,
      folder:        e.name,
      sizeMb,
      lastPlayedIso: new Date().toISOString(),
    });
  }
  state.worlds = worlds;
  return worlds;
}

async function getPacks() {
  await ensureDirs();
  const packs   = [];
  const entries = await fs.readdir(RES_PACKS_DIR, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isFile() && !e.isDirectory()) continue;
    if (e.isFile() && !e.name.endsWith(".zip")) continue;
    packs.push({ id: `resource_${e.name}`, name: e.name.replace(/\.zip$/, ""), type: "resource", version: "1.0.0", folder: e.name, uuid: "" });
  }
  state.packs = packs;
  return packs;
}

// ─── Plugin management ────────────────────────────────────────────────────────

async function pluginList() {
  await fs.mkdir(PLUGINS_DIR, { recursive: true });
  const entries = await fs.readdir(PLUGINS_DIR).catch(() => []);
  return { plugins: entries.filter(f => f.endsWith(".jar")).map(f => ({ name: f.replace(/\.jar$/, ""), file: f })) };
}

async function pluginInstall(url, name) {
  await fs.mkdir(PLUGINS_DIR, { recursive: true });
  const filename = name.endsWith(".jar") ? name : name + ".jar";
  const dest     = path.join(PLUGINS_DIR, filename);
  log(`[Bridge] Downloading plugin: ${filename}`);
  await wget(url, dest).catch(async (err) => {
    await fs.rm(dest, { force: true });
    throw new Error(`Download failed: ${err.message}`);
  });
  try {
    const buf = Buffer.alloc(4);
    const fd  = await fs.open(dest, "r");
    await fd.read(buf, 0, 4, 0);
    await fd.close();
    if (buf[0] !== 0x50 || buf[1] !== 0x4B) {
      await fs.rm(dest, { force: true });
      throw new Error("URL did not return a JAR file — use a direct .jar download link, not a webpage URL");
    }
  } catch (e) {
    if (e.message.includes("direct .jar")) throw e;
    throw new Error(`Could not verify JAR: ${e.message}`);
  }
  log(`[Bridge] Plugin installed: ${filename}`);
  return { installed: filename };
}

async function pluginDelete(name) {
  const filename = name.endsWith(".jar") ? name : name + ".jar";
  await fs.rm(path.join(PLUGINS_DIR, filename), { force: true, recursive: true });
  log(`[Bridge] Plugin deleted: ${filename}`);
  return { deleted: filename };
}

// ─── File management ──────────────────────────────────────────────────────────

function isSafePath(p) { return path.resolve(p).startsWith(path.resolve(ALLOWED_BASE)); }

async function fileList(dir) {
  const target = dir ? path.join(POCKETHOST_DIR, dir) : POCKETHOST_DIR;
  if (!isSafePath(target)) throw new Error("Access denied");
  const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);
  return {
    dir:   target.replace(HOME, "~"),
    files: entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? "dir" : "file",
      path: path.join(target, e.name).replace(HOME, "~"),
    })),
  };
}

async function fileRead(filePath) {
  const resolved = filePath.startsWith("~") ? filePath.replace("~", HOME) : filePath;
  if (!isSafePath(resolved)) throw new Error("Access denied");
  return { path: filePath, content: await fs.readFile(resolved, "utf8") };
}

async function fileWrite(filePath, content) {
  const resolved = filePath.startsWith("~") ? filePath.replace("~", HOME) : filePath;
  if (!isSafePath(resolved)) throw new Error("Access denied");
  try { await fs.copyFile(resolved, resolved + ".bak"); } catch {}
  await fs.writeFile(resolved, content, "utf8");
  log(`[Bridge] Saved ${filePath}`);
  return { path: filePath, saved: true };
}

async function shellExec(cmd) {
  return new Promise(resolve => {
    const proc = spawn("bash", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); resolve(v); };
    proc.stdout.on("data", d => { out += String(d); });
    proc.stderr.on("data", d => { err += String(d); });
    proc.on("close", code => finish({ output: (out + err).slice(0, 8000), code }));
    proc.on("error", e  => finish({ output: e.message, code: -1 }));
    const t = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      finish({ output: (out + err + "\n[timeout 15s]").slice(0, 8000), code: -1 });
    }, 15000);
  });
}

// BEFORE: sent "stop\n" then waited a hardcoded 4 seconds, then deleted paper.jar.
//         Paper can take 10–30 s to save chunks and shut down gracefully.
//         Deleting the jar while Paper was still writing caused data corruption.
// AFTER: calls the full stopServer() which waits up to 30 s for a clean exit.
async function switchPaperVersion(mcVersion) {
  log(`[Bridge] Switching to Paper ${mcVersion}...`);
  if (serverProcess) {
    log("[Bridge] Stopping server before version switch...");
    await stopServer();   // full graceful stop: sends "stop", waits 30 s max
  }
  let result = await tryGetStablePaperBuild(mcVersion);
  if (!result) {
    log(`[Bridge] ${mcVersion} has no stable build — finding the closest version that does...`);
    result = await getLatestStablePaper();
  }
  await fs.rm(PAPER_JAR_PATH, { force: true });
  await wget(result.url, PAPER_JAR_PATH, ["--header", `User-Agent: ${PAPER_USER_AGENT}`]);
  log(`[Bridge] Switched to Paper ${result.version} build ${result.build}`);
  return { switched: result.version };
}

async function updateServerProperties(s) {
  let content = "";
  try { content = await fs.readFile(SERVER_PROPERTIES_PATH, "utf8"); } catch {}
  const map = new Map();
  for (const line of content.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [k, ...v] = line.split("=");
    map.set(k.trim(), v.join("=").trim());
  }
  if (s.gamemode)                       map.set("gamemode",      s.gamemode);
  if (s.difficulty)                     map.set("difficulty",    s.difficulty);
  if (typeof s.maxPlayers === "number") map.set("max-players",   String(s.maxPlayers));
  if (typeof s.port === "number")       map.set("server-port",   String(s.port));
  if (s.motd)                           map.set("motd",          s.motd);
  if (typeof s.onlineMode === "boolean")map.set("online-mode",   String(s.onlineMode));
  if (typeof s.viewDistance === "number")map.set("view-distance",String(s.viewDistance));
  if (typeof s.pvp === "boolean")       map.set("pvp",           String(s.pvp));
  if (typeof s.allowFlight === "boolean")map.set("allow-flight", String(s.allowFlight));
  if (typeof s.whiteList === "boolean") map.set("white-list",    String(s.whiteList));
  await fs.writeFile(SERVER_PROPERTIES_PATH, [...map.entries()].map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

function parseLogLine(line) {
  const clean  = line.replace(/^\[[\d:]+\]\s*\[[\w /]+\]:\s*/, "").replace(/^\[[\d:]+\]\s*/, "");
  const joined = clean.match(/^([A-Za-z0-9_]{3,16}) joined the game/i);
  if (joined) {
    const name = joined[1];
    if (!state.players.find(p => p.name === name)) {
      state.players.push({ id: `player_${name}`, name, ping: 0 });
      broadcast("players.update", { players: state.players });
    }
  }
  const left = clean.match(/^([A-Za-z0-9_]{3,16}) left the game/i);
  if (left) {
    state.players = state.players.filter(p => p.name !== left[1]);
    broadcast("players.update", { players: state.players });
  }
  const tps = line.match(/TPS from last.*?(\d+\.\d+)/i);
  if (tps) { state.stats.tps = Math.round(Number(tps[1]) * 10) / 10; broadcast("stats.update", { stats: state.stats }); }
}

// BEFORE: CPU was random drift (Math.random() * 8 - 4), RAM was random drift.
//         Users were seeing completely fabricated numbers.
// AFTER: CPU reads /proc/stat for a real inter-sample delta; RAM reads /proc/meminfo.
function startStatsLoop() {
  if (statsInterval) return;
  let lastCpuTotal = 0, lastCpuIdle = 0;

  statsInterval = setInterval(async () => {
    if (!serverProcess || !state.startedAtMs) {
      state.stats = { cpuPercent: 0, ramUsedMb: 0, ramLimitMb: state.settings.ramMb, tps: 20, uptimeSeconds: 0 };
      return;
    }
    state.stats.uptimeSeconds = Math.floor((Date.now() - state.startedAtMs) / 1000);

    // Real CPU: /proc/stat — "cpu user nice system idle iowait irq softirq ..."
    try {
      const stat    = await fs.readFile("/proc/stat", "utf8");
      const cpuLine = stat.split("\n")[0];
      const nums    = cpuLine.trim().split(/\s+/).slice(1).map(Number);
      const total   = nums.reduce((a, b) => a + b, 0);
      const idle    = (nums[3] || 0) + (nums[4] || 0);    // idle + iowait
      const dtotal  = total - lastCpuTotal;
      const didle   = idle  - lastCpuIdle;
      if (dtotal > 0) state.stats.cpuPercent = Math.min(100, Math.max(0, Math.round((1 - didle / dtotal) * 100)));
      lastCpuTotal = total;
      lastCpuIdle  = idle;
    } catch {}

    // Real RAM: /proc/meminfo
    try {
      const mem  = await fs.readFile("/proc/meminfo", "utf8");
      const val  = (key) => { const m = mem.match(new RegExp(key + ":\\s+(\\d+)")); return m ? parseInt(m[1], 10) : 0; };
      const totalKb = val("MemTotal");
      const availKb = val("MemAvailable");
      state.stats.ramUsedMb  = Math.round((totalKb - availKb) / 1024);
      state.stats.ramLimitMb = state.settings.ramMb;
    } catch {}

    broadcast("stats.update", { stats: state.stats });
  }, 2000);
}

function stopStatsLoop() { if (statsInterval) { clearInterval(statsInterval); statsInterval = null; } }

// ─── Server lifecycle ─────────────────────────────────────────────────────────

async function startServer() {
  if (serverProcess || state.serverStatus === "installing") return snapshot();
  // BEFORE: no check existed — if mode was ever null (fresh install, missing mode file,
  //         onboarding UI skipped), installPaper() silently fell into the java-only branch
  //         with no explicit user choice ever made.
  // AFTER: refuses to start and returns a clear error the UI can catch to show the
  //        mode-choice screen, so Java-only vs Java+Bedrock is always an explicit choice.
  if (state.settings.mode !== "java" && state.settings.mode !== "java_bedrock") {
    throw new Error("MODE_NOT_SET");
  }
  state.serverStatus = "installing";
  broadcast("server.status", { status: "installing" });
  log("[Bridge] Checking installation...");

  installPaper().then(() => {
    state.serverStatus     = "starting";
    state.startedAtMs      = 0;
    state.stats.ramUsedMb  = 0;
    broadcast("server.status", { status: "starting" });

    // BEFORE: Paper was spawned once with the bare "java" command. If that Java was too old
    //         for the installed Paper build (real example hit: "Minecraft 26.1 and newer
    //         requires running the server with Java 25 or above"), Paper printed the error
    //         and exited — bridge.mjs treated this exactly like any other crash and gave up.
    // AFTER: launchPaper() is a named function so it can retry itself exactly once: if the
    //        specific Java-version-requirement error is detected, we install the required
    //        JDK via Termux's real pkg package and relaunch with the correct JAVA_BIN.
    let javaRequirementLine = null;
    let hasRetriedForJava   = false;

    function launchPaper() {
      const javaArgs = [
        `-Xmx${state.settings.ramMb}M`, `-Xms256M`,
        `-XX:+UseG1GC`, `-XX:+ParallelRefProcEnabled`, `-XX:MaxGCPauseMillis=200`,
        `-jar`, `paper.jar`, `--nogui`,
      ];
      log(`[Bridge] Starting Paper (${JAVA_BIN})...`);
      javaRequirementLine = null;
      serverProcess = spawn(JAVA_BIN, javaArgs, { cwd: PAPER_DIR, stdio: ["pipe", "pipe", "pipe"] });
      startStatsLoop();

      serverProcess.stdout.on("data", chunk => {
        String(chunk).split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(line => {
          log(line);
          parseLogLine(line);

          // Also detect playit output if a playit Bukkit plugin is installed
          if (/playit/i.test(line)) {
            if (/https:\/\/playit\.gg\/claim\//i.test(line) || /ply\.gg:\d+/i.test(line)) {
              parsePlayitLine(line);
            }
          }

          if (state.serverStatus !== "running" && READY_PATTERNS.some(p => p.test(line))) {
            state.serverStatus     = "running";
            state.startedAtMs      = Date.now();
            state.stats.tps        = 20;
            broadcast("server.status", { status: "running" });
            broadcast("stats.update",  { stats: state.stats });
            startPlayit();   // start playit AFTER server confirms ready; runs independently
          }
        });
      });

      serverProcess.stderr.on("data", chunk => {
        String(chunk).split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(l => {
          log(`[err] ${l}`);
          // Real error text confirmed from an actual Paper 26.1.2 run on Termux:
          // "Minecraft 26.1 and newer requires running the server with Java 25 or above."
          const m = l.match(/requires running the server with java (\d+)/i);
          if (m) javaRequirementLine = parseInt(m[1], 10);
        });
      });

      serverProcess.on("error", err => {
        log(`[Bridge] Spawn error: ${err.message}`);
        serverProcess = null; state.serverStatus = "stopped";
        broadcast("server.status", { status: "stopped" });
        stopStatsLoop(); stopPlayit();
      });

      serverProcess.on("close", code => {
        // Caught a real Java-version mismatch and haven't tried fixing it yet this start.
        if (code !== 0 && javaRequirementLine && !hasRetriedForJava) {
          hasRetriedForJava = true;
          const needed = javaRequirementLine;
          serverProcess = null;
          stopStatsLoop();
          log(`[Bridge] Paper requires Java ${needed}+ — attempting automatic upgrade...`);
          ensureJavaAtLeast(needed).then(ok => {
            if (ok) {
              log(`[Bridge] Retrying server start with Java ${needed}...`);
              launchPaper();
            } else {
              log(`[Bridge] Could not install Java ${needed} automatically. Run manually in Termux: pkg install openjdk-${needed}`);
              state.serverStatus = "stopped";
              broadcast("server.status", { status: "stopped" });
            }
          });
          return;
        }

        log(`[Bridge] Paper exited (${code ?? 0})`);
        serverProcess = null; state.serverStatus = "stopped";
        state.players = []; state.startedAtMs = 0;
        state.stats = { cpuPercent: 0, ramUsedMb: 0, ramLimitMb: state.settings.ramMb, tps: 20, uptimeSeconds: 0 };
        broadcast("server.status",  { status: "stopped" });
        broadcast("players.update", { players: [] });
        broadcast("stats.update",   { stats: state.stats });
        stopStatsLoop(); stopPlayit();
      });
    }

    launchPaper();
  }).catch(err => {
    log(`[Bridge] Install failed: ${err.message}`);
    state.serverStatus = "stopped";
    broadcast("server.status", { status: "stopped" });
  });

  return snapshot();
}

async function stopServer() {
  if (!serverProcess) { state.serverStatus = "stopped"; return snapshot(); }
  state.serverStatus = "stopping";
  broadcast("server.status", { status: "stopping" });
  log("[Bridge] Stopping...");
  const proc = serverProcess;
  try { proc.stdin.write("stop\n"); } catch {}
  await stopPlayit();
  await new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    proc.once("close", finish);
    proc.once("exit",  finish);
    setTimeout(() => {
      if (!done) { log("[Bridge] Paper slow to stop — sending SIGTERM"); try { proc.kill("SIGTERM"); } catch {} }
    }, 25000);
    setTimeout(() => {
      if (!done) { log("[Bridge] Paper unresponsive — SIGKILL"); try { proc.kill("SIGKILL"); } catch {} }
      finish();
    }, 30000);
  });
  return snapshot();
}

async function restartServer() {
  await stopServer();
  await new Promise(r => setTimeout(r, 1500));
  return startServer();
}

async function sendCommand(cmd) {
  if (!serverProcess) { log("[Bridge] Server not running"); return snapshot(); }
  try { serverProcess.stdin.write(`${cmd}\n`); } catch {}
  log(`> ${cmd}`);
  return snapshot();
}

async function deleteWorld(worldId) {
  const folder = worldId.replace(/^world_/, "");
  await fs.rm(path.join(PAPER_DIR, folder), { recursive: true, force: true });
  log(`[Bridge] World '${folder}' deleted`);
  await getWorlds(); broadcast("worlds.update", { worlds: state.worlds });
  return snapshot();
}

async function deletePack(packId) {
  const folder = packId.replace(/^resource_/, "");
  await fs.rm(path.join(RES_PACKS_DIR, folder), { recursive: true, force: true });
  await getPacks(); broadcast("packs.update", { packs: state.packs });
  return snapshot();
}

// Lets the user switch between Java-only and Java+Bedrock at any time, not just at first setup.
// Mirrors switchPaperVersion()'s pattern: stop the server before touching plugin jars (Paper
// only loads plugins at startup — there's no safe hot-swap), download or remove Geyser/Via
// accordingly, and require a restart to activate.
async function setServerMode(mode) {
  if (mode !== "java" && mode !== "java_bedrock") throw new Error(`Invalid mode: ${mode}`);

  const wasBedrock = state.settings.mode === "java_bedrock";
  const nowBedrock = mode === "java_bedrock";

  if (wasBedrock === nowBedrock) {
    state.settings.mode = mode;
    await saveServerMode(mode);
    return snapshot();
  }

  if (serverProcess) {
    log("[Bridge] Stopping server before changing mode...");
    await stopServer();
  }

  // Set immediately — before downloads — so a concurrent startServer() call (which checks
  // this same field in installPaper()) never reads a stale value while jars are still downloading.
  state.settings.mode = mode;
  await saveServerMode(mode);

  await fs.mkdir(PLUGINS_DIR, { recursive: true });

  if (nowBedrock) {
    log("[Bridge] Enabling Bedrock support — downloading Geyser + ViaVersion...");
    if (!(await exists(GEYSER_JAR_PATH)))       await wget(GEYSER_URL, GEYSER_JAR_PATH);
    await removeOldViaJars();
    if (!(await exists(VIAVERSION_JAR_PATH)))   await wget(VIAVERSION_URL, VIAVERSION_JAR_PATH);
    if (!(await exists(VIABACKWARDS_JAR_PATH))) await wget(VIABACKWARDS_URL, VIABACKWARDS_JAR_PATH);
    await writeGeyserConfig(true);
    log("[Bridge] Bedrock support ready — start the server to activate");
  } else {
    log("[Bridge] Disabling Bedrock support — removing Geyser + Via plugins...");
    await fs.rm(GEYSER_JAR_PATH, { force: true });
    await fs.rm(VIAVERSION_JAR_PATH, { force: true });
    await fs.rm(VIABACKWARDS_JAR_PATH, { force: true });
    await fs.rm(path.join(PLUGINS_DIR, "Geyser-Spigot"), { force: true, recursive: true });
    log("[Bridge] Bedrock support removed — Java-only from next start");
  }

  broadcast("settings.update", { settings: state.settings });
  return snapshot();
}

async function applySettings(payload) {
  const old = { ...state.settings };
  state.settings      = { ...state.settings, ...payload };
  state.stats.ramLimitMb = state.settings.ramMb;
  await updateServerProperties(state.settings).catch(() => {});
  if (state.settings.bedrockPort !== old.bedrockPort || state.settings.port !== old.port
      || state.settings.serverName !== old.serverName || state.settings.motd !== old.motd) {
    await writeGeyserConfig(true).catch(err => log(`[Bridge] Geyser config rewrite failed: ${err.message}`));
    log("[Bridge] Geyser config updated — restart server to apply");
  }
  log("[Bridge] Settings saved");
  broadcast("settings.update", { settings: state.settings });
  return snapshot();
}

// ─── Request handler ──────────────────────────────────────────────────────────

async function handleRequest(action, payload = {}) {
  switch (action) {
    case "server.start":           return startServer();
    case "server.stop":            return stopServer();
    case "server.restart":         return restartServer();
    case "server.command":         return sendCommand(String(payload.command || ""));
    case "server.settings.update": return applySettings(payload);
    case "server.mode.switch":     return setServerMode(String(payload.mode || ""));
    case "server.snapshot":        await getWorlds(); await getPacks(); return snapshot();
    case "world.delete":           return deleteWorld(String(payload.worldId || ""));
    case "pack.delete":            return deletePack(String(payload.packId || ""));
    case "pack.refresh":           await getPacks(); broadcast("packs.update", { packs: state.packs }); return snapshot();
    case "plugin.list":            return pluginList();
    case "plugin.install":         return pluginInstall(String(payload.url || ""), String(payload.name || ""));
    case "plugin.delete":          return pluginDelete(String(payload.name || ""));
    case "file.list":              return fileList(String(payload.dir || ""));
    case "file.read":              return fileRead(String(payload.path || ""));
    case "file.write":             return fileWrite(String(payload.path || ""), String(payload.content || ""));
    case "shell.exec":             return shellExec(String(payload.cmd || ""));
    case "server.versions":        return getPaperVersionList();
    case "server.version.switch":  return switchPaperVersion(String(payload.tag || ""));

    // ── Playit ──────────────────────────────────────────────────────────────

    // BEFORE: downloaded a native ARM64 binary (proven broken — no /run in Termux).
    // AFTER: ensures Debian + playitd are installed, then starts the daemon. Connection
    //        state arrives via tunnel.status broadcasts; this returns immediately.
    case "playit.setup": {
      await ensurePlayitReady();
      if (playitProcess) {
        await stopPlayit();
        await new Promise(r => setTimeout(r, 800));
      }
      await startPlayit();
      return { ok: true };
    }

    // BEFORE: called execFileSync(PLAYIT_CLI, ["claim", "exchange", code]) — compiled binary, broken.
    // AFTER: runs the CONFIRMED real one-time claim command from your own device history
    //        (`playit setup`, run while playitd is already running). We do NOT have a
    //        confirmed output format for this command specifically (only playitd's own
    //        output was verified), so rather than guess a parser, this returns the raw
    //        real output directly to the UI — the same honest approach as shell.exec.
    // BEFORE: blocked for up to 20 seconds then SIGKILLed the claim process — this is
    //         exactly what cut off real, successfully-printed claim URLs before you could
    //         use them, forcing a new URL on every retry.
    // AFTER: this is now mostly a manual re-trigger — startClaimSetup() already auto-runs
    //        the moment the daemon reports unclaimed (see parsePlayitLine). This handler
    //        just ensures the daemon is running and the claim process is (re)started if not
    //        already active, then returns immediately. The real URL arrives via the
    //        tunnel.status broadcast the instant it's printed, not from this response.
    case "playit.claim": {
      if (!playitProcess) await startPlayit();
      await startClaimSetup();
      return { ok: true, claimUrl: state.tunnel.claimUrl };
    }

    // BEFORE: was missing entirely — "Save Addresses" button always threw "Unknown action".
    // AFTER: saves java/bedrock addresses to tunnels.json and updates tunnel state.
    case "playit.save_tunnels": {
      const java    = String(payload.java    || "").trim();
      const bedrock = String(payload.bedrock || "").trim();
      state.tunnel.javaAddress    = java;
      state.tunnel.bedrockAddress = bedrock;
      if (java || bedrock) {
        state.tunnel.online = true;
        state.tunnel.state  = "connected";
      }
      await fs.mkdir(PLAYIT_DIR, { recursive: true });
      await fs.writeFile(PLAYIT_TUNNELS_FILE, JSON.stringify({ java, bedrock }));
      broadcast("tunnel.status", { tunnel: state.tunnel });
      log("[playit] Addresses saved");
      return { ok: true };
    }

    case "playit.stop": {
      await stopPlayit();
      return { ok: true };
    }

    // BEFORE: checked for the native ARM64 binary and an invented marker file.
    // AFTER: checks Debian installation via `proot-distro list`'s confirmed real output
    //        format. hasConfig is inferred from real signals (currently connected, or we
    //        have cached addresses from a past successful connection).
    case "playit.status": {
      let listOutput = "";
      try { listOutput = execSync("proot-distro list 2>&1", { encoding: "utf8" }); } catch (e) { listOutput = String(e.stdout || ""); }
      const debianInstalled = new RegExp(`\\*\\s*${DEBIAN_DISTRO}\\b`).test(listOutput);
      const running         = !!playitProcess;
      let   savedTunnels    = {};
      try { savedTunnels = JSON.parse(await fs.readFile(PLAYIT_TUNNELS_FILE, "utf8")); } catch {}

      // BEFORE: cached addresses were only returned in this response's own `tunnels` field,
      //         never written into state.tunnel — the field the dashboard card actually reads
      //         (via the tunnel.status broadcast/context). Result: after a bridge restart,
      //         before the Minecraft server had been started once (which is what normally
      //         restores this cache into state.tunnel), the dashboard showed nothing even
      //         though the real addresses were sitting in tunnels.json the whole time.
      // AFTER: hydrate state.tunnel here too, and broadcast, so any client that asks for
      //        status (which happens automatically on app connect) fixes it for everyone.
      let hydrated = false;
      if (!state.tunnel.javaAddress && savedTunnels.java)       { state.tunnel.javaAddress    = savedTunnels.java;    hydrated = true; }
      if (!state.tunnel.bedrockAddress && savedTunnels.bedrock) { state.tunnel.bedrockAddress = savedTunnels.bedrock; hydrated = true; }
      if (hydrated) broadcast("tunnel.status", { tunnel: state.tunnel });

      const hasConfig = state.tunnel.state === "connected" || !!(savedTunnels.java || savedTunnels.bedrock);
      return {
        binaryExists: debianInstalled,
        hasConfig,
        running,
        tunnelState: state.tunnel.state,
        claimUrl:    state.tunnel.claimUrl,
        tunnels:     savedTunnels,
      };
    }

    default: throw new Error(`Unknown action: ${action}`);
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap() {
  await ensureDirs();
  await loadServerMode();
  await getWorlds();
  await getPacks();
  startStatsLoop();
  await setupPhAlias();

  // BEFORE: cached tunnel addresses were only ever hydrated into state.tunnel reactively
  //         (via playit.status calls or startPlayit()'s own restore-on-start). Real bug this
  //         missed: BridgeClient's own onopen handler calls server.snapshot() the instant
  //         it reconnects, independent of which screen is open — and right after a bridge
  //         restart, state.tunnel is still empty at that exact moment, so the app's context
  //         gets overwritten with empty addresses before anything else has a chance to
  //         hydrate it. Whether that later gets corrected depends on a specific frontend
  //         effect re-firing, which isn't guaranteed if the screen was already mounted.
  // AFTER: hydrate directly into the initial in-memory state before the WebSocket server
  //        even starts accepting connections, so server.snapshot() is correct from the very
  //        first response, regardless of any frontend timing.
  try {
    const cached = JSON.parse(await fs.readFile(PLAYIT_TUNNELS_FILE, "utf8"));
    if (cached.java)    state.tunnel.javaAddress    = cached.java;
    if (cached.bedrock) state.tunnel.bedrockAddress = cached.bedrock;
    if (cached.java || cached.bedrock) log("[Bridge] Restored cached tunnel addresses from previous session");
  } catch {}

  // BEFORE: two duplicate, conflicting IIFE blocks trying to pre-warm a tunnel using
  //         native-binary config paths that never existed.
  // AFTER: removed. Bridge startup happens with no Minecraft server running yet (fresh
  //        Node process), so there's nothing to tunnel to — starting playitd here would
  //        serve no purpose. startPlayit() is correctly triggered from launchPaper() once
  //        Paper actually reports ready, and from schedulePlayitRestart() if it crashes
  //        while the server is running.

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 8765 });
  console.log("[Bridge] PocketHost listening on ws://127.0.0.1:8765");
  console.log("[Bridge] Tip: type 'ph' next time to start bridge");

  wss.on("connection", ws => {
    clients.add(ws);
    console.log(`[Bridge] Client connected (${clients.size})`);
    try { ws.send(JSON.stringify({ type: "event", event: "connected", payload: snapshot() })); } catch {}

    ws.on("message", async raw => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const { id, action } = msg;
      if (!id || !action) return;
      try {
        const result = await handleRequest(action, msg);
        try { ws.send(JSON.stringify({ type: "response", id, ok: true, payload: result })); } catch {}
      } catch (err) {
        console.error(`[Bridge] Error ${action}:`, err.message);
        try { ws.send(JSON.stringify({ type: "response", id, ok: false, error: err.message })); } catch {}
      }
    });

    ws.on("close", () => { clients.delete(ws); console.log(`[Bridge] Client disconnected (${clients.size})`); });
    ws.on("error", err  => { console.error("[Bridge] WS error:", err.message); clients.delete(ws); });
  });

  wss.on("error", err => console.error("[Bridge] Server error:", err.message));
}

bootstrap().catch(err => { console.error("[Bridge] Fatal:", err); stopStatsLoop(); process.exit(1); });
