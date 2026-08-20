/**
 * Chromium launcher. Uses whatever Playwright resolves by default, falling
 * back to a PLAYWRIGHT_BROWSERS_PATH install when the download was skipped.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort();
  for (const dir of dirs.reverse()) {
    const candidate = path.join(root, dir, 'chrome-linux', 'chrome');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function launchOptions() {
  const options = { args: ['--no-sandbox'] };
  const executablePath = findChromium();
  if (executablePath) options.executablePath = executablePath;
  return options;
}

module.exports = { chromium, launchOptions };
