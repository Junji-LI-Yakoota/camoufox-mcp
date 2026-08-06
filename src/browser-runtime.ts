import path from "node:path";
import os from "node:os";
import { Camoufox, type LaunchOptions } from "camoufox-js";
import { launchPath } from "camoufox-js/dist/pkgman.js";
import type { Browser, BrowserContext, Page, Request, Response, Route } from "playwright-core";
import chalk from "chalk";
import { stat } from "node:fs/promises";
import { parseAndValidateBrowserRequestUrl, validateBrowserRequestUrl, validateTargetUrl } from "./policy.js";
import { DEFAULT_WAIT_STRATEGY, GUARD_SETTLE_MS, LAUNCH_TIMEOUT_MS, MAX_BLOCKED_SUBRESOURCE_LOG, MAX_CONCURRENCY, MAX_GUARDED_REQUESTS, MAX_QUEUE, QUEUE_TIMEOUT_MS } from "./config.js";
import { createDiagnosticsCollector } from "./diagnostics.js";
import { browserContextOptions, buildCamoufoxOptions, validateCommonBrowserInput } from "./browser-options.js";
import type { BrowserInstance, BrowserOperationContext, CamoufoxOptions, CommonBrowserInput, DownloadRecord, PendingBrowse, RequestGuard, SlotRelease } from "./types.js";
import { applyStealthProfile, defaultHeadlessMode, describeError, getProxySecrets, getProxyServer, redactUrl, selectOperatingSystem, withTimeout } from "./utils.js";

export { browserContextOptions, buildCamoufoxOptions, validateBrowserOptionsInput } from "./browser-options.js";

let shuttingDown = false;
let activeBrowses = 0;
const pendingBrowses: PendingBrowse[] = [];
const activeBrowsers = new Set<BrowserInstance>();

export function setBrowserShuttingDown(value: boolean): void { shuttingDown = value; }
export function activeBrowserCount(): number { return activeBrowsers.size; }
export function queuedBrowserRequestCount(): number { return pendingBrowses.length; }
export function trackBrowser(browser: BrowserInstance): void { activeBrowsers.add(browser); }

export function releaseBrowserSlot(): void {
  activeBrowses = Math.max(0, activeBrowses - 1);
  const next = pendingBrowses.shift();
  if (next) {
    next.start();
  }
}

export async function acquireBrowserSlot(): Promise<SlotRelease> {
  if (shuttingDown) {
    throw new Error("Server is shutting down.");
  }

  if (activeBrowses < MAX_CONCURRENCY) {
    activeBrowses += 1;
    return releaseBrowserSlot;
  }

  if (pendingBrowses.length >= MAX_QUEUE) {
    throw new Error("Too many concurrent browse requests. Try again later.");
  }

  return new Promise((resolve, reject) => {
    const entry: PendingBrowse = {
      reject,
      timer: setTimeout(() => {
        const index = pendingBrowses.indexOf(entry);
        if (index >= 0) {
          pendingBrowses.splice(index, 1);
        }
        reject(new Error("Timed out waiting for a browse slot."));
      }, QUEUE_TIMEOUT_MS),
      start: () => {
        clearTimeout(entry.timer);
        activeBrowses += 1;
        resolve(releaseBrowserSlot);
      },
    };

    pendingBrowses.push(entry);
  });
}

export async function withBrowserSlot<T>(fn: () => Promise<T>): Promise<T> {
  const release = await acquireBrowserSlot();
  try {
    return await fn();
  } finally {
    release();
  }
}

export const MISSING_BROWSER_MESSAGE =
  "Camoufox browser binary not installed. Run: npx -y camoufox-js@0.10.2 fetch (one-time ~780MB download into the shared OS cache), then retry.";

// ponytail: preflight only; a launch-time miss after this passes stays generic. `launchPath`
// throws when the binary is absent (same probe camoufox_status uses). The default arg keeps it
// injectable so the unit test can drive both branches without a real 780MB download.
export function assertBrowserBinaryAvailable(probe: () => unknown = launchPath): void {
  try {
    probe();
  } catch {
    throw new Error(MISSING_BROWSER_MESSAGE);
  }
}

