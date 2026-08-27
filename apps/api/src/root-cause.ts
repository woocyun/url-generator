/**
 * Unwrapping the error a driver actually hit.
 *
 * Both drivers this service talks through wrap failures before they surface:
 * Drizzle reports "Failed query: ..." and hangs the real fault off `cause`,
 * and a connection error can be nested more than one level down. The useful
 * part — `ECONNREFUSED`, an auth failure, a missing database — is at the
 * bottom of the chain, and it is the part someone reading a health response
 * needs.
 */
export function rootCauseMessage(error: unknown): string {
  let current = error;

  while (current instanceof Error && current.cause !== undefined) {
    current = current.cause;
  }

  return current instanceof Error ? current.message : String(current);
}
