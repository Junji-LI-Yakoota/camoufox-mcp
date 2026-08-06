import type { Locator, Page } from "playwright-core";
import chalk from "chalk";
import { ACTION_JITTER_RANGE_MS, ALLOW_EVALUATE, DEFAULT_ACTION_TIMEOUT_MS, SEQUENCE_TIMEOUT_MS } from "./config.js";
import type { SequenceAction } from "./schemas.js";
import type { ClickMode, RequestGuard, SequenceActionResult } from "./types.js";
import { describeError, serializeBounded, withTimeout } from "./utils.js";
import { settleAndAssertSafe } from "./browser-runtime.js";

// Best-effort human-like approach to an element before acting on it: move it into view and give
// it focus, the way a real user would before clicking or typing. Non-fatal — some clickable
// elements (e.g. a styled <div role="button">) aren't focusable, and Playwright's own
// actionability checks inside click()/fill()/etc. still run and enforce the real precondition.
export async function scrollAndFocus(locator: Locator, timeout: number): Promise<void> {
  await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => undefined);
  await locator.focus({ timeout }).catch(() => undefined);
}

function randomInt(min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

// Off by default (see config.ts ACTION_JITTER_RANGE_MS). When enabled via
// CAMOUFOX_MCP_ACTION_JITTER_MS, adds a randomized human-like pause before each interactive
// action so click/type cadence doesn't look scripted (fixed ~100ms gaps between actions were
// part of what tripped the lesfurets "vitesse surhumaine" rate block, see anti_bot_log.md).
async function applyActionJitter(page: Page): Promise<void> {
  const [min, max] = ACTION_JITTER_RANGE_MS;
  if (max <= 0) return;
  await page.waitForTimeout(randomInt(min, max));
}

function toTextMatcher(pattern: string): (value: string) => boolean {
  const regexMatch = pattern.match(/^\/(.*)\/([a-z]*)$/i);
  if (regexMatch) {
    const regex = new RegExp(regexMatch[1], regexMatch[2]);
    return (value) => regex.test(value);
  }
  return (value) => value.includes(pattern);
}

export function actionTimeout(action: { timeout?: number }): number {
  return action.timeout ?? DEFAULT_ACTION_TIMEOUT_MS;
}

export function sequenceTimeoutBudget(actions: SequenceAction[]): number {
  return actions.reduce((total, action) => total + actionTimeout(action), 0);
}

export function isLocalOperationTimeout(error: unknown): boolean {
  return describeError(error).endsWith(" timed out.");
}

export function resolveLocator(page: Page, selector: string, frame?: string): Locator {
  if (frame) return page.frameLocator(frame).locator(selector).first();
  return page.locator(selector).first();
}

export async function pointerClick(locator: Locator, timeout: number): Promise<void> {
  await locator.click({ timeout });
}

export async function domClick(locator: Locator, timeout: number): Promise<void> {
  // Camoufox's virtual display can hang during low-level mouse clicks in CI.
  // Keep this as DOM activation, without Playwright's stability-gated scroll
  // or pointer hit-testing, until mouse actions are stable under Xvfb.
  await withTimeout(
    locator.evaluate((element: HTMLElement) => {
      const clickable = element as HTMLElement & { click?: () => void };
      if (typeof clickable.click === "function") {
        clickable.click();
        return;
      }

      element.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
      }));
    }),
    timeout,
    "Click action",
  );
}

export async function activateElement(page: Page, selector: string, timeout: number, frame?: string, clickMode: ClickMode = "auto"): Promise<void> {
  const locator = resolveLocator(page, selector, frame);
  await locator.waitFor({ state: "visible", timeout });
  await scrollAndFocus(locator, timeout);
  await applyActionJitter(page);
  if (!await locator.isEnabled({ timeout })) {
    throw new Error(`Click selector is disabled: ${selector}`);
  }

  if (clickMode === "pointer") {
    await pointerClick(locator, timeout);
    return;
  }

  if (clickMode === "auto") {
    try {
      await pointerClick(locator, timeout);
      return;
    } catch (error) {
      console.error(chalk.yellow(`[Camoufox] Pointer click failed, falling back to DOM click: ${describeError(error)}`));
    }
  }

  await domClick(locator, timeout);
}

