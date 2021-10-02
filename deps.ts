export { ensureDir } from "https://deno.land/std@0.109.0/fs/ensure_dir.ts";
export { ensureFile } from "https://deno.land/std@0.109.0/fs/ensure_file.ts";
export { exists } from "https://deno.land/std@0.109.0/fs/exists.ts";
export {
  basename,
  dirname,
  fromFileUrl,
  join,
  resolve,
} from "https://deno.land/std@0.109.0/path/mod.ts";

export { concat } from "https://deno.land/std@0.109.0/bytes/mod.ts";

// TODO: Remove this import statement.
export { decode, encode } from "https://deno.land/std@0.84.0/encoding/utf8.ts";
export {
  decode as decodeFromBase64,
  encode as encodeToBase64,
} from "https://deno.land/std@0.109.0/encoding/base64.ts";

export { deferred } from "https://deno.land/std@0.109.0/async/mod.ts";
export type { Deferred } from "https://deno.land/std@0.109.0/async/mod.ts";

export {
  BufReader,
  copy,
  readAll,
  readerFromStreamReader,
  writeAll,
} from "https://deno.land/std@0.109.0/io/mod.ts";

export { sprintf } from "https://deno.land/std@0.109.0/fmt/printf.ts";

export {
  assert,
  assertEquals,
  assertStrictEquals,
  assertStringIncludes,
  assertThrowsAsync,
  fail,
} from "https://deno.land/std@0.109.0/testing/asserts.ts";

export { default as aiReduce } from "https://cdn.skypack.dev/ai-reduce@2.1.0";

export { default as puppeteer } from "https://unpkg.com/puppeteer@10.4.0/lib/esm/puppeteer/web.js";
export { EventEmitter } from "https://unpkg.com/puppeteer@10.4.0/lib/esm/puppeteer/common/EventEmitter.js";
export { BrowserWebSocketTransport } from "https://unpkg.com/puppeteer@10.4.0/lib/esm/puppeteer/common/BrowserWebSocketTransport.js";

export type { Browser } from "https://unpkg.com/puppeteer@10.4.0/lib/esm/puppeteer/common/Browser.js";
export type { Target } from "https://unpkg.com/puppeteer@10.4.0/lib/esm/puppeteer/common/Target.js";
export type { CDPSession } from "https://unpkg.com/puppeteer@10.4.0/lib/esm/puppeteer/common/Connection.js";
export type { Page } from "https://unpkg.com/puppeteer@10.4.0/lib/esm/puppeteer/common/Page.js";
export type { Product } from "https://unpkg.com/puppeteer@10.4.0/lib/esm/puppeteer/common/Product.d.ts";
