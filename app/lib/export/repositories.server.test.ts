/**
 * Tests for Repository Formatter
 *
 * @version v0.3.0
 */

import { describe, it, expect } from "vitest";
import { formatRepositories } from "./repositories.server";
import type { ExportDescription } from "./types";

describe("formatRepositories", () => {
  const emptyRoots: ExportDescription[] = [];
  const emptyCounts = new Map<string, number>();

  it("uses rightsText from repo row when present", () => {
    const repos = [
      {
        id: "r1",
        code: "co-ahr",
        name: "Archivo Historico de Rionegro",
        shortName: "AHR",
        countryCode: "COL",
        country: "Colombia",
        city: "Rionegro",
        address: null,
        website: null,
        rightsText: "Custom rights text for AHR",
        displayTitle: null,
        subtitle: null,
        heroImageUrl: null,
      },
    ];

    const result = formatRepositories(repos, emptyCounts, emptyRoots);
    expect(result[0].image_reproduction_text).toBe(
      "Custom rights text for AHR"
    );
  });

  it("returns empty string for image_reproduction_text when rightsText is null", () => {
    const repos = [
      {
        id: "r2",
        code: "pe-bn",
        name: "Biblioteca Nacional del Peru",
        shortName: "BNP",
        countryCode: "PER",
        country: "Peru",
        city: "Lima",
        address: null,
        website: null,
        rightsText: null,
        displayTitle: null,
        subtitle: null,
        heroImageUrl: null,
      },
    ];

    const result = formatRepositories(repos, emptyCounts, emptyRoots);
    expect(result[0].image_reproduction_text).toBe("");
  });

  it("imageReproductionText function is removed (no longer exported)", async () => {
    const mod = await import("./repositories.server");
    expect("imageReproductionText" in mod).toBe(false);
  });

  it("includes display_title, subtitle, hero_image_url when present", () => {
    const repos = [
      {
        id: "r1",
        code: "co-ahr",
        name: "Archivo Historico de Rionegro",
        shortName: "AHR",
        countryCode: "COL",
        country: "Colombia",
        city: "Rionegro",
        address: null,
        website: null,
        rightsText: null,
        displayTitle: "Archivo Histórico de Rionegro",
        subtitle: "Fondo Notarial",
        heroImageUrl: "https://r2.zasqua.org/hero/ahr.jpg",
      },
    ];

    const result = formatRepositories(repos, emptyCounts, emptyRoots);
    expect(result[0].display_title).toBe("Archivo Histórico de Rionegro");
    expect(result[0].subtitle).toBe("Fondo Notarial");
    expect(result[0].hero_image_url).toBe("https://r2.zasqua.org/hero/ahr.jpg");
  });

  it("returns null for display_title, subtitle, hero_image_url when not set", () => {
    const repos = [
      {
        id: "r2",
        code: "pe-bn",
        name: "Biblioteca Nacional del Peru",
        shortName: "BNP",
        countryCode: "PER",
        country: "Peru",
        city: "Lima",
        address: null,
        website: null,
        rightsText: null,
        displayTitle: null,
        subtitle: null,
        heroImageUrl: null,
      },
    ];

    const result = formatRepositories(repos, emptyCounts, emptyRoots);
    expect(result[0].display_title).toBeNull();
    expect(result[0].subtitle).toBeNull();
    expect(result[0].hero_image_url).toBeNull();
  });

  it("display_title defaults to null — frontend handles fallback to name", () => {
    const repos = [
      {
        id: "r3",
        code: "co-agn",
        name: "Archivo General de la Nacion",
        shortName: "AGN",
        countryCode: "COL",
        country: "Colombia",
        city: "Bogota",
        address: null,
        website: null,
        rightsText: null,
        displayTitle: null,
        subtitle: null,
        heroImageUrl: null,
      },
    ];

    const result = formatRepositories(repos, emptyCounts, emptyRoots);
    // Export sends null — the frontend falls back to name
    expect(result[0].display_title).toBeNull();
    expect(result[0].name).toBe("Archivo General de la Nacion");
  });
});
