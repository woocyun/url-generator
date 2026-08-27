/**
 * URL validation and canonicalization for the write path.
 *
 * Canonicalization runs before hashing, and that ordering is the whole point:
 * codes are derived from the URL (ADR 0003), so any difference in the string —
 * an uppercase host, an implicit `:443`, a missing trailing slash on a bare
 * domain — would otherwise produce a second code for one destination and defeat
 * the deduplication the hashing strategy was chosen for.
 *
 * The rule for what to normalize is narrow on purpose: fold differences that
 * provably identify the same resource, and leave everything else alone. A
 * canonicalizer that rewrites a URL into something that fetches different
 * content is worse than one that dedupes less.
 */

/** Longest URL accepted at the edge.
 *
 * The `long_url` column is `text` and has no opinion (design §6); this is a
 * request-validation limit. 2048 is the practical ceiling — the historical IE
 * limit that CDNs, proxies, and server default configurations still cluster
 * around — so a URL longer than this is one we could store but not reliably
 * redirect to.
 */
export const MAX_URL_LENGTH = 2048;

export type CanonicalizeResult =
  | { ok: true; url: string }
  | { ok: false; code: string; message: string };

/**
 * Matches a URL that already carries a scheme *and* an authority.
 *
 * Requiring `//` is what keeps `localhost:3000/x` from parsing as the scheme
 * `localhost`, which is the classic way a lenient shortener mangles a
 * development URL.
 */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

export function canonicalizeUrl(input: string): CanonicalizeResult {
  const trimmed = input.trim();

  if (trimmed === '') {
    return { ok: false, code: 'invalid_url', message: 'url must not be empty' };
  }

  // People paste `example.com/pricing`, not `https://example.com/pricing`.
  // Assuming https rather than http means the guess fails safe: the worst case
  // is a site that only serves plaintext, and every such redirect we would have
  // issued was a downgrade anyway.
  const withScheme = HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, code: 'invalid_url', message: 'url could not be parsed' };
  }

  // A shortener that emits `javascript:` or `data:` in a Location header is a
  // redirect gadget, so the scheme is an allowlist rather than a blocklist.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      code: 'unsupported_scheme',
      message: `only http and https urls can be shortened, got: ${url.protocol.replace(':', '')}`,
    };
  }

  if (url.hostname === '') {
    return { ok: false, code: 'invalid_url', message: 'url must have a host' };
  }

  // The URL parser has already done the normalization that is unambiguously
  // safe: lowercased the scheme and host, punycoded a unicode domain, dropped a
  // default port, and given a bare domain the `/` path it implies.
  //
  // Assigning an empty string here removes a dangling `?` or `#` — `a.com/x?`
  // and `a.com/x` request the same resource, and the parser preserves the
  // marker rather than deciding that for us.
  if (url.search === '') url.search = '';
  if (url.hash === '') url.hash = '';

  // Deliberately NOT normalized, because each of these can change which bytes
  // come back:
  //
  //   - trailing slash on a path (`/about` vs `/about/` are different routes)
  //   - `www.` (a distinct hostname that need not resolve to the same server)
  //   - query parameter order and duplicates (order is only *usually* ignored)
  //   - the fragment (client-side, but `#install` is the destination the user
  //     meant, and dropping it would dedupe two real destinations into one)
  const canonical = url.href;

  if (canonical.length > MAX_URL_LENGTH) {
    return {
      ok: false,
      code: 'url_too_long',
      message: `url must be at most ${MAX_URL_LENGTH} characters, got ${canonical.length}`,
    };
  }

  return { ok: true, url: canonical };
}
