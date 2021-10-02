/**
 * Substantial parts adapted from https://github.com/zserge/lorca/blob/a3e43396a47ea152501d3453514c7f373cea530a/locate.go
 * which is licensed as follows:
 *
 * MIT License
 *
 * Copyright (c) 2018 Serge Zaitsev
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { exists, join } from "./deps.ts";
import { BrowserFetcher, Platform } from "./browser_fetcher.ts";

type OS = "darwin" | "linux" | "windows";

function getDownloadDir(os: OS, env: typeof Deno.env): string {
  if (os === "darwin") {
    const home = env.get("HOME");
    if (home) return join(home, "Library", "Caches", "carol");
  }

  if (os === "windows") {
    const localAppData = env.get("LocalAppData");
    if (localAppData) return join(localAppData, "carol");
  }

  if (os === "linux") {
    const xdgCacheHome = env.get("XDG_CACHE_HOME");
    if (xdgCacheHome) return join(xdgCacheHome, "carol");

    const home = env.get("HOME");
    if (home) return join(home, ".cache", "carol");
  }

  throw new Error(`Could not find a suitable directory to download into.`);
}

export async function locateChrome(
  os: OS = Deno.build.os,
  env = Deno.env,
): Promise<string> {
  let paths!: string[];
  switch (os) {
    case "darwin":
      paths = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ];
      break;
    case "windows":
      paths = [
        env.get("LocalAppData") + "/Google/Chrome/Application/chrome.exe",
        env.get("ProgramFiles") + "/Google/Chrome/Application/chrome.exe",
        env.get("ProgramFiles(x86)") + "/Google/Chrome/Application/chrome.exe",
        env.get("LocalAppData") + "/Chromium/Application/chrome.exe",
        env.get("ProgramFiles") + "/Chromium/Application/chrome.exe",
        env.get("ProgramFiles(x86)") + "/Chromium/Application/chrome.exe",
      ];
      break;
    case "linux":
      paths = [
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
      ];
      break;
  }

  for (const path of paths) {
    if (await exists(path)) {
      return path;
    }
  }

  const downloadDir: string = getDownloadDir(os, env);
  const browserFetcher = new BrowserFetcher(
    downloadDir,
    {
      product: "chrome",
      platform: os as Platform,
    },
  );
  const revision = await browserFetcher.latestRevision();
  const revisionInfo = await browserFetcher.download(revision);
  return revisionInfo.executablePath;
}
