/**
 * Adopted from https://github.com/puppeteer/puppeteer/blob/f2e19276acb80e596ff5c781c9ae2bc2f2a8f363/src/node/BrowserFetcher.ts
 * which is licensed as follows:
 *
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  aiReduce,
  assert,
  basename,
  copy,
  decode,
  ensureDir,
  exists,
  join,
  Product,
  readerFromStreamReader,
  sprintf,
} from "./deps.ts";

function debugFetcher(...args: unknown[]) {
  console.debug("browser_fetcher:", ...args);
}

const os: "linux" | "darwin" | "windows" | string = Deno.build.os;
const arch: "aarch64" | "arm64" | "x64" | "x86_64" = Deno.build.arch;

/**
 * Supported platforms.
 * @public
 */
export type Platform = "linux" | "mac" | "win32" | "win64";

const downloadURLs: Record<Product, Record<Platform, string>> = {
  chrome: {
    linux: "%s/chromium-browser-snapshots/Linux_x64/%d/%s.zip",
    mac: "%s/chromium-browser-snapshots/Mac/%d/%s.zip",
    win32: "%s/chromium-browser-snapshots/Win/%d/%s.zip",
    win64: "%s/chromium-browser-snapshots/Win_x64/%d/%s.zip",
  },
  firefox: {
    linux: "%s/firefox-%s.en-US.%s-x86_64.tar.bz2",
    mac: "%s/firefox-%s.en-US.%s.dmg",
    win32: "%s/firefox-%s.en-US.%s.zip",
    win64: "%s/firefox-%s.en-US.%s.zip",
  },
} as const;

const browserConfig: Record<Product, { host: string; destination: string }> = {
  chrome: {
    host: "https://storage.googleapis.com",
    destination: ".local-chromium",
  },
  firefox: {
    host:
      "https://archive.mozilla.org/pub/firefox/nightly/latest-mozilla-central",
    destination: ".local-firefox",
  },
} as const;

function archiveName(
  product: Product,
  platform: Platform,
  revision: string,
): string {
  if (product === "chrome") {
    if (platform === "linux") return "chrome-linux";
    if (platform === "mac") return "chrome-mac";
    if (platform === "win32" || platform === "win64") {
      // Windows archive name changed at r591479.
      return parseInt(revision, 10) > 591479 ? "chrome-win" : "chrome-win32";
    }
  } else if (product === "firefox") {
    return platform;
  }
  throw new Error("unexpectedly could not figure out the archiveName.");
}

/**
 * @internal
 */
function downloadURL(
  product: Product,
  platform: Platform,
  host: string,
  revision: string,
): string {
  return sprintf(
    downloadURLs[product][platform],
    host,
    revision,
    archiveName(product, platform, revision),
  );
}

/**
 * @internal
 */
function firefoxName(
  platform: Platform,
): RegExp {
  const suffix: string = sprintf(
    downloadURLs.firefox[platform],
    "",
    "|",
    platform,
  ).replace(/^\/firefox-.*en-US/, "en-US");
  return new RegExp("^firefox-(.*)\." + suffix.replace(".", "\\.") + "$");
}

/**
 * @internal
 */
async function handleArm64(): Promise<BrowserFetcherRevisionInfo | never> {
  if (await exists("/usr/bin/chromium-browser")) {
    return {
      local: true,
      product: "chromium",
      executablePath: "/usr/bin/chromium-browser",
    };
  }

  if (await exists("/usr/bin/chromium")) {
    return {
      local: true,
      product: "chromium",
      executablePath: "/usr/bin/chromium",
    };
  }

  console.error(
    "The chromium binary is not available for arm64." +
      "\nIf you are on Ubuntu, you can install with: " +
      "\n\n sudo apt install chromium\n" +
      "\n\n sudo apt install chromium-browser\n",
  );
  throw new Error();
}

/**
 * @public
 */
export interface BrowserFetcherOptions {
  platform?: Platform;
  product?: string;
  path?: string;
  host?: string;
}

