// ── Path-mode response rewriting ──
//
// When a relay serves tunnels under a path prefix (e.g. /_t/<sub>) instead of
// a dedicated subdomain, the local app's root-absolute URLs ("/styles.css"),
// redirects ("Location: /login"), and cookie paths ("Path=/") escape the
// prefix and break. These helpers rewrite responses to keep everything under
// the prefix. They are best-effort heuristics for the common cases; a custom
// wildcard domain remains the fully-correct option.

function headerValue(value: string | string[] | undefined): string {
  if (value === undefined) return "";
  return Array.isArray(value) ? (value[0] ?? "") : value;
}

export function isHtmlContentType(value: string | string[] | undefined): boolean {
  return /text\/html/i.test(headerValue(value));
}

/** True if the body is content-encoded (gzip/br/etc.) and thus not safely
 * rewritable without decompressing. */
export function isCompressed(value: string | string[] | undefined): boolean {
  const v = headerValue(value).trim().toLowerCase();
  return v !== "" && v !== "identity";
}

/**
 * Prefix a root-absolute redirect target. Protocol-relative ("//host") and
 * fully-qualified ("https://...") locations are left untouched.
 */
export function rewriteLocation(value: string, prefix: string): string {
  if (value.startsWith("/") && !value.startsWith("//")) return prefix + value;
  return value;
}

/** Prefix the Path attribute of a single Set-Cookie value (adds one if
 * missing so the cookie is scoped to the tunnel). */
export function rewriteSetCookie(value: string, prefix: string): string {
  if (/;\s*path=/i.test(value)) {
    return value.replace(
      /(;\s*path=)(\/[^;]*)/i,
      (_m, attr: string, path: string) => `${attr}${prefix}${path}`
    );
  }
  return `${value}; Path=${prefix}/`;
}

export function rewriteSetCookieHeader(
  value: string | string[],
  prefix: string
): string | string[] {
  return Array.isArray(value)
    ? value.map((v) => rewriteSetCookie(v, prefix))
    : rewriteSetCookie(value, prefix);
}

/**
 * Rewrite root-absolute URLs in an HTML body to sit under `prefix`. Operates
 * on a latin1 view so it is byte-safe for UTF-8 content (the inserted prefix
 * is ASCII). Covers href/src/action-style attributes, srcset, and CSS url().
 */
export function rewriteHtmlPaths(html: Buffer, prefix: string): Buffer {
  const s = html.toString("latin1");
  const out = s
    .replace(
      /(\s(?:href|src|action|formaction|poster|data)\s*=\s*["'])\/(?!\/)/gi,
      `$1${prefix}/`
    )
    .replace(/(\ssrcset\s*=\s*["'])([^"']*)(["'])/gi, (_m, pre, val, post) => {
      const fixed = (val as string).replace(/(^|,\s*)\/(?!\/)/g, `$1${prefix}/`);
      return `${pre}${fixed}${post}`;
    })
    .replace(/url\(\s*(["']?)\/(?!\/)/gi, `url($1${prefix}/`);
  return Buffer.from(out, "latin1");
}
