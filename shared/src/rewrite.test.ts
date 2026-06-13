import { describe, it, expect } from "vitest";
import {
  rewriteLocation,
  rewriteSetCookie,
  rewriteSetCookieHeader,
  rewriteHtmlPaths,
  isHtmlContentType,
  isCompressed,
} from "./rewrite.js";

const PREFIX = "/_t/abc123";

describe("rewriteLocation", () => {
  it("prefixes a root-absolute redirect", () => {
    expect(rewriteLocation("/login", PREFIX)).toBe("/_t/abc123/login");
  });

  it("leaves protocol-relative and absolute URLs untouched", () => {
    expect(rewriteLocation("//cdn.example.com/x", PREFIX)).toBe("//cdn.example.com/x");
    expect(rewriteLocation("https://example.com/x", PREFIX)).toBe("https://example.com/x");
  });

  it("leaves relative redirects untouched", () => {
    expect(rewriteLocation("next", PREFIX)).toBe("next");
  });
});

describe("rewriteSetCookie", () => {
  it("prefixes an existing Path attribute", () => {
    expect(rewriteSetCookie("sid=1; Path=/; HttpOnly", PREFIX)).toBe(
      "sid=1; Path=/_t/abc123/; HttpOnly"
    );
  });

  it("adds a scoped Path when absent", () => {
    expect(rewriteSetCookie("sid=1; HttpOnly", PREFIX)).toBe(
      "sid=1; HttpOnly; Path=/_t/abc123/"
    );
  });

  it("rewrites each cookie in an array", () => {
    const out = rewriteSetCookieHeader(["a=1; Path=/", "b=2; Path=/app"], PREFIX);
    expect(out).toEqual([
      "a=1; Path=/_t/abc123/",
      "b=2; Path=/_t/abc123/app",
    ]);
  });
});

describe("rewriteHtmlPaths", () => {
  it("prefixes root-absolute href/src/action", () => {
    const html = Buffer.from(
      `<link href="/styles.css"><script src="/app.js"></script><form action="/submit">`
    );
    const out = rewriteHtmlPaths(html, PREFIX).toString();
    expect(out).toContain('href="/_t/abc123/styles.css"');
    expect(out).toContain('src="/_t/abc123/app.js"');
    expect(out).toContain('action="/_t/abc123/submit"');
  });

  it("leaves protocol-relative and absolute URLs untouched", () => {
    const html = Buffer.from(
      `<img src="//cdn/x.png"><a href="https://x.com/y">`
    );
    const out = rewriteHtmlPaths(html, PREFIX).toString();
    expect(out).toContain('src="//cdn/x.png"');
    expect(out).toContain('href="https://x.com/y"');
  });

  it("rewrites srcset entries and css url()", () => {
    const html = Buffer.from(
      `<img srcset="/a.png 1x, /b.png 2x"><div style="background:url(/bg.png)">`
    );
    const out = rewriteHtmlPaths(html, PREFIX).toString();
    expect(out).toContain("/_t/abc123/a.png 1x, /_t/abc123/b.png 2x");
    expect(out).toContain("url(/_t/abc123/bg.png)");
  });

  it("preserves multibyte UTF-8 content", () => {
    const html = Buffer.from(`<a href="/x">café — 日本語</a>`, "utf8");
    const out = rewriteHtmlPaths(html, PREFIX);
    expect(out.toString("utf8")).toContain("café — 日本語");
    expect(out.toString("utf8")).toContain('href="/_t/abc123/x"');
  });
});

describe("content-type helpers", () => {
  it("detects html", () => {
    expect(isHtmlContentType("text/html; charset=utf-8")).toBe(true);
    expect(isHtmlContentType("application/json")).toBe(false);
    expect(isHtmlContentType(undefined)).toBe(false);
  });

  it("detects compression", () => {
    expect(isCompressed("gzip")).toBe(true);
    expect(isCompressed("identity")).toBe(false);
    expect(isCompressed(undefined)).toBe(false);
  });
});
