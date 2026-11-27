/**
 * Tests for the Institution Fixtures Command
 *
 * This suite deals with the command that writes the publisher, vocabulary
 * and repository records from a real database as fixture files. It checks
 * the arguments the command accepts and refuses, and runs the command
 * against a fake row reader to confirm that every query it sends is a
 * single SELECT, that the repository is looked up inside the named
 * federation only, and that the three files are written under the names
 * the downstream site expects. A compare run prints, for every repository
 * in the federation, the composed attribution line in each language beside
 * the stored override; the composed line carries the federation's hosting
 * statement, and a database without migration 0122's columns is said to
 * lack it rather than refused. The fixture run reads the hosting statement
 * the same way.
 *
 * @version v0.9.0
 */

import { describe, it, expect } from "vitest";
import {
  compareAttributions,
  exportInstitutionFixtures,
  parseArgs,
} from "../../scripts/commands/export-institution-fixtures";

describe("parseArgs", () => {
  const ok = ["--target", "production", "--federation", "neogranadina", "--repository", "co-ahr", "--out", "dir"];

  it("reads every argument", () => {
    expect(parseArgs(ok)).toEqual({ target: "production", federation: "neogranadina", repository: "co-ahr", outDir: "dir", compare: false });
  });

  it("needs only a target and federation with --compare", () => {
    expect(parseArgs(["--target", "production", "--federation", "neogranadina", "--compare"]))
      .toEqual({ target: "production", federation: "neogranadina", repository: "", outDir: "", compare: true });
    expect(() => parseArgs(["--federation", "neogranadina", "--compare"])).toThrow(/--target/);
    expect(() => parseArgs(["--target", "local", "--compare"])).toThrow(/--federation/);
  });

  it("refuses a missing or unknown target, a missing federation, repository or out, and unknown flags", () => {
    expect(() => parseArgs(ok.slice(2))).toThrow(/--target/);
    expect(() => parseArgs(["--target", "remote", ...ok.slice(2)])).toThrow(/--target/);
    expect(() => parseArgs(["--target", "local", "--repository", "co-ahr", "--out", "d"])).toThrow(/--federation/);
    expect(() => parseArgs(["--target", "local", "--federation", "f", "--out", "d"])).toThrow(/--repository/);
    expect(() => parseArgs(["--target", "local", "--federation", "f", "--repository", "r"])).toThrow(/--out/);
    expect(() => parseArgs([...ok, "--apply"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["--target"])).toThrow(/needs a value/);
  });
});

describe("exportInstitutionFixtures", () => {
  function fakeRows(sent: string[]) {
    return async (sql: string): Promise<Record<string, unknown>[]> => {
      sent.push(sql);
      if (/pragma_table_info\('federations'\)/.test(sql)) return [{ name: "hosting_statement_es" }, { name: "hosting_statement_en" }];
      if (/SELECT hosting_statement_es, hosting_statement_en FROM federations/.test(sql)) {
        return [{ hosting_statement_es: "Alojado en Zasqua (zasqua.org).", hosting_statement_en: null }];
      }
      if (/FROM federations/.test(sql)) {
        return [{
          id: "fed1", slug: "neogranadina", name: "Neogranadina", manifest_base_url: "https://m.example/",
          publisher_name: "Fundación", publisher_tax_id: null, publisher_location: null, publisher_url: null,
          publisher_email: null, publisher_logo_key: null,
          description_es: null, description_en: null, terms_of_use_es: null, terms_of_use_en: null,
          privacy_es: null, privacy_en: null, takedown_es: null, takedown_en: null,
          citation_template_site_es: null, citation_template_site_en: null,
          citation_template_record_es: null, citation_template_record_en: null,
        }];
      }
      if (/FROM federation_credits/.test(sql)) return [];
      if (/FROM vocabulary_values/.test(sql)) {
        return [{ list: "entity_type", code: "person", label_es: "Persona", label_en: "Person", group_code: null, position: 0, external_scheme: null, external_uri: null, external_label: null, status: "approved" }];
      }
      if (/FROM authority_sources/.test(sql)) return [];
      if (/FROM repositories/.test(sql)) {
        return [{
          id: "r1", code: "co-ahr", name: "Archivo", short_name: null, country_code: "COL", country: "Colombia",
          city: "Rionegro", address: null, website: null, display_title: null, subtitle: null, subtitle_en: null,
          hero_image_url: null, other_names: null, institution_type: null, logo_key: null, region: null,
          postal_code: null, telephone: null, email: null, holdings_es: null, holdings_en: null,
          history_es: null, history_en: null, opening_times_es: null, opening_times_en: null,
          access_conditions_es: null, access_conditions_en: null, accessibility_es: null, accessibility_en: null,
          reproduction_services_es: null, reproduction_services_en: null, manifest_rights: null,
          catalogue_licence_uri: null, attribution_es: null, attribution_en: null, description_language: null,
          credit_statement_es: "Digitalizado por X.", credit_statement_en: null, rights_text: null,
          home_order: 2, created_at: 0, updated_at: 0,
        }];
      }
      if (/FROM repository_funders/.test(sql)) return [];
      if (/FROM descriptions/.test(sql)) return [{ n: 42 }];
      throw new Error(`unexpected query: ${sql}`);
    };
  }

  it("sends only SELECTs, scopes the repository to the federation and writes three files", async () => {
    const sent: string[] = [];
    const files = new Map<string, string>();
    await exportInstitutionFixtures(
      { target: "local", federation: "neogranadina", repository: "co-ahr", outDir: "/out" },
      { rows: fakeRows(sent), writeFile: (p, t) => files.set(p, t) },
      () => {},
    );
    expect(sent.every((s) => /^\s*SELECT\b/i.test(s))).toBe(true);
    expect(sent.find((s) => /FROM repositories/.test(s))).toMatch(/federation_id/);
    expect([...files.keys()].sort()).toEqual(["/out/publisher.json", "/out/repository-co-ahr.json", "/out/vocabulary.json"]);
    const repoOut = JSON.parse(files.get("/out/repository-co-ahr.json")!);
    expect(repoOut.description_count).toBe(42);
    expect(repoOut.root_descriptions).toEqual([]);
    expect(repoOut.home_order).toBe(2);
    expect(repoOut.image_reproduction_text).toBe("");
    expect(repoOut.attribution).toEqual({
      es: "Archivo, Rionegro, Colombia. Digitalizado por X. Alojado en Zasqua (zasqua.org).",
      en: "Archivo, Rionegro, Colombia.",
    });
    expect(JSON.parse(files.get("/out/publisher.json")!).federation).toBe("neogranadina");
    expect(JSON.parse(files.get("/out/vocabulary.json")!).entity_types).toHaveLength(1);
  });

  it("stops when the federation or the repository is not found", async () => {
    const empty = async () => [];
    await expect(
      exportInstitutionFixtures(
        { target: "local", federation: "nope", repository: "co-ahr", outDir: "/out" },
        { rows: empty, writeFile: () => {} },
        () => {},
      ),
    ).rejects.toThrow(/federation/);
  });
});

describe("compareAttributions", () => {
  const row = (over: Record<string, unknown>) => ({
    code: "co-a", name: "Archivo A", city: "Tunja", region: "Boyacá", country: "Colombia",
    credit_statement_es: null, credit_statement_en: null, manifest_rights: null,
    attribution_es: null, attribution_en: null, home_order: null,
    ...over,
  });

  it("prints the composed line and the stored override for every repository of the federation, from SELECTs only", async () => {
    const sent: string[] = [];
    const lines: string[] = [];
    const rows = async (sql: string): Promise<Record<string, unknown>[]> => {
      sent.push(sql);
      if (/pragma_table_info\('federations'\)/.test(sql)) return [{ name: "id" }];
      if (/FROM federations/.test(sql)) return [{ id: "fed1", slug: "neogranadina" }];
      if (/FROM repositories/.test(sql)) {
        return [
          row({
            code: "co-a",
            credit_statement_es: "Digitalizado por X.",
            manifest_rights: "http://creativecommons.org/licenses/by-nc/4.0/",
            attribution_es: "Archivo A, Tunja, Boyacá, Colombia. Digitalizado por X. CC BY-NC 4.0.",
            attribution_en: "Old English line",
          }),
          row({ code: "co-b", name: "Archivo | B", city: null }),
        ];
      }
      throw new Error(`unexpected query: ${sql}`);
    };
    const result = await compareAttributions({ target: "local", federation: "neogranadina" }, { rows }, (l) => lines.push(l));
    expect(sent.every((s) => /^\s*SELECT\b/i.test(s))).toBe(true);
    expect(sent.find((s) => /FROM repositories/.test(s))).toMatch(/federation_id/);
    expect(result).toEqual([
      { code: "co-a", lang: "es", composed: "Archivo A, Tunja, Boyacá, Colombia. Digitalizado por X. CC BY-NC 4.0.", override: "Archivo A, Tunja, Boyacá, Colombia. Digitalizado por X. CC BY-NC 4.0.", same: true },
      { code: "co-a", lang: "en", composed: "Archivo A, Tunja, Boyacá, Colombia. CC BY-NC 4.0.", override: "Old English line", same: false },
      { code: "co-b", lang: "es", composed: "Archivo | B, Boyacá, Colombia.", override: null, same: false },
      { code: "co-b", lang: "en", composed: "Archivo | B, Boyacá, Colombia.", override: null, same: false },
    ]);
    const table = lines.join("\n");
    expect(table).toMatch(/^\| Repository \| Lang \| Composed \| Stored override \| Same \|/m);
    expect(table).toContain("Archivo \\| B");
    expect(table).toContain("| co-a | en | Archivo A, Tunja, Boyacá, Colombia. CC BY-NC 4.0. | Old English line | no |");
  });

  it("reads the country code, so the English line names the country in English", async () => {
    const sent: string[] = [];
    const rows = async (sql: string): Promise<Record<string, unknown>[]> => {
      sent.push(sql);
      if (/pragma_table_info\('federations'\)/.test(sql)) return [{ name: "id" }];
      if (/FROM federations/.test(sql)) return [{ id: "fed1", slug: "neogranadina" }];
      if (/FROM repositories/.test(sql)) {
        return /country_code/.test(sql)
          ? [row({ code: "pe-a", name: "Archivo P", city: "Lima", region: null, country: "Perú", country_code: "PER" })]
          : [row({ code: "pe-a", name: "Archivo P", city: "Lima", region: null, country: "Perú" })];
      }
      throw new Error(`unexpected query: ${sql}`);
    };
    const result = await compareAttributions({ target: "local", federation: "neogranadina" }, { rows }, () => {});
    expect(result.map((c) => [c.lang, c.composed])).toEqual([
      ["es", "Archivo P, Lima, Perú."],
      ["en", "Archivo P, Lima, Peru."],
    ]);
  });

  it("says the hosting statement is absent when the database lacks migration 0122's columns", async () => {
    const lines: string[] = [];
    const rows = async (sql: string): Promise<Record<string, unknown>[]> => {
      if (/pragma_table_info\('federations'\)/.test(sql)) return [{ name: "id" }];
      if (/hosting_statement/.test(sql)) throw new Error("no such column: hosting_statement_es");
      if (/FROM federations/.test(sql)) return [{ id: "fed1", slug: "neogranadina" }];
      if (/FROM repositories/.test(sql)) return [row({})];
      throw new Error(`unexpected query: ${sql}`);
    };
    await compareAttributions({ target: "local", federation: "neogranadina" }, { rows }, (l) => lines.push(l));
    expect(lines.join("\n")).toMatch(/hosting_statement_es.*0122.*not applied/);
  });

  it("shows the federation's hosting statement in the composed column", async () => {
    const sent: string[] = [];
    const lines: string[] = [];
    const rows = async (sql: string): Promise<Record<string, unknown>[]> => {
      sent.push(sql);
      if (/pragma_table_info\('federations'\)/.test(sql)) return [{ name: "hosting_statement_es" }, { name: "hosting_statement_en" }];
      if (/SELECT hosting_statement_es, hosting_statement_en FROM federations/.test(sql)) {
        return [{ hosting_statement_es: "Alojado en Zasqua (zasqua.org).", hosting_statement_en: "Hosted on Zasqua (zasqua.org)." }];
      }
      if (/FROM federations/.test(sql)) return [{ id: "fed1", slug: "neogranadina" }];
      if (/FROM repositories/.test(sql)) {
        return [row({ credit_statement_es: "Digitalizado por X.", manifest_rights: "http://creativecommons.org/licenses/by-nc/4.0/" })];
      }
      throw new Error(`unexpected query: ${sql}`);
    };
    const result = await compareAttributions({ target: "local", federation: "neogranadina" }, { rows }, (l) => lines.push(l));
    expect(sent.every((s) => /^\s*SELECT\b/i.test(s))).toBe(true);
    expect(sent.find((s) => /hosting_statement_es, hosting_statement_en FROM federations/.test(s))).toMatch(/id = 'fed1'/);
    expect(result.map((c) => c.composed)).toEqual([
      "Archivo A, Tunja, Boyacá, Colombia. Digitalizado por X. Alojado en Zasqua (zasqua.org). CC BY-NC 4.0.",
      "Archivo A, Tunja, Boyacá, Colombia. Hosted on Zasqua (zasqua.org). CC BY-NC 4.0.",
    ]);
    expect(lines.join("\n")).toContain("| co-a | en | Archivo A, Tunja, Boyacá, Colombia. Hosted on Zasqua (zasqua.org). CC BY-NC 4.0. | (none) | no override |");
  });
});

// @version v0.9.0