export async function runSequenceAction(
  page: Page,
  action: SequenceAction,
  index: number,
  rawUrls: string[],
  secrets: string[],
): Promise<SequenceActionResult> {
  const started = Date.now();
  const timeout = actionTimeout(action);

  switch (action.type) {
    case "click":
      await activateElement(page, action.selector, timeout, action.frame, action.clickMode);
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };

    case "hover": {
      const locator = resolveLocator(page, action.selector, action.frame);
      await scrollAndFocus(locator, timeout);
      await applyActionJitter(page);
      await locator.hover({ timeout });
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };
    }

    case "fill": {
      const locator = resolveLocator(page, action.selector, action.frame);
      await scrollAndFocus(locator, timeout);
      await applyActionJitter(page);
      await locator.fill(action.value, { timeout });
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };
    }

    case "type": {
      const locator = resolveLocator(page, action.selector, action.frame);
      await scrollAndFocus(locator, timeout);
      await applyActionJitter(page);
      await locator.pressSequentially(action.text, {
        delay: action.delay,
        timeout,
      });
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };
    }

    case "select": {
      const locator = resolveLocator(page, action.selector, action.frame);
      await scrollAndFocus(locator, timeout);
      await applyActionJitter(page);
      await locator.selectOption(action.value, { timeout });
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };
    }

    case "press":
      if (action.selector) {
        const locator = resolveLocator(page, action.selector, action.frame);
        await scrollAndFocus(locator, timeout);
        await applyActionJitter(page);
        await locator.press(action.key, { timeout });
      } else {
        await applyActionJitter(page);
        await withTimeout(page.keyboard.press(action.key), timeout, "Press action");
      }
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };

    case "waitFor":
      if (action.selector) {
        if (action.frame) {
          await resolveLocator(page, action.selector, action.frame).waitFor({ state: action.state, timeout });
        } else {
          await page.waitForSelector(action.selector, { state: action.state, timeout });
        }
      } else {
        await page.waitForLoadState(action.loadState ?? "load", { timeout });
      }
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };

    case "scroll":
      if (action.selector) {
        const locator = resolveLocator(page, action.selector, action.frame);
        await locator.waitFor({ state: "attached", timeout });
        await withTimeout(
          locator.evaluate(async (element: HTMLElement, { deltaX, deltaY }: { deltaX: number; deltaY: number }) => {
            const target = element as HTMLElement;
            const beforeLeft = target.scrollLeft;
            const beforeTop = target.scrollTop;
            let scrollEventFired = false;
            await new Promise<void>((resolve) => {
              const timer = window.setTimeout(() => resolve(), 100);
              target.addEventListener("scroll", () => {
                scrollEventFired = true;
                window.clearTimeout(timer);
                resolve();
              }, { once: true });
              target.scrollBy(deltaX, deltaY);
              if (target.scrollLeft === beforeLeft && target.scrollTop === beforeTop) {
                window.clearTimeout(timer);
                resolve();
              }
            });
            if (!scrollEventFired && (target.scrollLeft !== beforeLeft || target.scrollTop !== beforeTop)) {
              target.dispatchEvent(new Event("scroll", { bubbles: true }));
            }
          }, { deltaX: action.deltaX, deltaY: action.deltaY }),
          timeout,
          "Scroll action",
        );
      } else {
        await page.mouse.wheel(action.deltaX, action.deltaY);
      }
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };

    case "evaluate": {
      if (!ALLOW_EVALUATE) {
        throw new Error("Evaluate action is disabled by server policy. Set CAMOUFOX_MCP_ALLOW_EVALUATE=1 to enable it.");
      }

      const result = await withTimeout(
        page.evaluate((expression) => globalThis.eval(expression), action.expression),
        timeout,
        "Evaluate action",
      );
      const serialized = serializeBounded(result, action.maxChars, rawUrls, secrets);
      return {
        index,
        type: action.type,
        status: "ok",
        result: serialized.value,
        resultTruncated: serialized.truncated,
        durationMs: Date.now() - started,
      };
    }

    case "waitForText": {
      const locator = resolveLocator(page, action.selector, action.frame);
      const matcher = toTextMatcher(action.pattern);
      await withTimeout(
        (async () => {
          for (;;) {
            const text = await locator.textContent().catch(() => null);
            if (text !== null && matcher(text)) {
              return;
            }
            await page.waitForTimeout(150);
          }
        })(),
        timeout,
        "WaitForText action",
      );
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };
    }

    case "waitForResponse": {
      const matcher = toTextMatcher(action.urlPattern);
      await withTimeout(
        page.waitForResponse(
          (response) => matcher(response.url()) && (action.status === undefined || response.status() === action.status),
          { timeout },
        ),
        timeout,
        "WaitForResponse action",
      );
      return { index, type: action.type, status: "ok", durationMs: Date.now() - started };
    }
  }
}

export async function runSequenceActionsWithBudget(
  page: Page,
  requestGuard: RequestGuard,
  actionsInput: SequenceAction[],
  rawUrls: string[],
  secrets: string[],
): Promise<SequenceActionResult[]> {
  const actions: SequenceActionResult[] = [];

  await withTimeout((async () => {
    for (let index = 0; index < actionsInput.length; index += 1) {
      const result = await runSequenceAction(page, actionsInput[index], index, rawUrls, secrets);
      actions.push(result);
      await settleAndAssertSafe(page, requestGuard);
    }
  })(), SEQUENCE_TIMEOUT_MS, "Browse sequence");

  return actions;
}