/**
 * @public
 */
export interface BrowserFetcherRevisionInfo {
  executablePath: string;
  local: boolean;
  product: string;
  folderPath?: string;
  url?: string;
  revision?: string;
}

/**
 * BrowserFetcher can download and manage different versions of Chromium and Firefox.
 *
 * @remarks
 * BrowserFetcher operates on revision strings that specify a precise version of Chromium, e.g. `"533271"`. Revision strings can be obtained from {@link http://omahaproxy.appspot.com/ | omahaproxy.appspot.com}.
 * In the Firefox case, BrowserFetcher downloads Firefox Nightly and
 * operates on version numbers such as `"75"`.
 *
 * @example
 * An example of using BrowserFetcher to download a specific version of Chromium
 * and running Puppeteer against it:
 *
 * ```js
 * const browserFetcher = puppeteer.createBrowserFetcher();
 * const revisionInfo = await browserFetcher.download('533271');
 * const browser = await puppeteer.launch({executablePath: revisionInfo.executablePath})
 * ```
 *
 * **NOTE** BrowserFetcher is not designed to work concurrently with other
 * instances of BrowserFetcher that share the same downloads directory.
 *
 * @public
 */

export class BrowserFetcher {
  private readonly _product: Product;
  private readonly _downloadsFolder: string;
  private readonly _downloadHost: string;
  private _platform!: Platform;

  /**
   * @internal
   */
  constructor(projectRoot: string, options: BrowserFetcherOptions = {}) {
    this._product = (options.product || "chrome").toLowerCase() as Product;
    assert(
      this._product === "chrome" || this._product === "firefox",
      `Unknown product: "${options.product}"`,
    );

    this._downloadsFolder = options.path ||
      join(projectRoot, browserConfig[this._product].destination);
    this._downloadHost = options.host || browserConfig[this._product].host;

    this.setPlatform(options.platform);
    assert(this._platform);
    assert(
      downloadURLs[this._product][this._platform],
      "Unsupported platform: " + this._platform,
    );
  }

  private setPlatform(platformFromOptions?: Platform): void {
    if (platformFromOptions) {
      this._platform = platformFromOptions;
      return;
    }

    switch (os) {
      case "darwin":
        this._platform = "mac";
        break;
      case "linux":
        this._platform = "linux";
        break;
      case "win32":
        this._platform = arch === "x64" ? "win64" : "win32";
        break;
    }
    assert(this._platform, "Unsupported platform: " + os);
  }

  /**
   * @returns Returns the current `Platform`, which is one of `mac`, `linux`,
   * `win32` or `win64`.
   */
  platform(): Platform {
    return this._platform;
  }

  /**
   * @returns Returns the current `Product`, which is one of `chrome` or
   * `firefox`.
   */
  product(): Product {
    return this._product;
  }

  /**
   * @returns The download host being used.
   */
  host(): string {
    return this._downloadHost;
  }

  /**
   * Initiates a HEAD request to check if the revision is available.
   * @remarks
   * This method is affected by the current `product`.
   * @param revision - The revision to check availability for.
   * @returns A promise that resolves to `true` if the revision could be downloaded
   * from the host.
   */
  async canDownload(revision: string): Promise<boolean> {
    const url: string = downloadURL(
      this._product,
      this._platform,
      this._downloadHost,
      revision,
    );
    try {
      return (await fetch(url, { method: "HEAD" })).ok;
    } catch (error) {
      console.error(error);
      return false;
    }
  }