export async function launchCamoufoxBrowser(options: CamoufoxOptions): Promise<Browser> {
  let timedOut = false;
  const launchPromise = Camoufox<undefined, Browser>(options as LaunchOptions);
  launchPromise.then(
    (browser) => {
      if (timedOut) {
        void closeBrowser(browser);
      }
    },
    () => undefined,
  );

  try {
    return await withTimeout(launchPromise, LAUNCH_TIMEOUT_MS, "Browser launch");
  } catch (error) {
    timedOut = true;
    throw error;
  }
}

// A navigation-target violation (main-frame nav to a private/local/malformed URL) trips a
// permanent hard block: the caller asked the browser to go somewhere unsafe, so the session
// should not continue. A subresource violation (an image, font, XHR, or websocket the page itself
// pulled in) is recorded and the single request is aborted, but the session stays usable — a
// one-way latch here previously killed the entire multi-step session on the first stray tracker
// pixel or exhausted request budget, long before any real anti-bot ever fired (ERR-20260805-002).
export async function installRequestGuard(context: BrowserContext): Promise<RequestGuard> {
  let inspectedRequests = 0;
  let blockedRequestError: Error | undefined;
  const blockedSubresources: string[] = [];

  function isMainFrameNavigation(request: Request): boolean {
    try {
      return request.isNavigationRequest() && request.frame().parentFrame() === null;
    } catch {
      return false;
    }
  }

  function blockNavigation(rawUrl: string, reason: string): void {
    if (!blockedRequestError) {
      blockedRequestError = new Error(`Blocked unsafe browser request to ${redactUrl(rawUrl)}. ${reason}`);
    }
  }

  function recordBlockedSubresource(rawUrl: string, reason: string): void {
    if (blockedSubresources.length < MAX_BLOCKED_SUBRESOURCE_LOG) {
      blockedSubresources.push(`${redactUrl(rawUrl)}: ${reason}`);
    }
  }

  function reportViolation(rawUrl: string, reason: string, navigation: boolean): void {
    if (navigation) {
      blockNavigation(rawUrl, reason);
    } else {
      recordBlockedSubresource(rawUrl, reason);
    }
  }

  function hasRequestBudget(rawUrl: string, navigation: boolean): boolean {
    if (inspectedRequests >= MAX_GUARDED_REQUESTS) {
      reportViolation(rawUrl, "Too many browser requests.", navigation);
      return false;
    }

    inspectedRequests += 1;
    return true;
  }

  context.on("request", (request) => {
    const requestUrl = request.url();
    try {
      parseAndValidateBrowserRequestUrl(requestUrl);
    } catch (requestError) {
      reportViolation(requestUrl, describeError(requestError), isMainFrameNavigation(request));
    }
  });

  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    const requestUrl = request.url();
    const navigation = isMainFrameNavigation(request);

    if (!hasRequestBudget(requestUrl, navigation)) {
      await route.abort("blockedbyclient").catch(() => undefined);
      return;
    }

    try {
      await validateBrowserRequestUrl(requestUrl);
    } catch (requestError) {
      reportViolation(requestUrl, describeError(requestError), navigation);
      await route.abort("blockedbyclient").catch(() => undefined);
      return;
    }

    await route.continue().catch((continueError) => {
      console.error(chalk.yellow(`[Camoufox] Request continue failed: ${describeError(continueError)}`));
    });
  });

  await context.routeWebSocket(/.*/, async (webSocket) => {
    const requestUrl = webSocket.url();

    // Websockets are never navigation targets, so a violation here is always a soft block.
    if (!hasRequestBudget(requestUrl, false)) {
      await webSocket.close({ code: 1008, reason: "Blocked by server policy" }).catch(() => undefined);
      return;
    }

    try {
      await validateBrowserRequestUrl(requestUrl);
    } catch (requestError) {
      recordBlockedSubresource(requestUrl, describeError(requestError));
      await webSocket.close({ code: 1008, reason: "Blocked by server policy" }).catch(() => undefined);
      return;
    }

    webSocket.connectToServer();
  });

  return {
    assertAllowed(): void {
      if (blockedRequestError) {
        throw blockedRequestError;
      }
    },
    watchPage(page: Page): void {
      page.on("websocket", (webSocket) => {
        const requestUrl = webSocket.url();
        if (!hasRequestBudget(requestUrl, false)) {
          return;
        }

        try {
          parseAndValidateBrowserRequestUrl(requestUrl);
        } catch (requestError) {
          recordBlockedSubresource(requestUrl, describeError(requestError));
        }
      });
    },
    getBlockedSubresources(): string[] {
      return [...blockedSubresources];
    },
  };
}

