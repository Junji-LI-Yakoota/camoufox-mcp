import { existsSync, readFileSync } from "node:fs";
import type { NetworkSandboxMode, NetworkSecurityStatus, StealthProfile, SupportedOs, WaitStrategy } from "./types.js";

export const SERVER_VERSION = "2.4.0";
export const DEFAULT_MAX_CHARS = 30000;
export const MAX_MAX_CHARS = 200000;
export const DEFAULT_MAX_ELEMENTS = 100;
export const MAX_MAX_ELEMENTS = 500;
export const MAX_SEQUENCE_ACTIONS = 25;
export const DEFAULT_ACTION_TIMEOUT_MS = 10000;
export const DEFAULT_WAIT_STRATEGY: WaitStrategy = "domcontentloaded";
export const DEFAULT_STEALTH_PROFILE: StealthProfile = "normal";
export const MAX_EXTRACT_NODES = 50000;
export const GUARD_SETTLE_MS = 100;
export const SESSION_CLOSE_GRACE_MS = 5000;
export const ALLOW_UNSAFE_OPTIONS = process.env.CAMOUFOX_MCP_ALLOW_UNSAFE_OPTIONS === "1";
export const ALLOW_EVALUATE = process.env.CAMOUFOX_MCP_ALLOW_EVALUATE === "1";
export const CAPTCHA_AUTONOMOUS = process.env.CAPTCHA_AUTONOMOUS === "true";
export const NETWORK_SANDBOX_DECLARED = process.env.CAMOUFOX_MCP_NETWORK_SANDBOX === "1";
export const REQUIRE_NETWORK_SANDBOX = process.env.CAMOUFOX_MCP_REQUIRE_NETWORK_SANDBOX === "1";

export const SUPPORTED_OSES: readonly SupportedOs[] = ["windows", "macos", "linux"] as const;
export const DENIED_BROWSER_ARG_FLAGS = new Set([
  "--allow-insecure-localhost",
  "--allow-running-insecure-content",
  "--disable-extensions-except",
  "--disable-setuid-sandbox",
  "--disable-web-security",
  "--host-resolver-rules",
  "--ignore-certificate-errors",
  "--load-extension",
  "--no-proxy-server",
  "--no-sandbox",
  "--profile",
  "--proxy-bypass-list",
  "--proxy-pac-url",
  "--proxy-server",
  "--remote-allow-origins",
  "--remote-debugging-address",
  "--remote-debugging-pipe",
  "--remote-debugging-port",
  "--user-data-dir",
  "-profile",
]);
export const DENIED_FIREFOX_PREF_KEYS = new Set([
  "devtools.chrome.enabled",
  "devtools.debugger.prompt-connection",
  "devtools.debugger.remote-enabled",
  "dom.serviceWorkers.enabled",
  "media.peerconnection.enabled",
  "network.proxy.allow_hijacking_localhost",
  "network.proxy.no_proxies_on",
  "security.cert_pinning.enforcement_level",
  "security.fileuri.strict_origin_policy",
  "security.mixed_content.block_active_content",
]);
export const DENIED_FIREFOX_PREF_PREFIXES = [
  "devtools.",
  "network.proxy.",
  "security.sandbox.",
];

export function readBoundedInteger(name: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    return defaultValue;
  }

  return Math.min(max, Math.max(min, value));
}

