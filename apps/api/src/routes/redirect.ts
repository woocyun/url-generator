/**
 * `GET /{short_code}` — the read path (design §5, F2).
 *
 * Thin, like `routes/shorten.ts`: the decision is made in `../redirect.ts` and
 * what this file owns is the HTTP contract — which status, which headers, and
 * what a browser that followed a dead link is told.
 *
 * Registered last, after every static route. Fastify prefers a static segment
 * over a parametric one irrespective of declaration order, so the ordering is
 * documentation rather than load-bearing — but the precedence is *per method*,
 * and that part is worth knowing: `/shorten` is declared for POST only, so
 * `GET /shorten` is not a 405, it arrives here as the code `shorten`. Which is
 * harmless, because a mapping stored under that code resolves normally.
 *
 * The namespaces do overlap, though. Generated codes are seven Base62
 * characters, and `shorten` is seven Base62 characters. A route and a code can
 * share a spelling as long as they never share a method — but since Phase 5 a
 * user can *choose* a code, which would make `health` claimable and let it
 * shadow the endpoint. `reserved.ts` is what closes that, on the write path
 * rather than here: this route's job is to resolve whatever is in the table,
 * and keeping the wrong things out of the table is the write path's.
 */

import type { FastifyInstance } from 'fastify';
import { ErrorCode, apiError } from '../errors.js';
import { looksLikeShortCode } from '../short-code.js';
import { resolveShortCode } from '../redirect.js';

/**
 * 302, not 301 — the reference design's recommendation, and the decision is
 * recorded in ADR 0008.
 *
 * A 301 is faster for a repeat visitor because the browser stops asking us. That
 * is precisely the problem: a link we no longer see is one we cannot count
 * (F5), cannot expire (F4), and cannot take down. The latency we give up is
 * what buys the link's lifecycle back.
 */
const REDIRECT_STATUS = 302;

/**
 * Nothing this route returns is cacheable, and the reason is the same for all
 * three answers: every one of them can change without the URL changing.
 *
 * A 302 without it is heuristically cacheable, which quietly reintroduces the
 * 301 problem we just declined. A 404 can become a 302 the moment someone
 * shortens a URL that hashes to that code, and a 410 becomes a 404 once Phase
 * 6's sweep deletes the row. `no-store` rather than `no-cache` because there is
 * no revalidation story here worth the round-trip it would save.
 */
const CACHE_CONTROL = 'no-store';

export async function redirectRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { code: string } }>('/:code', async (request, reply) => {
    reply.header('Cache-Control', CACHE_CONTROL);

    const { code } = request.params;

    // Cheap rejection of everything under the origin that cannot be a code —
    // `/favicon.ico`, `/robots.txt`, scanners walking a wordlist — before any
    // of it reaches Postgres or Redis. Since Phase 4 it guards the cache's
    // keyspace as well as the database's round-trips: without it, anything that
    // can be spelled in a URL path would earn a negative cache entry, and the
    // memory bound on the cache would be whatever points at the origin rather
    // than the size of the link table. Same 404 as an unknown code,
    // deliberately: see `looksLikeShortCode`.
    if (!looksLikeShortCode(code)) {
      return reply
        .code(404)
        .send(apiError(ErrorCode.NOT_FOUND, `no link for /${code}`));
    }

    const resolution = await resolveShortCode(code);

    // The one line that makes the cache observable. Every answer this route
    // gives says whether it cost a Postgres round-trip, so the hit rate ADR
    // 0009 is justified by is something the logs can be asked about rather
    // than something we assume. Debug level: at design §2's read rate this is
    // 11,500 lines a second, and Phase 9's metrics are where a counter belongs.
    request.log.debug(
      { shortCode: code, source: resolution.source, outcome: resolution.outcome },
      'resolved short code',
    );

    switch (resolution.outcome) {
      case 'found':
        return reply
          .header('Location', resolution.longUrl)
          .code(REDIRECT_STATUS)
          .send();

      // 410 rather than 404, because the two are different facts and only one
      // of them is worth acting on: a crawler that gets a 410 drops the URL,
      // and a human gets told the link existed and ran out rather than that
      // they mistyped it. It is not permanent — Phase 6's sweep deletes expired
      // rows, and this code answers 404 afterwards — but "gone" is the honest
      // answer for as long as we can still tell.
      case 'expired':
        return reply
          .code(410)
          .send(
            apiError(
              ErrorCode.LINK_EXPIRED,
              `link expired at ${resolution.expiredAt.toISOString()}`,
            ),
          );

      // Unreachable through the write path, which is why it is loud. A stored
      // destination that is not http(s) means something wrote to the table
      // without going through canonicalization, and the client learns nothing:
      // echoing the URL back would hand a scheme we refuse to redirect to
      // straight to the caller who planted it.
      case 'unsafe':
        request.log.error(
          { shortCode: code, longUrl: resolution.longUrl },
          'refusing to redirect to a non-http(s) destination',
        );

        return reply
          .code(500)
          .send(apiError(ErrorCode.INTERNAL_ERROR, 'internal server error'));

      case 'not-found':
        return reply
          .code(404)
          .send(apiError(ErrorCode.NOT_FOUND, `no link for /${code}`));
    }
  });
}