  /**
   * Initiates a GET request to download the revision from the host.
   * @remarks
   * This method is affected by the current `product`.
   * @param revision - The revision to download.
   * @param progressCallback - A function that will be called with two arguments:
   * How many bytes have been downloaded and the total number of bytes of the download.
   * @returns A promise with revision information when the revision is downloaded
   * and extracted.
   */
  async download(
    revision: string,
    progressCallback: (downloadedBytes: number, totalBytes: number) => void =
      noop,
  ): Promise<BrowserFetcherRevisionInfo> {
    const url: string = downloadURL(
      this._product,
      this._platform,
      this._downloadHost,
      revision,
    );
    const fileName: string = url.split("/").pop()!;
    const archivePath: string = join(this._downloadsFolder, fileName);
    const outputPath: string = this._getFolderPath(revision);

    if (await exists(outputPath)) {
      return this.revisionInfo(revision);
    }

    if (!(await exists(this._downloadsFolder))) {
      await Deno.mkdir(this._downloadsFolder, { recursive: true });
    }

    // Use Intel x86 builds on Apple M1 until native macOS arm64
    // Chromium builds are available.
    if (os !== "darwin" && ["aarch64", "arm64"].includes(arch)) {
      return handleArm64();
    }

    try {
      await downloadFile(url, archivePath, progressCallback);
      await install(archivePath, outputPath);
    } finally {
      if (await exists(archivePath)) {
        // await Deno.remove(archivePath);
      }
    }
    const revisionInfo: BrowserFetcherRevisionInfo = await this.revisionInfo(
      revision,
    );
    if (revisionInfo) {
      await Deno.chmod(revisionInfo.executablePath, 0o755);
    }
    return revisionInfo;
  }

  /**
   * @remarks
   * This method is affected by the current `product`.
   * @returns A promise with a list of all revision strings (for the current `product`)
   * available locally on disk.
   */
  async localRevisions(): Promise<string[]> {
    if (!(await exists(this._downloadsFolder))) {
      return [];
    }

    const dirEntries: Deno.DirEntry[] = await aiReduce(
      Deno.readDir(this._downloadsFolder),
      (acc: Deno.DirEntry[], x: Deno.DirEntry) => acc.concat(x),
      [],
    );

    return dirEntries
      .map(({ name }) => parseFolderPath(this._product, name))
      .filter((entry) => entry?.platform === this._platform)
      .map((entry) => entry!.revision);
  }

  async latestRevision(): Promise<string> {
    const revision: string = this._product === "chrome"
      ? await this.latestChromeRevision()
      : await this.latestFirefoxRevision();

    assert(
      typeof revision === "string" && revision.length > 0,
      `Could not find latest version of ${this._product} for ${this._platform} on ${this._downloadHost}`,
    );
    return revision;
  }