export const MAX_CONCURRENCY = readBoundedInteger("CAMOUFOX_MCP_MAX_CONCURRENCY", 1, 1, 8);
export const MAX_QUEUE = readBoundedInteger("CAMOUFOX_MCP_MAX_QUEUE", 8, 0, 100);
export const QUEUE_TIMEOUT_MS = readBoundedInteger("CAMOUFOX_MCP_QUEUE_TIMEOUT_MS", 30000, 1000, 300000);
export const LAUNCH_TIMEOUT_MS = readBoundedInteger("CAMOUFOX_MCP_LAUNCH_TIMEOUT_MS", 30000, 1000, 300000);
export const SEQUENCE_TIMEOUT_MS = readBoundedInteger("CAMOUFOX_MCP_SEQUENCE_TIMEOUT_MS", 120000, 1000, 300000);
export const MAX_SCREENSHOT_BYTES = readBoundedInteger("CAMOUFOX_MCP_MAX_SCREENSHOT_BYTES", 5 * 1024 * 1024, 1024, 20 * 1024 * 1024);
export const MAX_SCREENSHOT_WIDTH = readBoundedInteger("CAMOUFOX_MCP_MAX_SCREENSHOT_WIDTH", 1920, 320, 3840);
export const MAX_SCREENSHOT_HEIGHT = readBoundedInteger("CAMOUFOX_MCP_MAX_SCREENSHOT_HEIGHT", 1080, 240, 2160);
export const MAX_SCREENSHOT_AREA = MAX_SCREENSHOT_WIDTH * MAX_SCREENSHOT_HEIGHT;
export const MAX_DIAGNOSTIC_ENTRIES = readBoundedInteger("CAMOUFOX_MCP_MAX_DIAGNOSTIC_ENTRIES", 100, 1, 1000);
export const MAX_DIAGNOSTIC_TEXT_CHARS = readBoundedInteger("CAMOUFOX_MCP_MAX_DIAGNOSTIC_TEXT_CHARS", 2000, 100, 20000);
export const MAX_SESSIONS = readBoundedInteger("CAMOUFOX_MCP_MAX_SESSIONS", 1, 1, 4);
// Max raised from 1h to 8h: supervised multi-step quote tunnels routinely need a human to clear a
// CAPTCHA, a native save dialog, or another blocking step mid-run; the TTL is idle-reset per
// getSession() call, so this bounds worst-case idle time, not total session length.
export const SESSION_TTL_MS = readBoundedInteger("CAMOUFOX_MCP_SESSION_TTL_MS", 1800000, 300000, 28800000);
// Counts every request/response (images, fonts, XHR, websockets...) seen by a browser context
// for the lifetime of that context, not per navigation. A persistent multi-step SPA session
// (browse_session_*) shares one context across many pages, so the old hardcoded 1024 tripped
// mid-form on ordinary sites and permanently blocked the rest of the session (one-way latch,
// see installRequestGuard) with no way to recover short of starting a new session.
export const MAX_GUARDED_REQUESTS = readBoundedInteger("CAMOUFOX_MCP_MAX_GUARDED_REQUESTS", 20000, 256, 200000);
export const MAX_BLOCKED_SUBRESOURCE_LOG = 50;

// Off by default (no behavior change for existing callers). Set e.g. "800-3000" to add a random
// human-like pause before each interactive action, on sites that fingerprint click cadence.
export function readJitterRangeMs(name: string, defaultMin: number, defaultMax: number): [number, number] {
  const raw = process.env[name];
  if (!raw) {
    return [defaultMin, defaultMax];
  }

  const match = raw.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (!match) {
    return [defaultMin, defaultMax];
  }

  const min = Number.parseInt(match[1], 10);
  const max = Number.parseInt(match[2], 10);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    return [defaultMin, defaultMax];
  }

  return [Math.max(0, Math.min(min, 10000)), Math.max(0, Math.min(max, 10000))];
}

export const ACTION_JITTER_RANGE_MS = readJitterRangeMs("CAMOUFOX_MCP_ACTION_JITTER_MS", 0, 0);

export function fileContains(path: string, value: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(value);
  } catch {
    return false;
  }
}

export function isLikelyContainerRuntime(): boolean {
  return existsSync("/.dockerenv")
    || fileContains("/proc/1/cgroup", "docker")
    || fileContains("/proc/1/cgroup", "kubepods");
}

export function detectNetworkSandboxMode(): NetworkSandboxMode {
  if (NETWORK_SANDBOX_DECLARED && REQUIRE_NETWORK_SANDBOX) {
    return "strict-declared";
  }

  if (NETWORK_SANDBOX_DECLARED) {
    return "declared";
  }

  if (isLikelyContainerRuntime()) {
    return "docker";
  }

  return "unknown";
}

export function buildNetworkSecurityStatus(): NetworkSecurityStatus {
  const sandboxMode = detectNetworkSandboxMode();
  const warning = sandboxMode === "unknown" || sandboxMode === "docker"
    ? "SSRF filtering is application-layer best effort. Use container, VM, or firewall egress rules for untrusted URLs. Container detection is not proof of private-network egress filtering."
    : undefined;

  return {
    ssrfPolicy: "app_layer_best_effort",
    sandboxMode,
    sandboxDeclared: NETWORK_SANDBOX_DECLARED,
    strictSandboxRequired: REQUIRE_NETWORK_SANDBOX,
    warning,
  };
}

export function assertNetworkSandboxPolicy(): void {
  if (REQUIRE_NETWORK_SANDBOX && !NETWORK_SANDBOX_DECLARED) {
    throw new Error(
      "CAMOUFOX_MCP_REQUIRE_NETWORK_SANDBOX=1 requires CAMOUFOX_MCP_NETWORK_SANDBOX=1 after configuring container/VM/firewall egress controls.",
    );
  }
}
