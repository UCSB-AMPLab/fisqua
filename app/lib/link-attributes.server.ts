/**
 * Link attributes — reading and writing `description_entities.attributes`
 *
 * This module deals with reading and writing
 * `description_entities.attributes`. A link from a person to a description
 * carries the attributes the document gives that person there, as a JSON
 * object from a key of the federation's `link_attribute` vocabulary to the
 * value as written (migration 0125, which moves the link's `function`
 * column into it as the `office` attribute). The description editor, the
 * authority page, the exports and the command line read and write the
 * office under the one name `function`, through the helpers here.
 *
 * Three shapes are needed. On a query, `officeSql` reads the office out
 * of the stored object in SQL, so a select keeps returning one text
 * value. On an insert, `attributesJson` builds the object to store. On
 * an update, `withOfficeSql` sets or removes `office` inside the stored
 * object with `json_set`/`json_remove`, so any other attribute a link
 * carries is left as it is. For rows already read into memory,
 * `officeOf` and `withOffice` do the same in JavaScript.
 *
 * An office that is null or empty is not stored: the object then has
 * no `office` key, and a read gives null.
 *
 * @version v0.9.0
 */
import { sql, type SQL } from "drizzle-orm";
import { descriptionEntities } from "../db/schema";

/** The attribute key the former `function` column became. */
export const OFFICE = "office";

type Attributes = Record<string, unknown>;

function parse(stored: string | null | undefined): Attributes {
  if (stored === null || stored === undefined || stored === "") return {};
  try {
    const value: unknown = JSON.parse(stored);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Attributes) : {};
  } catch {
    return {};
  }
}

const present = (office: string | null | undefined): office is string =>
  office !== null && office !== undefined && office !== "";

/** The office in a stored attributes object, or null. */
export function officeOf(stored: string | null | undefined): string | null {
  const office = parse(stored)[OFFICE];
  return typeof office === "string" ? office : null;
}

/** The attributes object to store for a new link with this office. */
export function attributesJson(office: string | null | undefined): string {
  return JSON.stringify(present(office) ? { [OFFICE]: office } : {});
}

/** A stored attributes object with its office set, or removed when null or empty. */
export function withOffice(stored: string | null | undefined, office: string | null | undefined): string {
  const { [OFFICE]: _old, ...rest } = parse(stored);
  return JSON.stringify(present(office) ? { ...rest, [OFFICE]: office } : rest);
}

/** The link's office, read in SQL from `description_entities.attributes`. */
export const officeSql = (column: unknown = descriptionEntities.attributes): SQL<string | null> =>
  sql<string | null>`json_extract(${column}, '$.office')`;

/** The value an UPDATE sets `attributes` to: the stored object with its office set or removed. */
export function withOfficeSql(office: string | null | undefined): SQL<string> {
  return present(office)
    ? sql<string>`json_set(${descriptionEntities.attributes}, '$.office', ${office})`
    : sql<string>`json_remove(${descriptionEntities.attributes}, '$.office')`;
}

// @version v0.9.0