  private async latestChromeRevision(): Promise<string> {
    const url = downloadURL(
      "chrome",
      this._platform,
      this._downloadHost,
      "none",
    ).replace(/\/[^/]+\/[^/]+$/, "/LAST_CHANGE");
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Could not check latest version of chrome for ${this._platform}. Got HTTP Status ${response.status} from ${url}`,
      );
    }
    return (await response.text()).trim();
  }

  private async latestFirefoxRevision(): Promise<string> {
    const url = downloadURL(
      "firefox",
      this._platform,
      this._downloadHost,
      "none",
    ).replace(/\/[^/]+$/, "/");
    const response = await fetch(url, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(
        `Could not check latest version of firefox for ${this._platform}. Got HTTP Status ${response.status} from ${url}`,
      );
    }
    const body: { files: { name: string }[] } = await response.json();
    const isName = (name: string) => firefoxName(this._platform).test(name);
    const names = body.files.map(({ name }) => name).filter(isName);
    const revisions = names
      .map((name) => firefoxName(this._platform).exec(name))
      .filter(Boolean)
      .map((captureGroups) => captureGroups![1])
      .filter(Boolean);
    return revisions[0];
  }

  /**
   * @remarks
   * This method is affected by the current `product`.
   * @param revision - A revision to remove for the current `product`.
   * @returns A promise that resolves when the revision has been removes or
   * throws if the revision has not been downloaded.
   */
  async remove(revision: string): Promise<void> {
    const folderPath = this._getFolderPath(revision);
    assert(
      await exists(folderPath),
      `Failed to remove: revision ${revision} is not downloaded`,
    );
    await Deno.remove(folderPath, { recursive: true });
  }

  /**
   * @param revision - The revision to get info for.
   * @returns The revision info for the given revision.
   */
  async revisionInfo(revision: string): Promise<BrowserFetcherRevisionInfo> {
    const folderPath = this._getFolderPath(revision);
    let executablePath = "";
    if (this._product === "chrome") {
      if (this._platform === "mac") {
        executablePath = join(
          folderPath,
          archiveName(this._product, this._platform, revision),
          "Chromium.app",
          "Contents",
          "MacOS",
          "Chromium",
        );
      } else if (this._platform === "linux") {
        executablePath = join(
          folderPath,
          archiveName(this._product, this._platform, revision),
          "chrome",
        );
      } else if (this._platform === "win32" || this._platform === "win64") {
        executablePath = join(
          folderPath,
          archiveName(this._product, this._platform, revision),
          "chrome.exe",
        );
      } else throw new Error("Unsupported platform: " + this._platform);
    } else if (this._product === "firefox") {
      if (this._platform === "mac") {
        executablePath = join(
          folderPath,
          "Firefox Nightly.app",
          "Contents",
          "MacOS",
          "firefox",
        );
      } else if (this._platform === "linux") {
        executablePath = join(folderPath, "firefox", "firefox");
      } else if (this._platform === "win32" || this._platform === "win64") {
        executablePath = join(folderPath, "firefox", "firefox.exe");
      } else throw new Error("Unsupported platform: " + this._platform);
    } else throw new Error("Unsupported product: " + this._product);
    const url = downloadURL(
      this._product,
      this._platform,
      this._downloadHost,
      revision,
    );
    const local = await exists(folderPath);
    debugFetcher({
      revision,
      executablePath,
      folderPath,
      local,
      url,
      product: this._product,
    });
    return {
      revision,
      executablePath,
      folderPath,
      local,
      url,
      product: this._product,
    };
  }

  /**
   * @internal
   */
  _getFolderPath(revision: string): string {
    return join(this._downloadsFolder, `${this._platform}-${revision}`);
  }
}

function parseFolderPath(
  product: Product,
  folderPath: string,
): { product: string; platform: string; revision: string } | undefined {
  const name: string = basename(folderPath);
  const splits: [Platform, string] = name.split("-") as [Platform, string];
  if (splits.length !== 2) {
    return undefined;
  }

  const [platform, revision] = splits;
  if (!downloadURLs[product][platform]) {
    return undefined;
  }

  return { product, platform, revision };
}

/**
 * @internal
 */
function noop(): void {}

/**
 * @internal
 */
async function downloadFile(
  url: string,
  destinationPath: string,
  progressCallback: (downloadedBytes: number, totalBytes: number) => void,
): Promise<void> {
  debugFetcher(`Downloading binary from ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    await response.body?.cancel("Response status not ok.");
    throw new Error(
      `Download failed: server returned code ${response.status}. URL: ${url}`,
    );
  }
  const totalBytes: number = parseInt(
    response.headers.get("content-length") as string,
    10,
  );
  let downloadedBytes = 0;

  const file = await Deno.open(destinationPath, {
    create: true,
    write: true,
  });

  const [streamForFile, streamForProgress]: [
    ReadableStream<Uint8Array>,
    ReadableStream<Uint8Array>,
  ] = response.body!.tee();

  const readerForProgress = streamForProgress.getReader();
  while (true) {
    const readResult: { done: false; value: Uint8Array } | { done: true } =
      await readerForProgress.read();

    if (readResult.done) {
      break;
    }

    downloadedBytes += readResult.value.length;
    progressCallback(downloadedBytes, totalBytes);
  }

  await copy(
    readerFromStreamReader(streamForFile.getReader()),
    file,
  );
  file.close();
}

