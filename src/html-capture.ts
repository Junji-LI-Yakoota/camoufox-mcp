import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import chalk from "chalk";
import { describeError } from "./utils.js";

export interface HtmlCaptureResult {
  savedPath?: string;
  bytes?: number;
  cssRulesInlined: number;
  stylesheetsSkipped: number;
  error?: string;
  saveError?: string;
}

// Runs inside the page, not the MCP process: this is a fixed function, not a user-supplied
// expression, so it is not gated by CAMOUFOX_MCP_ALLOW_EVALUATE (that flag guards the
// browse_sequence "evaluate" action, which runs arbitrary caller JS).
async function inlineStylesheetsAndSerialize(page: Page): Promise<{ html: string; cssRulesInlined: number; stylesheetsSkipped: number }> {
  return page.evaluate(() => {
    let cssRulesInlined = 0;
    let stylesheetsSkipped = 0;

    for (const sheet of Array.from(document.styleSheets)) {
      const ownerNode = sheet.ownerNode;
      if (!ownerNode || ownerNode.nodeName !== "LINK") {
        continue;
      }

      try {
        const cssText = Array.from(sheet.cssRules).map((rule) => rule.cssText).join("\n");
        const styleElement = document.createElement("style");
        styleElement.setAttribute("data-camoufox-inlined-from", (ownerNode as HTMLLinkElement).href || "");
        styleElement.textContent = cssText;
        ownerNode.replaceWith(styleElement);
        cssRulesInlined += sheet.cssRules.length;
      } catch {
        // Cross-origin stylesheet without CORS headers: cssRules is inaccessible from page
        // context. Leave the original <link> tag in place rather than dropping it.
        stylesheetsSkipped += 1;
      }
    }

    return {
      html: `<!DOCTYPE html>\n${document.documentElement.outerHTML}`,
      cssRulesInlined,
      stylesheetsSkipped,
    };
  });
}

export async function captureSessionHtml(page: Page, savePath: string, inlineStyles: boolean): Promise<HtmlCaptureResult> {
  try {
    const { html, cssRulesInlined, stylesheetsSkipped } = inlineStyles
      ? await inlineStylesheetsAndSerialize(page)
      : { html: `<!DOCTYPE html>\n${await page.evaluate(() => document.documentElement.outerHTML)}`, cssRulesInlined: 0, stylesheetsSkipped: 0 };

    const buffer = Buffer.from(html, "utf8");
    const result: HtmlCaptureResult = { cssRulesInlined, stylesheetsSkipped, bytes: buffer.length };

    try {
      await mkdir(path.dirname(savePath), { recursive: true });
      await writeFile(savePath, buffer);
      result.savedPath = savePath;
      console.error(chalk.green(`[Camoufox] HTML saved to ${savePath} (${buffer.length} bytes, ${cssRulesInlined} CSS rules inlined, ${stylesheetsSkipped} stylesheets skipped).`));
    } catch (saveError) {
      result.saveError = describeError(saveError);
      console.error(chalk.yellow(`[Camoufox] HTML save failed: ${result.saveError}`));
    }

    return result;
  } catch (captureError) {
    const error = describeError(captureError);
    console.error(chalk.yellow(`[Camoufox] HTML capture failed: ${error}`));
    return { cssRulesInlined: 0, stylesheetsSkipped: 0, error };
  }
}
