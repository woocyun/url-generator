/**
 * One error shape for every failure the API can produce (design §5).
 *
 * Fastify's defaults are close but not the contract: it answers with
 * `{ statusCode, error, message }`, where `error` is the HTTP reason phrase.
 * Clients that branch on it are branching on prose. These handlers replace it
 * with `ApiError` — a stable `code` plus a human `message` — including for the
 * failures Fastify raises before a handler ever runs, like schema validation
 * and unmatched routes.
 */

import type { FastifyError, FastifyInstance } from 'fastify';
import type { ApiError } from '@url-generator/shared';

/** Codes this service returns. Kept in one place because they are API surface:
 * a client may branch on any of them, so renaming one is a breaking change. */
export const ErrorCode = {
  /** Body was missing, malformed, or failed schema validation. */
  INVALID_REQUEST: 'invalid_request',
  /** No route matched, or no such short code. */
  NOT_FOUND: 'not_found',
  /** The short code resolved, but the link it names is past its expiry. */
  LINK_EXPIRED: 'link_expired',
  /** Something failed that the client cannot do anything about. */
  INTERNAL_ERROR: 'internal_error',
} as const;

export function apiError(code: string, message: string): ApiError {
  return { code, message };
}

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler(async (request, reply) => {
    return reply
      .code(404)
      .send(
        apiError(
          ErrorCode.NOT_FOUND,
          `no route for ${request.method} ${request.url}`,
        ),
      );
  });

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    // Schema validation. Fastify's message already names the offending field
    // ("body/url must be string"), which is the useful part; the generic
    // machine-readable code is what the client branches on.
    if (error.validation !== undefined) {
      return reply
        .code(400)
        .send(apiError(ErrorCode.INVALID_REQUEST, error.message));
    }

    const status = error.statusCode ?? 500;

    // A 4xx is a considered answer: keep the status and the message. The code,
    // though, has to be one of ours. Fastify raises its own `FST_ERR_*` codes
    // for things like unparseable JSON and an oversized body, and letting those
    // through would put the framework's internal identifiers into a contract we
    // then could not change the framework without breaking.
    if (status < 500) {
      const code =
        error.code === undefined || error.code.startsWith('FST_')
          ? ErrorCode.INVALID_REQUEST
          : error.code;

      return reply.code(status).send(apiError(code, error.message));
    }

    // A 5xx is ours. Log the real thing and tell the client nothing about it:
    // stack traces and driver messages are not a contract, and they leak schema
    // details to anyone who can provoke a crash.
    request.log.error({ err: error }, 'unhandled error');

    return reply
      .code(500)
      .send(apiError(ErrorCode.INTERNAL_ERROR, 'internal server error'));
  });
}
