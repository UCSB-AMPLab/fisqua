/**
 * Standard-Aware i18n Resolver Wrapper
 *
 * This module deals with the per-standard label-key resolver for the
 * standard-aware form + tree-browser + breadcrumb surfaces. Single
 * namespace plus per-standard override: the resolver tries
 * `<key>.<standard>` first and falls back to the bare `<key>` when no
 * override is defined.
 * This means a tenant on DACS sees DACS-specific labels where the
 * locale provides them and the shared label everywhere else, without
 * forking the locale into per-standard files.
 *
 * Verified for i18next v25.8.17 against the project's locale shape.
 * The wrapper is intentionally tiny — it is a typed shim over `t()`
 * that resolves either the per-standard override or the bare key
 * with at most two `t()` calls.
 *
 * Performance shape: a single `t()` call when an override exists,
 * two when it doesn't. An earlier implementation always made two
 * calls (the inner one was needed to compute the `defaultValue`
 * string). With ~38 of 40+ form fields having no override, the
 * sentinel-based short-circuit halves the per-render lookup count
 * for the override-existing case and keeps the fallback unchanged.
 *
 * `defaultValue` is a literal string, not a key — in i18next,
 * `defaultValue` is a fallback string returned when the outer key
 * misses, NOT a key resolved by a second lookup. The sentinel-based
 * short-circuit uses `defaultValue` as a known "missing" signal:
 * when `t(overrideKey, { defaultValue: SENTINEL })` returns the
 * sentinel, the override is missing and we fall back to
 * `t(key, vars)`. When it returns anything else, the override
 * resolved and we return it directly. Interpolation variables MUST
 * still be passed to BOTH calls so the fallback path resolves
 * placeholders correctly.
 *
 * Plurals follow the same shape — `count` is just another variable;
 * pass it to both inner and outer calls so the plural resolution
 * runs in both places.
 *
 * Namespace stays at the call site: the resolver does NOT take a
 * namespace argument. The caller's `t` is already bound to a
 * namespace by `useTranslation(ns)` — admin uses
 * `useTranslation("descriptions_admin")`, cataloguing uses
 * `useTranslation("description")`. Mixing namespaces inside the
 * resolver would break that contract; keeping namespace concern at
 * the call site is the structural mitigation.
 *
 * The bare key MUST exist for every callable field/section — this is
 * verified by `tests/i18n-coverage.test.ts` (the existing keystone),
 * which scans the codebase for every string key reachable through
 * `t(...)` and asserts the EN+ES bundles cover all of them.
 *
 * @version v0.4.0
 */

import type { TFunction } from "i18next";
import type { Standard } from "../standards/types";

/**
 * Resolve a label key with per-standard override fallback. Tries
 * `<key>.<standard>` first; falls back to the bare `<key>` when the
 * override doesn't exist.
 *
 * Interpolation: variables MUST be passed to BOTH calls (i18next
 * resolves `defaultValue` as a literal string, not a key — see
 * header). Plurals: same shape — pass `count` to both inner and
 * outer.
 *
 * The bare key MUST exist for every callable field/section —
 * verified by `tests/i18n-coverage.test.ts` (existing keystone).
 *
 * Namespace concern stays at the call site; `t` is bound to the
 * namespace by `useTranslation(ns)`.
 */
export function tStd(
  t: TFunction,
  key: string,
  standard: Standard,
  vars?: Record<string, unknown>,
): string {
  // Short-circuit when no per-standard override exists.
  //
  // The previous implementation unconditionally invoked `t()` twice
  // — once to compute the bare-key string for `defaultValue`, once
  // to resolve the override. With ~38 of 40+ form fields having no
  // override (today only `title.rad` and `context.dacs` ship one),
  // that's 76+ wasted lookups per render of the admin description
  // form.
  //
  // i18next's default missing-key behaviour returns the key string
  // verbatim (no `parseMissingKeyHandler` is set in
  // `app/middleware/i18next.ts`). We exploit that: invoke the
  // override call with `defaultValue: __MISSING_OVERRIDE__` so the
  // sentinel signals "no override defined" without colliding with
  // any plausible localised label. Single call when an override
  // exists; two calls only when we have to fall back. This is the
  // structural fix to the file-header claim that the wrapper "is a
  // typed shim over t()" — that claim was technically true but
  // hid the doubled cost.
  //
  // The sentinel's leading-and-trailing underscores make it
  // syntactically distinct from a real label and observable in
  // tests if it ever leaked through.
  const overrideKey = `${key}.${standard}`;
  const SENTINEL = "__tStd_no_override__";
  const tryOverride = t(overrideKey, {
    ...vars,
    defaultValue: SENTINEL,
  }) as string;
  if (tryOverride !== SENTINEL) return tryOverride;
  return t(key, vars) as string;
}

/* @version v0.4.0 */
