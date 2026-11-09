/**
 * @fileoverview Reads public HTML pages and extracts bounded text and links.
 * Enforces network safety and fetch limits; contains no assessment logic.
 *
 * Supplies webpage evidence to lib/company-research.ts.
 * See docs/company-research-engine.md for fetch limits and extraction constraints.
 */

import { lookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { load } from "cheerio";

export const PAGE_LIMITS = { bytes: 512_000, text: 12_000, links: 40, redirects: 3, timeoutMs: 15_000 };
export type ResearchPage = {
  url: string; checked_at: string; title: string; text: string; truncated: boolean;
  links: { url: string; text: string }[];
};

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");

// Restrict page reads to public web endpoints; DNS results receive the same check.
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4")
    : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export function pageUrl(value: string, base?: string): URL {
  const url = new URL(value, base);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.port || hostname === "localhost" || hostname.endsWith(".localhost") ||
      (isIP(hostname) && !publicAddress(hostname))) {
    throw new Error("Page URL must use a public HTTP or HTTPS endpoint on its default port.");
  }
  url.hash = "";
  return url;
}

// Static HTML only. Relevant navigation comes first so a link cap keeps careers/product pages.
export function extractPage(html: string, url: string): ResearchPage {
  // 1. Remove executable content and normalize the visible text.
  // 2. Resolve and deduplicate safe links, prioritizing useful research paths.
  // 3. Return bounded evidence with its retrieval time.
  const $ = load(html);
  $("script, style, noscript").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  const links = new Map<string, string>();
  $("a[href]").each((_, element) => {
    try {
      const target = pageUrl($(element).attr("href")!, url).href;
      if (target !== url && !links.has(target)) links.set(target, $(element).text().replace(/\s+/g, " ").trim().slice(0, 200));
    } catch { /* Non-web and private links are not research destinations. */ }
  });
  const relevant = (link: { url: string; text: string }) => /career|jobs|about|product|team|engineering/i.test(link.url + " " + link.text);
  return {
    url, checked_at: new Date().toISOString(), title: $("title").text().trim().slice(0, 300),
    text: text.slice(0, PAGE_LIMITS.text), truncated: text.length > PAGE_LIMITS.text,
    links: [...links].map(([url, text]) => ({ url, text }))
      .sort((a, b) => Number(relevant(b)) - Number(relevant(a))).slice(0, PAGE_LIMITS.links),
  };
}

// Validate every redirect and pin DNS resolution to the checked address for each connection.
export async function readResearchPage(value: string, parentSignal: AbortSignal): Promise<ResearchPage> {
  // 1. Apply one deadline across DNS, redirects, and body reading.
  // 2. Fetch bounded HTML without automatic redirects or decompression.
  // 3. Extract evidence only after a successful HTML response.
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(PAGE_LIMITS.timeoutMs)]);
  let url = pageUrl(value);
  for (let redirects = 0; redirects <= PAGE_LIMITS.redirects; redirects++) {
    signal.throwIfAborted();
    const result = await new Promise<{ html?: string; location?: string }>((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        signal,
        headers: { Accept: "text/html", "Accept-Encoding": "identity" },
        lookup(hostname, _options, callback) {
          lookup(hostname, { all: true }, (error, addresses) => {
            if (error) return callback(error, "", 4);
            if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
              return callback(new Error("Page hostname resolves to a non-public address."), "", 4);
            }
            const selected = addresses.find(address => address.family === 4) ?? addresses[0];
            callback(null, _options.all ? [selected] : selected.address, selected.family);
          });
        },
      }, response => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.destroy();
          resolve({ location: response.headers.location });
          return;
        }
        if (status < 200 || status >= 300 || !response.headers["content-type"]?.toLowerCase().includes("text/html") ||
            (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")) {
          response.destroy();
          reject(new Error(`Page request failed: HTTP ${status}; expected uncompressed HTML.`));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > PAGE_LIMITS.bytes) {
            reject(new Error("Page exceeds response byte limit."));
            response.destroy();
          } else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("aborted", () => reject(new Error("Page response interrupted.")));
        response.on("end", () => resolve({ html: Buffer.concat(chunks).toString("utf8") }));
      });
      request.on("error", reject);
      request.end();
    });
    if (result.location !== undefined) {
      url = pageUrl(result.location, url.href);
      continue;
    }
    return extractPage(result.html!, url.href);
  }
  throw new Error("Page exceeds redirect limit.");
}
