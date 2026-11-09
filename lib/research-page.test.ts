import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractPage, PAGE_LIMITS, pageUrl, publicAddress, readResearchPage } from "./research-page";

const mocks = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }));
vi.mock("node:http", () => ({ request: mocks.request }));
vi.mock("node:https", () => ({ request: mocks.request }));
vi.mock("node:dns", () => ({ lookup: mocks.lookup }));
let replies: { status?: number; headers?: Record<string, string>; body?: string; interrupted?: boolean }[];

beforeEach(() => {
  mocks.request.mockReset();
  mocks.lookup.mockReset();
  replies = [{ body: "<body>Public company page</body>" }];
  mocks.lookup.mockImplementation((_host, _options, callback) => callback(null, [{ address: "93.184.215.14", family: 4 }]));
  mocks.request.mockImplementation((_url, options, callback) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void };
    request.end = () => queueMicrotask(() => {
      options.lookup("example.com", { all: true }, (error: Error | null, addresses: unknown) => {
        if (error) { request.emit("error", error); return; }
        expect(addresses).toEqual([{ address: "93.184.215.14", family: 4 }]);
        const reply = replies.shift()!;
        const response = Object.assign(new PassThrough(), {
          statusCode: reply.status ?? 200, headers: { "content-type": "text/html", ...reply.headers },
        });
        callback(response);
        if (reply.interrupted) response.emit("aborted");
        else response.end(reply.body ?? "");
      });
    });
    return request;
  });
});

describe("public page destinations", () => {
  it.each([
    "http://localhost", "http://test.localhost", "http://127.1", "http://2130706433", "http://10.0.0.1",
    "http://169.254.169.254", "http://[::1]", "http://[::ffff:127.0.0.1]", "http://[fc00::1]",
    "http://[2002:7f00:1::]", "http://example.com:8080", "file:///etc/passwd", "https://user:pass@example.com",
  ])("rejects unsafe URL %s", url => expect(() => pageUrl(url)).toThrow());

  it("permits public IPv4 and global IPv6", () => {
    expect(publicAddress("93.184.215.14")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
    expect(pageUrl("/careers#roles", "https://example.com").href).toBe("https://example.com/careers");
  });

  it("rejects DNS results containing a private address", async () => {
    mocks.lookup.mockImplementation((_host, _options, callback) => callback(null, [
      { address: "93.184.215.14", family: 4 }, { address: "127.0.0.1", family: 4 },
    ]));
    await expect(readResearchPage("https://example.com", AbortSignal.timeout(1000))).rejects.toThrow("non-public");
  });
});

describe("page evidence", () => {
  it("normalizes text, removes scripts, and resolves discovered links", () => {
    const page = extractPage('<title>Company</title><body>Useful   software.<script>secret()</script><a href="/careers#roles">Jobs</a><a href="/careers">Duplicate</a><a href="mailto:test@example.com">Email</a><a href="http://127.0.0.1/">Private</a><a href="https://jobs.example.com/">External careers</a></body>', "https://example.com/");
    expect(page.title).toBe("Company");
    expect(page.text).not.toContain("secret()");
    expect(page.text).toContain("Useful software.");
    expect(page.links).toEqual([
      { url: "https://example.com/careers", text: "Jobs" }, { url: "https://jobs.example.com/", text: "External careers" },
    ]);
    expect(Number.isFinite(Date.parse(page.checked_at))).toBe(true);
  });

  it("caps text and links while prioritizing relevant navigation", () => {
    const html = `<body>${"x".repeat(PAGE_LIMITS.text + 1)}${Array.from({ length: 50 }, (_, i) => `<a href="/link/${i}">Other</a>`).join("")}<a href="/careers">Careers</a></body>`;
    const page = extractPage(html, "https://example.com/");
    expect(page.text).toHaveLength(PAGE_LIMITS.text);
    expect(page.truncated).toBe(true);
    expect(page.links).toHaveLength(PAGE_LIMITS.links);
    expect(page.links[0].url).toBe("https://example.com/careers");
  });

  it("returns HTML evidence from a checked, pinned connection", async () => {
    const page = await readResearchPage("https://example.com", AbortSignal.timeout(1000));
    expect(page.text).toBe("Public company page");
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });

  it("follows relative redirects and records the final URL", async () => {
    replies = [{ status: 302, headers: { location: "/about" } }, { body: "<body>About us</body>" }];
    const page = await readResearchPage("https://example.com", AbortSignal.timeout(1000));
    expect(page.url).toBe("https://example.com/about");
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
  });

  it("blocks redirects into private endpoints", async () => {
    replies = [{ status: 302, headers: { location: "http://127.0.0.1/" } }];
    await expect(readResearchPage("https://example.com", AbortSignal.timeout(1000))).rejects.toThrow("public HTTP");
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it.each<(typeof replies)[number]>([
    { status: 403 }, { headers: { "content-type": "application/pdf" } },
    { headers: { "content-encoding": "gzip" } }, { body: "x".repeat(PAGE_LIMITS.bytes + 1) },
    { interrupted: true },
  ])("rejects unusable or interrupted responses", async reply => {
    replies = [reply];
    await expect(readResearchPage("https://example.com", AbortSignal.timeout(1000))).rejects.toThrow();
  });

  it("stops redirect loops", async () => {
    replies = Array.from({ length: PAGE_LIMITS.redirects + 1 }, () => ({ status: 302, headers: { location: "/again" } }));
    await expect(readResearchPage("https://example.com", AbortSignal.timeout(1000))).rejects.toThrow("redirect limit");
  });

  it("honors an aborted signal without a request", async () => {
    await expect(readResearchPage("https://example.com", AbortSignal.abort())).rejects.toThrow();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
