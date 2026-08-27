/**
 * `POST /shorten` — the write path (design §5, F1, F3).
 *
 * Thin on purpose: validate, canonicalize, hand off, and shape the answer. The
 * interesting logic is in `../shorten.ts` — the collision-retry loop for a
 * generated code, the single atomic claim for a chosen one — and what this file
 * owns is the HTTP contract over both.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ShortenRequest, ShortenResponse } from '@url-generator/shared';
import { validateAlias } from '../alias.js';
import { apiError } from '../errors.js';
import { env } from '../env.js';
import { claimAlias, shortenUrl } from '../shorten.js';
import type { UrlMapping } from '../db/schema.js';
import { resolveExpiry } from '../ttl.js';
import { canonicalizeUrl, MAX_URL_LENGTH } from '../url.js';

/**
 * A cheap first pass, rejecting the shapes that are wrong before any work
 * happens. It is not the authoritative length check — canonicalization can
 * lengthen a URL, by adding an assumed `https://` or percent-encoding — so
 * `canonicalizeUrl` measures the form we would actually store.
 *
 * `customAlias` is declared as a bare string with no bounds of its own, and
 * that is deliberate. Every rule about an alias lives in `validateAlias`, so
 * putting `minLength: 3` here as well would mean two sources for one contract
 * and two different error codes for the same mistake — ajv's
 * `invalid_request` for a 2-character alias, our `invalid_alias` for one
 * containing a slash. One place decides, and it is the place that can say why.
 *
 * `additionalProperties: false` because a request carrying a field from a phase
 * that does not exist yet is a client with a wrong idea about this API, and
 * silently dropping the field would let it keep the idea.
 *
 * `expiresIn` follows `customAlias`: the schema checks the *type*, and every
 * bound lives in `resolveExpiry` (`ttl.ts`). The type check has to be here — it is the one
 * thing ajv can enforce that the domain cannot recover, since `coerceTypes` is
 * off and `"3600"` must be a rejection rather than an hour — while `null` is
 * declared as an accepted type because it is a meaningful request ("never
 * expires") and not a missing field.
 */
const shortenBodySchema = {
  type: 'object',
  required: ['url'],
  additionalProperties: false,
  properties: {
    url: { type: 'string', minLength: 1, maxLength: MAX_URL_LENGTH },
    customAlias: { type: 'string' },
    expiresIn: { type: ['integer', 'null'] },
  },
} as const;

/**
 * The success shape, identical whether the code was generated or chosen.
 *
 * 201 for a mapping this request created, 200 for one that already existed.
 * Deduplication and idempotent re-claims are both observable by design, so the
 * status code should say which happened instead of making the client compare
 * timestamps. `Location` points at the redirect from Phase 3.
 */
function sendMapping(
  reply: FastifyReply,
  mapping: UrlMapping,
  created: boolean,
): FastifyReply {
  const body: ShortenResponse = {
    shortCode: mapping.shortCode,
    shortUrl: `${env.publicBaseUrl}/${mapping.shortCode}`,
    longUrl: mapping.longUrl,
    createdAt: mapping.createdAt.toISOString(),
    // Read off the mapping rather than off the request, which is the whole
    // point of it being in the response: on a 200 this is the expiry the link
    // already had, and it may be nothing like the one that was asked for.
    expiresAt: mapping.expiresAt === null ? null : mapping.expiresAt.toISOString(),
    created,
    isCustom: mapping.isCustom,
  };

  if (created) {
    reply.header('Location', body.shortUrl);
  }

  return reply.code(created ? 201 : 200).send(body);
}

export async function shortenRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: ShortenRequest }>(
    '/shorten',
    { schema: { body: shortenBodySchema } },
    async (request, reply) => {
      const canonical = canonicalizeUrl(request.body.url);

      if (!canonical.ok) {
        return reply.code(400).send(apiError(canonical.code, canonical.message));
      }

      // Before any database work, and before the alias branch, because a TTL is
      // a fact about the request that both paths need and neither should decide
      // twice. `resolveExpiry` is also where the deployment's default is
      // applied, so from here down a `null` expiry means "permanent" and never
      // "nobody has decided yet".
      const expiry = resolveExpiry(request.body.expiresIn);

      if (!expiry.ok) {
        return reply.code(400).send(apiError(expiry.code, expiry.message));
      }

      const requested = request.body.customAlias;

      if (requested !== undefined) {
        const alias = validateAlias(requested);

        // 400 for both `invalid_alias` and `alias_reserved`: each is a fact
        // about the string the client sent, and neither becomes true later.
        if (!alias.ok) {
          return reply.code(400).send(apiError(alias.code, alias.message));
        }

        const claim = await claimAlias(alias.alias, canonical.url, expiry.expiresAt);

        // 409 rather than 400, and the difference is the one the client acts
        // on. A reserved alias will never be available and the client should
        // pick a different word; a taken one is a fact about the table right
        // now, and the right response is to try another name or to leave the
        // field empty and take a generated code.
        if (claim.outcome === 'taken') {
          return reply
            .code(409)
            .send(
              apiError(
                'alias_taken',
                `alias "${alias.alias}" is already in use by a different destination`,
              ),
            );
        }

        return sendMapping(reply, claim.mapping, claim.outcome === 'created');
      }

      const result = await shortenUrl(canonical.url, expiry.expiresAt);

      if (result.outcome === 'exhausted') {
        // Loud, per ADR 0003: exhausting the retry budget means the collision
        // model is wrong, and the log needs enough to check that claim against
        // the table.
        request.log.error(
          { longUrl: canonical.url, codes: result.codes },
          'exhausted short code attempts',
        );

        return reply
          .code(500)
          .send(
            apiError(
              'code_generation_failed',
              `could not find a free short code in ${result.attempts} attempts`,
            ),
          );
      }

      return sendMapping(reply, result.mapping, result.outcome === 'created');
    },
  );
}