async function install(
  archivePath: string,
  folderPath: string,
): Promise<void> {
  debugFetcher(`Installing ${archivePath} to ${folderPath}`);

  if (archivePath.endsWith(".zip")) {
    return extractZip(archivePath, folderPath);
  }

  if (archivePath.endsWith(".tar.bz2")) {
    return extractTarBzip2(archivePath, folderPath);
  }

  if (archivePath.endsWith(".dmg")) {
    await Deno.mkdir(folderPath);
    return installDMG(archivePath, folderPath);
  }

  throw new Error(`Unsupported archive format: ${archivePath}`);
}

/**
 * @internal
 */
async function extractZip(zipPath: string, folderPath: string): Promise<void> {
  try {
    await ensureDir(folderPath);

    const cwd = folderPath;
    const cmd = Deno.build.os === "windows"
      ? [
        "PowerShell",
        "Expand-Archive",
        "-Path",
        zipPath,
        "-DestinationPath",
        folderPath,
      ]
      : ["unzip", "-q", zipPath];

    const process: Deno.Process = Deno.run({ cwd, cmd });
    await process.status();
  } catch (error) {
    await Deno.remove(folderPath, { recursive: true });
    console.error(
      `ERROR: Could not extract ${zipPath} into ${folderPath}.`,
    );
    throw error;
  }
}

/**
 * @internal
 */
async function extractTarBzip2(
  tarBz2Path: string,
  folderPath: string,
): Promise<void> {
  try {
    await ensureDir(folderPath);

    const cwd = folderPath;
    const cmd = ["tar", "xjf", tarBz2Path];

    const process: Deno.Process = Deno.run({ cwd, cmd });
    await process.status();
  } catch (error) {
    await Deno.remove(folderPath, { recursive: true });
    console.error(
      `ERROR: Could not extract ${tarBz2Path} into ${folderPath}.`,
    );
    throw error;
  }
}

async function asyncIterableToArray<T>(
  asyncIterable: AsyncIterable<T>,
): Promise<T[]> {
  const result: T[] = [];
  for await (const item of asyncIterable) {
    result.push(item);
  }
  return result;
}

/**
 * @internal
 */
async function installDMG(dmgPath: string, folderPath: string): Promise<void> {
  let mountPath: string | undefined;

  async function mountAndCopy(): Promise<void> {
    const mountCommand: string[] = [
      `hdiutil`,
      `attach`,
      `-nobrowse`,
      `-noautoopen`,
      dmgPath,
    ];

    const mountProcess: Deno.Process = Deno.run({
      cmd: mountCommand,
      stdout: "piped",
    });
    await mountProcess.status();
    const stdout: string = decode(await mountProcess.output())
      .trim();

    const volumes: RegExpMatchArray | null = stdout.match(/\/Volumes\/(.*)/m);
    if (!volumes) {
      throw new Error(`Could not find volume path in ${stdout}`);
    }
    mountPath = volumes[0];
    const fileNames: Deno.DirEntry[] = await asyncIterableToArray(
      Deno.readDir(mountPath),
    );
    const appName = fileNames.map((entry) => entry.name)
      .find(
        (name) => typeof name === "string" && name.endsWith(".app"),
      );
    if (!appName) {
      throw new Error(`Cannot find app in ${mountPath}`);
    }
    const copyPath = join(mountPath, appName);
    debugFetcher(`Copying ${copyPath} to ${folderPath}`);
    await ensureDir(folderPath);
    await Deno.copyFile(copyPath, folderPath);
  }

  async function unmount(): Promise<void> {
    if (!mountPath) {
      return;
    }

    const unmountCommand: string[] = [`hdiutil`, `detach`, mountPath, `-quiet`];
    debugFetcher(`Unmounting ${mountPath}`);
    try {
      const process: Deno.Process = await Deno.run({ cmd: unmountCommand });
      await process.status();
    } catch (error) {
      console.error(`Error unmounting dmg: ${error}`);
    }
  }

  try {
    await mountAndCopy();
  } finally {
    await unmount();
  }
}
