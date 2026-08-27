/**
 * `POST /shorten` — the write path (design §5, F1).
 *
 * Thin on purpose: validate, canonicalize, hand off to `shortenUrl`, and shape
 * the answer. The interesting logic is the retry loop in `../shorten.ts`; what
 * this file owns is the HTTP contract.
 */

import type { FastifyInstance } from 'fastify';
import type { ShortenRequest, ShortenResponse } from '@url-generator/shared';
import { apiError } from '../errors.js';
import { env } from '../env.js';
import { shortenUrl } from '../shorten.js';
import { canonicalizeUrl, MAX_URL_LENGTH } from '../url.js';

/**
 * A cheap first pass, rejecting the shapes that are wrong before any work
 * happens. It is not the authoritative length check — canonicalization can
 * lengthen a URL, by adding an assumed `https://` or percent-encoding — so
 * `canonicalizeUrl` measures the form we would actually store.
 *
 * `additionalProperties: false` because a request carrying `expiresAt` or
 * `customAlias` today is a client written against a phase that does not exist
 * yet, and silently dropping the field would let it believe otherwise.
 */
const shortenBodySchema = {
  type: 'object',
  required: ['url'],
  additionalProperties: false,
  properties: {
    url: { type: 'string', minLength: 1, maxLength: MAX_URL_LENGTH },
  },
} as const;

export async function shortenRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: ShortenRequest }>(
    '/shorten',
    { schema: { body: shortenBodySchema } },
    async (request, reply) => {
      const canonical = canonicalizeUrl(request.body.url);

      if (!canonical.ok) {
        return reply.code(400).send(apiError(canonical.code, canonical.message));
      }

      const result = await shortenUrl(canonical.url);

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

      const { mapping } = result;
      const created = result.outcome === 'created';

      const body: ShortenResponse = {
        shortCode: mapping.shortCode,
        shortUrl: `${env.publicBaseUrl}/${mapping.shortCode}`,
        longUrl: mapping.longUrl,
        createdAt: mapping.createdAt.toISOString(),
        created,
      };

      // 201 for a mapping this request created, 200 for one that already
      // existed. Deduplication is observable by design (ADR 0003), so the
      // status code should say which happened instead of making the client
      // compare timestamps. `Location` points at the redirect Phase 3 adds.
      if (created) {
        reply.header('Location', body.shortUrl);
      }

      return reply.code(created ? 201 : 200).send(body);
    },
  );
}