// Attaches a download listener that saves to disk and records the result, instead of only
// logging to stderr — callers previously had no way to learn a download happened short of an
// out-of-band `ls` on the Downloads folder (see scrape_common_rules.md ERR-20260805-001).
export function attachDownloadTracking(page: Page, downloads: DownloadRecord[]): void {
  const downloadDir = process.env.CAMOUFOX_MCP_DOWNLOAD_DIR || path.join(os.homedir(), "Downloads");
  page.on("download", async (download) => {
    const dest = path.join(downloadDir, download.suggestedFilename());
    try {
      await download.saveAs(dest);
      const stats = await stat(dest).catch(() => undefined);
      downloads.push({
        path: dest,
        suggestedFilename: download.suggestedFilename(),
        bytes: stats?.size ?? 0,
        savedAt: Date.now(),
      });
      if (downloads.length > 100) {
        downloads.splice(0, downloads.length - 100);
      }
      console.error(chalk.green(`[Camoufox] Download saved: ${dest}`));
    } catch (downloadError) {
      console.error(chalk.red(`[Camoufox] Download save failed: ${describeError(downloadError)}`));
    }
  });
}

// A site that opens a devis/PDF result in a new tab (target="_blank") creates a second Page on
// the same context; without this, its downloads were invisible to the session entirely.
export function attachPopupDownloadTracking(context: BrowserContext, downloads: DownloadRecord[]): void {
  context.on("page", (newPage) => {
    attachDownloadTracking(newPage, downloads);
  });
}

export async function saveStorageStateIfConfigured(context: BrowserContext, storageStatePath: string | undefined): Promise<void> {
  if (!storageStatePath) {
    return;
  }

  try {
    await context.storageState({ path: storageStatePath });
    console.error(chalk.blue(`[Camoufox] Saved storage state to ${storageStatePath}.`));
  } catch (saveError) {
    console.error(chalk.yellow(`[Camoufox] Failed to save storage state: ${describeError(saveError)}`));
  }
}

