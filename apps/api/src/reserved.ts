/**
 * Codes nothing may claim — neither a user's alias nor a generated code.
 *
 * Phase 5 is the first time anyone gets to *choose* a string under our origin,
 * and that turns two previously-theoretical overlaps into real ones. The
 * redirect route (`routes/redirect.ts`) named them both while deferring them to
 * this phase:
 *
 * 1. `/{code}` is the catch-all under `/`, so a route and a code can share a
 *    spelling as long as they never share a method. `GET /shorten` is not a
 *    405 — it arrives at the redirect handler as the code `shorten`. Harmless
 *    while nobody can create that code; a live redirect the moment someone can.
 * 2. Every word on this list is worth more to whoever claims it than to us,
 *    for the same reason: it reads as though the service, rather than a
 *    stranger, chose where it points.
 *
 * The check is case-insensitive even though the code namespace is not (see
 * `alias.ts`). Fastify matches routes case-sensitively, so `/Health` would not
 * actually shadow `/health` — but shadowing is only half of why these are
 * reserved. `/Login` is as convincing as `/login` to the person deciding
 * whether to click it, and a reserved-word list that a single capital letter
 * walks around is a list that does nothing.
 */

/**
 * Two groups, because they answer different questions.
 *
 * The first is a fact about this service: paths it serves today, or has
 * committed to serving in `docs/design.md` §5. Claiming one of these is a
 * collision with the API surface.
 *
 * The second is a judgement call: words whose value comes from looking
 * official. None of them is a route, and none is planned to be — the reason
 * they are here is that a shortener that hands out `/security-update` has
 * handed out its own credibility along with it. The list is a starting point
 * rather than a boundary, and it is a plain Set so that adding a word is a
 * one-line change.
 */
const RESERVED_CODES = new Set([
  // API surface, current and committed (design §5).
  'health',
  'shorten',
  'analytics',
  'api',
  'metrics',
  'status',
  'admin',
  'docs',
  'static',
  'assets',
  'public',
  'www',

  // Words that borrow the service's voice.
  'about',
  'account',
  'accounts',
  'auth',
  'billing',
  'confirm',
  'contact',
  'dashboard',
  'download',
  'downloads',
  'help',
  'invoice',
  'legal',
  'login',
  'logout',
  'oauth',
  'password',
  'passwords',
  'payment',
  'payments',
  'privacy',
  'profile',
  'register',
  'reset',
  'security',
  'settings',
  'signin',
  'signup',
  'support',
  'terms',
  'unsubscribe',
  'update',
  'upgrade',
  'user',
  'users',
  'verify',
]);

/**
 * Whether `value` is a code the namespace holds back.
 *
 * Applied to generated codes as well as chosen ones, which costs a Set lookup
 * per write and closes a case that would otherwise be waiting for us. A
 * generated code is seven Base62 characters, and so is `shorten` — the odds are
 * one in 3.5 trillion, and the outcome would be a short link that shadows an
 * endpoint and cannot be deleted without breaking somebody's URL. The write
 * path treats a reserved code as an occupied one and re-hashes past it
 * (`shorten.ts`), so the case is gone rather than merely unlikely.
 *
 * Note what this cannot do: adding a word here does not unclaim an alias
 * already holding it. Reserving is a check at write time, not a constraint on
 * the table, and the row it would have prevented is a live link that somebody
 * has already shared. Reclaiming one is a takedown, deliberately — see
 * ADR 0010.
 */
export function isReservedCode(value: string): boolean {
  return RESERVED_CODES.has(value.toLowerCase());
}
