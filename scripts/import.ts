#!/usr/bin/env npx tsx
/**
 * Bulk Import CLI
 *
 * The entry point for loading the archival data layer into D1 from the
 * JSON dumps produced by the Django-to-Fisqua migration. Takes a
 * command name (`repositories`, `entities`, `places`, `descriptions`,
 * `description-entities`, `description-places`, `clear`, `fts-rebuild`,
 * or `all`) and an input directory, reads the matching JSON file, runs
 * any required parent tables first to resolve foreign keys, and emits
 * SQL that the caller pipes through `wrangler d1 execute --file`.
 *
 * This runs outside the Worker -- plain Node via `tsx` -- because a
 * bulk import of several hundred thousand rows is too heavy for a
 * Worker request even with Cloudflare Workflows behind it. The
 * companion `scripts/lib/` modules handle the id-mapping, SQL
 * generation, and field transformation that each command shares.
 *
 * Usage:
 *   npx tsx scripts/import.ts <command> [--input-dir <path>]
 *
 * Version: v0.3.0
 */

import * as path from "node:path";
import type { ImportResult } from "./lib/types";
import { importRepositories } from "./commands/repositories";
import { importEntities } from "./commands/entities";
import { importPlaces } from "./commands/places";
import { importEntityFunctions } from "./commands/entity-functions";
import { importDescriptions } from "./commands/descriptions";
import {
  importDescriptionEntities,
  importDescriptionPlaces,
} from "./commands/junctions";
import { generateClearSql, generateFtsRebuild } from "./commands/clear";

const DEFAULT_INPUT_DIR = "./export_catalogacion/";

function printUsage() {
  console.log(`Usage: tsx scripts/import.ts <command> [--input-dir <path>]

Commands:
  repositories          Import repositories from JSON
  entities              Import entities from JSON
  places                Import places from JSON
  entity-functions      Import entity functions from JSON (runs entities first for FK resolution)
  descriptions          Import descriptions from JSON (runs repositories first for FK resolution)
  description-entities  Import description-entity junctions from JSON
  description-places    Import description-place junctions from JSON
  clear                 Generate SQL to clear all data (reverse FK order)
  fts-rebuild           Generate SQL to rebuild FTS5 indexes
  all                   Import all tables in dependency order

Options:
  --input-dir <path>  Directory containing JSON export files (default: ${DEFAULT_INPUT_DIR})
`);
}

function printResult(result: ImportResult) {
  console.log(`\n[${result.table}] Import complete:`);
  console.log(`  Total: ${result.total}`);
  console.log(`  Imported: ${result.imported}`);
  console.log(`  Skipped: ${result.skipped}`);
  console.log(`  Errors: ${result.errors.length}`);
  console.log(`  SQL files: ${result.sqlFiles.join(", ")}`);

  if (result.errors.length > 0) {
    const showCount = Math.min(result.errors.length, 10);
    console.log(`\n  First ${showCount} errors:`);
    for (let i = 0; i < showCount; i++) {
      const err = result.errors[i];
      console.log(
        `    Row ${err.row} (oldId=${err.oldId}): ${err.errors.join("; ")}`
      );
    }
    if (result.errors.length > 10) {
      console.log(`    ... and ${result.errors.length - 10} more errors`);
    }
  }
}

function parseArgs(argv: string[]): { command: string; inputDir: string } {
  const args = argv.slice(2);
  let command = "";
  let inputDir = DEFAULT_INPUT_DIR;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input-dir" && i + 1 < args.length) {
      inputDir = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      command = "help";
    } else if (!args[i].startsWith("-")) {
      command = args[i];
    }
  }

  return { command, inputDir };
}

