/**
 * Service-Busy Marker
 *
 * This module holds the body `serviceBusyMiddleware`
 * (`app/middleware/service-busy.ts`) answers a client navigation or
 * fetcher with when D1's overload fails the request, and the test the
 * root `ErrorBoundary` (`app/root.tsx`) uses to recognise it. The client
 * router turns a 4xx or 5xx single-fetch response that lacks its
 * `X-Remix-Response` header into an `ErrorResponse` whose `data` is the
 * response body as text; the status text is not used, since HTTP/2
 * carries none. A 503 whose data is exactly the marker is the busy
 * answer; any other 503 is not.
 *
 * It has no dependency, so the root route can import it into the
 * browser bundle.
 *
 * @version v0.9.0
 */

/** The body of the busy answer to a single-fetch request. */
export const SERVICE_BUSY_MARKER = "fisqua:service-busy";

/** True when `error` is the ErrorResponse the client router builds from the busy answer. */
export function isServiceBusyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { status?: unknown; data?: unknown };
  return e.status === 503 && e.data === SERVICE_BUSY_MARKER;
}

// @version v0.9.0
