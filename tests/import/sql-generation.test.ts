/**
 * Tests — sql generation
 *
 * @version v0.3.0
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { escapeSql, generateInserts, writeSqlFiles } from "../../scripts/lib/sql";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("escapeSql", () => {
  it("returns NULL for null", () => {
    expect(escapeSql(null)).toBe("NULL");
  });

  it("returns NULL for undefined", () => {
    expect(escapeSql(undefined)).toBe("NULL");
  });

  it("escapes single quotes by doubling them", () => {
    expect(escapeSql("it's a test")).toBe("'it''s a test'");
  });

  it("wraps plain strings in single quotes", () => {
    expect(escapeSql("hello")).toBe("'hello'");
  });

  it("returns numbers as-is", () => {
    expect(escapeSql(42)).toBe("42");
    expect(escapeSql(0)).toBe("0");
    expect(escapeSql(-3.14)).toBe("-3.14");
  });

  it("converts booleans to 1/0", () => {
    expect(escapeSql(true)).toBe("1");
    expect(escapeSql(false)).toBe("0");
  });

  it("preserves newlines inside SQL string literals", () => {
    expect(escapeSql("line1\nline2")).toBe("'line1\nline2'");
  });

  it("handles empty string", () => {
    expect(escapeSql("")).toBe("''");
  });

  it("handles string with multiple single quotes", () => {
    expect(escapeSql("it's John's")).toBe("'it''s John''s'");
  });
});

describe("generateInserts", () => {
  it("produces one INSERT with multiple value rows when within batch size", () => {
    const result = generateInserts(
      "entities",
      ["id", "name"],
      [["'uuid1'", "'Alice'"], ["'uuid2'", "'Bob'"]],
      2
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("INSERT INTO entities (id, name) VALUES");
    expect(result[0]).toContain("('uuid1', 'Alice')");
    expect(result[0]).toContain("('uuid2', 'Bob')");
    expect(result[0]).toMatch(/;\s*$/);
  });

  it("splits rows into multiple INSERT statements at batch boundary", () => {
    const result = generateInserts(
      "entities",
      ["id", "name"],
      [["'uuid1'", "'Alice'"], ["'uuid2'", "'Bob'"], ["'uuid3'", "'Carol'"]],
      1
    );
    expect(result).toHaveLength(3);
    result.forEach((stmt) => {
      expect(stmt).toContain("INSERT INTO entities");
      expect(stmt).toMatch(/;\s*$/);
    });
  });

  it("handles batch size of 2 with 3 rows", () => {
    const result = generateInserts(
      "test",
      ["a", "b"],
      [["1", "'x'"], ["2", "'y'"], ["3", "'z'"]],
      2
    );
    expect(result).toHaveLength(2);
    // First batch has 2 rows, second has 1
    expect(result[0]).toContain("(1, 'x')");
    expect(result[0]).toContain("(2, 'y')");
    expect(result[1]).toContain("(3, 'z')");
  });
});

describe("writeSqlFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "import-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates files with PRAGMA header and sequential naming", async () => {
    const statements = [
      "INSERT INTO test (a) VALUES (1);",
      "INSERT INTO test (a) VALUES (2);",
    ];
    const files = await writeSqlFiles("test", statements, 2, tmpDir);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/test-001\.sql$/);

    const content = await fs.readFile(files[0], "utf8");
    expect(content).toContain("PRAGMA defer_foreign_keys = true;");
    expect(content).toContain("INSERT INTO test (a) VALUES (1);");
    expect(content).toContain("INSERT INTO test (a) VALUES (2);");
  });

  it("splits statements across multiple files", async () => {
    const statements = [
      "INSERT INTO test (a) VALUES (1);",
      "INSERT INTO test (a) VALUES (2);",
      "INSERT INTO test (a) VALUES (3);",
    ];
    const files = await writeSqlFiles("test", statements, 2, tmpDir);

    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/test-001\.sql$/);
    expect(files[1]).toMatch(/test-002\.sql$/);

    const content1 = await fs.readFile(files[0], "utf8");
    expect(content1).toContain("PRAGMA defer_foreign_keys = true;");
    expect(content1).toContain("INSERT INTO test (a) VALUES (1);");
    expect(content1).toContain("INSERT INTO test (a) VALUES (2);");

    const content2 = await fs.readFile(files[1], "utf8");
    expect(content2).toContain("PRAGMA defer_foreign_keys = true;");
    expect(content2).toContain("INSERT INTO test (a) VALUES (3);");
  });
});
