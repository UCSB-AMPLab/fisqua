/**
 * Scripts — the export's check on every statement
 *
 * This module deals with the check the export makes on every statement
 * before it sends it. Every statement the export sends to D1 passes
 * `assertSelectOnly` first, and a statement it refuses is never sent. The
 * export reads a fonds one table at a time and joins and counts locally,
 * so the check allows only the shape of statement it builds:
 *
 *   - exactly one statement: no `;` outside a string literal, not even
 *     a trailing one, and no comment;
 *   - it begins with SELECT, and SELECT appears once (no subquery);
 *   - it reads one table: a single FROM, followed by the table's name
 *     and then WHERE, ORDER BY, LIMIT or the end (no comma join);
 *   - none of the words JOIN, LIKE, GLOB, COUNT, GROUP BY, HAVING,
 *     UNION, INTERSECT, EXCEPT or WITH, nor any word that writes,
 *     matched on word boundaries without regard to case.
 *
 * String literals are set aside before the words are matched, so a
 * reference code or a name holding one of those words is read as data;
 * an unterminated literal is refused. A double-quoted identifier is
 * refused too: the export never writes one. The read classifier of
 * `../d1-cli.ts` (`isReadOnlySql`) is applied as well, so anything it
 * counts as a write is refused even if the rules above missed it.
 *
 * @version v0.9.0
 */

import { isReadOnlySql } from "../d1-cli";

export class SelectRefusal extends Error {
  constructor(message: string, readonly sql: string) {
    super(`${message}; nothing was sent. Statement: ${sql.slice(0, 300)}`);
    this.name = "SelectRefusal";
  }
}

const FORBIDDEN =
  /\b(JOIN|LIKE|GLOB|MATCH|REGEXP|COUNT|GROUP\s+BY|HAVING|UNION|INTERSECT|EXCEPT|WITH|INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/** The statement with every string literal replaced by `?`, or null when a literal is never closed. */
function withoutLiterals(sql: string): string | null {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c !== "'") {
      out += c;
      i++;
      continue;
    }
    let j = i + 1;
    for (;;) {
      const end = sql.indexOf("'", j);
      if (end === -1) return null;
      // A doubled quote inside a literal is an escaped quote.
      if (sql[end + 1] === "'") {
        j = end + 2;
        continue;
      }
      i = end + 1;
      break;
    }
    out += "?";
  }
  return out;
}

/** Throws `SelectRefusal` unless `sql` is one SELECT of one table, without joins, subqueries, LIKE, COUNT or GROUP BY. */
export function assertSelectOnly(sql: string): void {
  const bare = withoutLiterals(sql);
  if (bare === null) throw new SelectRefusal("An unterminated string literal", sql);
  const text = bare.trim();
  if (text.includes(";")) throw new SelectRefusal("More than one statement, or a semicolon", sql);
  if (/--|\/\*/.test(text)) throw new SelectRefusal("A comment", sql);
  if (/["`[\]]/.test(text)) throw new SelectRefusal("A quoted identifier", sql);
  if (!/^SELECT\b/i.test(text)) throw new SelectRefusal("Not a SELECT", sql);
  if ((text.match(/\bSELECT\b/gi) ?? []).length !== 1) throw new SelectRefusal("A subquery", sql);
  const forbidden = FORBIDDEN.exec(text);
  if (forbidden) throw new SelectRefusal(`The word ${forbidden[1].toUpperCase().replace(/\s+/g, " ")}`, sql);
  if ((text.match(/\bFROM\b/gi) ?? []).length !== 1) throw new SelectRefusal("Not exactly one FROM", sql);
  if (!/\bFROM\s+[A-Za-z_][A-Za-z0-9_]*\s*(?:$|\b(?:WHERE|ORDER\s+BY|LIMIT)\b)/i.test(text)) {
    throw new SelectRefusal("Not a single table after FROM", sql);
  }
  if (!isReadOnlySql(sql)) throw new SelectRefusal("Not a read", sql);
}

// @version v0.9.0