export async function runBrowserOperation<T>(
  label: string,
  input: CommonBrowserInput,
  callback: (context: BrowserOperationContext) => Promise<T>,
): Promise<T> {
  const effectiveInput = applyStealthProfile(input);
  const safeUrl = redactUrl(effectiveInput.url);
  const targetUrl = await validateCommonBrowserInput(effectiveInput);

  return withBrowserSlot(async () => {
    assertBrowserBinaryAvailable();

    const selectedOS = selectOperatingSystem(effectiveInput.os);
    const waitStrategy = effectiveInput.waitStrategy ?? DEFAULT_WAIT_STRATEGY;
    const headlessMode = defaultHeadlessMode(effectiveInput.headless);

    console.error(chalk.blue(`[Camoufox] Launching browser to ${label}: ${safeUrl}`));

    const browser = await launchCamoufoxBrowser(buildCamoufoxOptions(effectiveInput, selectedOS, headlessMode));
    activeBrowsers.add(browser);
    let context: BrowserContext | undefined;

    try {
      context = await browser.newContext(browserContextOptions(effectiveInput));
      const requestGuard = await installRequestGuard(context);
      const page = await context.newPage();
      requestGuard.watchPage(page);
      const downloads: DownloadRecord[] = [];
      attachDownloadTracking(page, downloads);
      attachPopupDownloadTracking(context, downloads);

      const rawUrls = [effectiveInput.url, getProxyServer(effectiveInput.proxy)].filter((rawUrl): rawUrl is string => Boolean(rawUrl));
      const secrets = getProxySecrets(effectiveInput.proxy);
      const diagnostics = createDiagnosticsCollector(page, effectiveInput, rawUrls, secrets);
      let lastNavigationResponse: Response | null = null;
      page.on("response", (response) => {
        const request = response.request();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          lastNavigationResponse = response;
        }
      });

      let response: Response | null;
      try {
        response = await page.goto(targetUrl.toString(), {
          waitUntil: waitStrategy,
          timeout: effectiveInput.timeout,
        });
        lastNavigationResponse = response;
      } catch (navigationError) {
        const navigationErrorMessage = describeError(navigationError).toLowerCase();
        if (/\b(?:127\.0\.0\.1|localhost|ip6-localhost|ip6-loopback|::1)\b/.test(navigationErrorMessage)) {
          throw new Error(`Blocked unsafe browser request to ${safeUrl}.`, { cause: navigationError });
        }

        requestGuard.assertAllowed();
        throw navigationError;
      }

      await page.waitForTimeout(GUARD_SETTLE_MS);
      requestGuard.assertAllowed();
      await validateTargetUrl(page.url());
      requestGuard.assertAllowed();

      return await callback({
        page,
        response,
        requestGuard,
        diagnostics,
        selectedOS,
        waitStrategy,
        getLastNavigationResponse: () => lastNavigationResponse,
        downloads,
      });
    } finally {
      if (context) {
        await saveStorageStateIfConfigured(context, effectiveInput.storageStatePath);
      }
      console.error(chalk.blue("[Camoufox] Closing browser."));
      await closeBrowser(browser);
    }
  });
}

export async function assertPageLocationSafe(page: Page): Promise<void> {
  if (page.url() === "about:blank") {
    return;
  }

  await validateTargetUrl(page.url());
}

export async function settleAndAssertSafe(page: Page, requestGuard: RequestGuard): Promise<void> {
  await page.waitForTimeout(GUARD_SETTLE_MS);
  requestGuard.assertAllowed();
  await assertPageLocationSafe(page);
  requestGuard.assertAllowed();
}

export async function runGuardedPageRead<T>(page: Page, requestGuard: RequestGuard, read: () => Promise<T>): Promise<T> {
  try {
    requestGuard.assertAllowed();
    await assertPageLocationSafe(page);
    requestGuard.assertAllowed();
    const result = await read();
    await page.waitForTimeout(GUARD_SETTLE_MS).catch(() => undefined);
    requestGuard.assertAllowed();
    await assertPageLocationSafe(page);
    requestGuard.assertAllowed();
    return result;
  } catch (readError) {
    await page.waitForTimeout(GUARD_SETTLE_MS).catch(() => undefined);
    requestGuard.assertAllowed();
    await assertPageLocationSafe(page);
    requestGuard.assertAllowed();
    throw readError;
  }
}

export async function closeBrowser(browser: BrowserInstance): Promise<void> {
  activeBrowsers.delete(browser);
  try {
    await browser.close();
  } catch (closeError) {
    console.error(chalk.yellow(`[Camoufox] Browser close failed: ${describeError(closeError)}`));
  }
}

export async function closeActiveBrowsers(): Promise<void> {
  const browsers = Array.from(activeBrowsers);
  await Promise.all(browsers.map((browser) => closeBrowser(browser)));
}

export function rejectPendingBrowses(reason: string): void {
  const pending = pendingBrowses.splice(0);
  for (const entry of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
}