async function main() {
  const { command, inputDir } = parseArgs(process.argv);
  let hasErrors = false;

  switch (command) {
    case "repositories": {
      const { result } = await importRepositories(
        path.join(inputDir, "repositories.json")
      );
      printResult(result);
      if (result.errors.length > 0) hasErrors = true;
      break;
    }

    case "entities": {
      const { result } = await importEntities(
        path.join(inputDir, "entities.json")
      );
      printResult(result);
      if (result.errors.length > 0) hasErrors = true;
      break;
    }

    case "places": {
      const { result } = await importPlaces(
        path.join(inputDir, "places.json")
      );
      printResult(result);
      if (result.errors.length > 0) hasErrors = true;
      break;
    }

    case "entity-functions": {
      // Entity functions require entity IdMap for FK resolution.
      console.log("Running entities import first for FK resolution...");
      const { result: entityResult, idMap: entityIdMap } = await importEntities(
        path.join(inputDir, "entities.json")
      );
      printResult(entityResult);
      if (entityResult.errors.length > 0) hasErrors = true;

      const efResult = await importEntityFunctions(
        path.join(inputDir, "entity_functions.json"),
        entityIdMap
      );
      printResult(efResult);
      if (efResult.errors.length > 0) hasErrors = true;
      break;
    }

    case "descriptions": {
      // Descriptions require repository IdMap for FK resolution.
      console.log("Running repositories import first for FK resolution...");
      const { result: repoResult, idMap: repoIdMap } =
        await importRepositories(path.join(inputDir, "repositories.json"));
      printResult(repoResult);
      if (repoResult.errors.length > 0) hasErrors = true;

      const { result: descResult } = await importDescriptions(
        path.join(inputDir, "descriptions.json"),
        repoIdMap
      );
      printResult(descResult);
      if (descResult.errors.length > 0) hasErrors = true;
      break;
    }

    case "description-entities": {
      // Needs entity + description IdMaps.
      console.log("Running prerequisite imports for FK resolution...");
      const { result: repoResult, idMap: repoIdMap } =
        await importRepositories(path.join(inputDir, "repositories.json"));
      printResult(repoResult);
      if (repoResult.errors.length > 0) hasErrors = true;

      const { result: entityResult, idMap: entityIdMap } = await importEntities(
        path.join(inputDir, "entities.json")
      );
      printResult(entityResult);
      if (entityResult.errors.length > 0) hasErrors = true;

      const { result: descResult, idMap: descIdMap } =
        await importDescriptions(
          path.join(inputDir, "descriptions.json"),
          repoIdMap
        );
      printResult(descResult);
      if (descResult.errors.length > 0) hasErrors = true;

      const deResult = await importDescriptionEntities(
        path.join(inputDir, "description_entities.json"),
        descIdMap,
        entityIdMap
      );
      printResult(deResult);
      if (deResult.errors.length > 0) hasErrors = true;
      break;
    }

    case "description-places": {
      // Needs place + description IdMaps.
      console.log("Running prerequisite imports for FK resolution...");
      const { result: repoResult, idMap: repoIdMap } =
        await importRepositories(path.join(inputDir, "repositories.json"));
      printResult(repoResult);
      if (repoResult.errors.length > 0) hasErrors = true;

      const { result: placeResult, idMap: placeIdMap } = await importPlaces(
        path.join(inputDir, "places.json")
      );
      printResult(placeResult);
      if (placeResult.errors.length > 0) hasErrors = true;

      const { result: descResult, idMap: descIdMap } =
        await importDescriptions(
          path.join(inputDir, "descriptions.json"),
          repoIdMap
        );
      printResult(descResult);
      if (descResult.errors.length > 0) hasErrors = true;

      const dpResult = await importDescriptionPlaces(
        path.join(inputDir, "description_places.json"),
        descIdMap,
        placeIdMap
      );
      printResult(dpResult);
      if (dpResult.errors.length > 0) hasErrors = true;
      break;
    }

    case "clear": {
      const sqlFiles = await generateClearSql();
      console.log(`\n[clear] Generated: ${sqlFiles.join(", ")}`);
      break;
    }

    case "fts-rebuild": {
      const sqlFiles = await generateFtsRebuild();
      console.log(`\n[fts-rebuild] Generated: ${sqlFiles.join(", ")}`);
      break;
    }

    case "all": {
      console.log("=== Import All: Full pipeline in FK dependency order ===\n");

      const allSqlFiles: string[] = [];

      // Step 1: Generate clear SQL
      console.log("Step 1/9: Generating clear SQL...");
      const clearFiles = await generateClearSql();
      allSqlFiles.push(...clearFiles);
      console.log(`  Generated: ${clearFiles.join(", ")}`);

      // Step 2: Import repositories
      console.log("\nStep 2/9: Importing repositories...");
      const { result: repoResult, idMap: repoIdMap } =
        await importRepositories(path.join(inputDir, "repositories.json"));
      printResult(repoResult);
      allSqlFiles.push(...repoResult.sqlFiles);
      if (repoResult.errors.length > 0) hasErrors = true;

      // Step 3: Import entities
      console.log("\nStep 3/9: Importing entities...");
      const { result: entityResult, idMap: entityIdMap } = await importEntities(
        path.join(inputDir, "entities.json")
      );
      printResult(entityResult);
      allSqlFiles.push(...entityResult.sqlFiles);
      if (entityResult.errors.length > 0) hasErrors = true;

      // Step 4: Import places
      console.log("\nStep 4/9: Importing places...");
      const { result: placeResult, idMap: placeIdMap } = await importPlaces(
        path.join(inputDir, "places.json")
      );
      printResult(placeResult);
      allSqlFiles.push(...placeResult.sqlFiles);
      if (placeResult.errors.length > 0) hasErrors = true;

      // Step 5: Import entity functions (needs entity IdMap)
      console.log("\nStep 5/9: Importing entity functions...");
      const efResult = await importEntityFunctions(
        path.join(inputDir, "entity_functions.json"),
        entityIdMap
      );
      printResult(efResult);
      allSqlFiles.push(...efResult.sqlFiles);
      if (efResult.errors.length > 0) hasErrors = true;

      // Step 6: Import descriptions (needs repository IdMap)
      console.log("\nStep 6/9: Importing descriptions...");
      const { result: descResult, idMap: descIdMap } =
        await importDescriptions(
          path.join(inputDir, "descriptions.json"),
          repoIdMap
        );
      printResult(descResult);
      allSqlFiles.push(...descResult.sqlFiles);
      if (descResult.errors.length > 0) hasErrors = true;

      // Step 7: Import description-entities (needs description + entity IdMaps)
      console.log("\nStep 7/9: Importing description-entities...");
      const deResult = await importDescriptionEntities(
        path.join(inputDir, "description_entities.json"),
        descIdMap,
        entityIdMap
      );
      printResult(deResult);
      allSqlFiles.push(...deResult.sqlFiles);
      if (deResult.errors.length > 0) hasErrors = true;

      // Step 8: Import description-places (needs description + place IdMaps)
      console.log("\nStep 8/9: Importing description-places...");
      const dpResult = await importDescriptionPlaces(
        path.join(inputDir, "description_places.json"),
        descIdMap,
        placeIdMap
      );
      printResult(dpResult);
      allSqlFiles.push(...dpResult.sqlFiles);
      if (dpResult.errors.length > 0) hasErrors = true;

      // Step 9: Generate FTS rebuild SQL
      console.log("\nStep 9/9: Generating FTS rebuild SQL...");
      const ftsFiles = await generateFtsRebuild();
      allSqlFiles.push(...ftsFiles);
      console.log(`  Generated: ${ftsFiles.join(", ")}`);

      // Print wrangler execution instructions
      console.log("\n=== Wrangler Execution Instructions ===\n");
      console.log(
        "Run each SQL file in order against your D1 database:\n"
      );
      for (const file of allSqlFiles) {
        console.log(`  wrangler d1 execute zasqua-catalogacion --remote --file=${file}`);
      }
      console.log(
        "\nAdd --local instead of --remote to test against local D1 first."
      );
      break;
    }

    case "help":
    case "":
      printUsage();
      break;

    default:
      console.error(`Unknown command: ${command}\n`);
      printUsage();
      process.exit(1);
  }

  if (hasErrors) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
