/**
 * API Error Tokens
 *
 * Maps the HTTP status of a caught guard `Response` to a stable error
 * token for JSON API responses. The constraint: client code receives
 * stable tokens ("forbidden", "not_found", ...), never server prose —
 * the render boundary translates each token through i18n, so no
 * English sentence assembled on the server can reach the UI. The
 * `api.*` resource routes use this in the catch blocks that previously
 * forwarded `await err.text()` bodies verbatim.
 *
 * @version v0.7.0
 */

export function apiErrorToken(status: number): string {
  switch (status) {
    case 400:
      return "invalid";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 410:
      return "gone";
    default:
      return "generic";
  }
}
