/**
 * Tests — reading the review tiles from B2
 *
 * This suite pins the addresses the capture QC viewer builds for the
 * review tiles (`review-tiles.ts`):
 *
 *   - `reviewTileUrl`: every comma of the region and the size written
 *     as `%2C`, since B2 refuses a literal comma in a path; the token as
 *     the URL-encoded `Authorization` query parameter; `full/max`; and an
 *     edge tile narrower than 512 pixels;
 *   - `reviewTileSource`: OpenSeadragon's IIIF tile source, built from
 *     the configured `info.json` without changing the document handed
 *     in, whose `getTileUrl` answers a function that builds the address
 *     through `reviewTileUrl` with the token current when it is called,
 *     so a refreshed token reaches every later tile; and a console put
 *     once in front of OpenSeadragon's that redacts every
 *     `Authorization=` value, since OpenSeadragon logs a failed tile
 *     with its full address.
 *
 * OpenSeadragon needs a browser, so the tile source is a stand-in that
 * keeps OpenSeadragon's contract: `configure` returns the options,
 * the constructor reads the id, and `getTileUrl` joins
 * `[id, region, size, "0", "default.jpg"]` with slashes and raw commas.
 *
 * Every value here is a test value.
 *
 * @version v0.8.0
 */
import { describe, it, expect, vi } from "vitest";
import { reviewTileSource, reviewTileUrl } from "../../app/lib/capture/review-tiles";

const ID = "https://f000.backblazeb2.test/file/review-tiles/co-test/delivery-1/co-test-img_1_c1";

describe("reviewTileUrl", () => {
  it("writes every comma of the region and the size as %2C", () => {
    const url = reviewTileUrl(ID, "0,512,512,512", "512,512", "token-1");
    expect(url).toBe(`${ID}/0%2C512%2C512%2C512/512%2C512/0/default.jpg?Authorization=token-1`);
    expect(url).not.toContain(",");
  });

  it("builds an edge tile narrower than the tile size", () => {
    expect(reviewTileUrl(ID, "3584,0,416,512", "416,512", "token-1")).toBe(
      `${ID}/3584%2C0%2C416%2C512/416%2C512/0/default.jpg?Authorization=token-1`,
    );
  });

  it("leaves full/max as it is", () => {
    expect(reviewTileUrl(ID, "full", "max", "token-1")).toBe(`${ID}/full/max/0/default.jpg?Authorization=token-1`);
  });

  it("URL-encodes the token", () => {
    const url = reviewTileUrl(ID, "full", "max", "4_002a+b/c=d&e f");
    expect(url).toBe(`${ID}/full/max/0/default.jpg?Authorization=4_002a%2Bb%2Fc%3Dd%26e%20f`);
    expect(new URL(url).searchParams.get("Authorization")).toBe("4_002a+b/c=d&e f");
  });
});

// A stand-in for OpenSeadragon's IIIFTileSource with the same contract.
type Tiles = Record<string, [string, string]>;
function fakeOsd(tiles: Tiles) {
  const configured: Array<{ data: any; url: string }> = [];
  class IIIFTileSource {
    _id: string;
    constructor(options: any) {
      this._id = options["@id"] || options.id;
    }
    getTileUrl(level: number, x: number, y: number): string {
      const [region, size] = tiles[`${level}/${x}_${y}`];
      return [this._id, region, size, "0", "default.jpg"].join("/");
    }
  }
  (IIIFTileSource.prototype as any).configure = (data: any, url: string) => {
    configured.push({ data, url });
    data.version = 3;
    return data;
  };
  return { osd: { IIIFTileSource: IIIFTileSource as any }, configured };
}

const info = {
  "@context": "http://iiif.io/api/image/3/context.json",
  id: ID,
  type: "ImageService3",
  protocol: "http://iiif.io/api/image",
  profile: "level0",
  width: 4000,
  height: 5600,
  tiles: [{ width: 512, scaleFactors: [1, 2, 4, 8] }],
};

describe("reviewTileSource", () => {
  const tiles: Tiles = {
    "12/7_0": ["3584,0,416,512", "416,512"],
    "9/0_0": ["full", "500,700"],
    "0/0_0": ["full", "max"],
  };

  it("configures OpenSeadragon's tile source from a copy of the info.json", () => {
    const { osd, configured } = fakeOsd(tiles);
    const source = reviewTileSource(osd, info, `${ID}/info.json`, () => "token-1");
    expect(source._id).toBe(ID);
    expect(configured).toHaveLength(1);
    expect(configured[0].url).toBe(`${ID}/info.json`);
    expect(configured[0].data).toEqual({ ...info, version: 3 });
    expect(info).not.toHaveProperty("version");
  });

  it("answers each tile's address through reviewTileUrl, with no raw comma", () => {
    const { osd } = fakeOsd(tiles);
    const source = reviewTileSource(osd, info, `${ID}/info.json`, () => "token-1");
    for (const [key, [region, size]] of Object.entries(tiles)) {
      const [level, xy] = key.split("/");
      const [x, y] = xy.split("_").map(Number);
      const url = source.getTileUrl(Number(level), x, y);
      expect(typeof url).toBe("function");
      const address = (url as () => string)();
      expect(address).toBe(reviewTileUrl(ID, region, size, "token-1"));
      expect(new URL(address).pathname).not.toContain(",");
    }
  });

  it("reads the token when the tile is loaded, so a refreshed token applies to later tiles", () => {
    const { osd } = fakeOsd(tiles);
    let token = "token-1";
    const source = reviewTileSource(osd, info, `${ID}/info.json`, () => token);
    const edge = source.getTileUrl(12, 7, 0) as () => string;
    expect(edge()).toContain("?Authorization=token-1");
    token = "token-2";
    expect(edge()).toBe(`${ID}/3584%2C0%2C416%2C512/416%2C512/0/default.jpg?Authorization=token-2`);
    expect((source.getTileUrl(0, 0, 0) as () => string)()).toBe(`${ID}/full/max/0/default.jpg?Authorization=token-2`);
  });
});

describe("OpenSeadragon's console", () => {
  function withConsole() {
    const { osd } = fakeOsd({ "0/0_0": ["full", "max"] });
    const calls: Array<[string, unknown[]]> = [];
    const browser = {
      log: vi.fn((...a: unknown[]) => calls.push(["log", a])),
      warn: vi.fn((...a: unknown[]) => calls.push(["warn", a])),
      error: vi.fn((...a: unknown[]) => calls.push(["error", a])),
      assert: vi.fn((...a: unknown[]) => calls.push(["assert", a])),
    };
    (osd as any).console = browser;
    return { osd: osd as any, calls, browser };
  }

  it("redacts the token in every argument OSD logs, as its failed-tile line does", () => {
    const { osd, calls } = withConsole();
    const source = reviewTileSource(osd, info, `${ID}/info.json`, () => "secret+token/1");
    const url = (source.getTileUrl(0, 0, 0) as () => string)();
    expect(url).toContain("secret");
    osd.console.error("Tile %s failed to load: %s - error: %s", "0/0_0", url, `Image load aborted: ${url}`);
    osd.console.warn(new Error(`fetch failed for ${url}`));
    osd.console.log("plain", 3, { level: 0 });
    osd.console.assert(false, `?a=1&Authorization=abc&b=2`);
    expect(JSON.stringify(calls)).not.toContain("secret");
    expect(calls[0]).toEqual([
      "error",
      [
        "Tile %s failed to load: %s - error: %s",
        "0/0_0",
        `${ID}/full/max/0/default.jpg?Authorization=[redacted]`,
        `Image load aborted: ${ID}/full/max/0/default.jpg?Authorization=[redacted]`,
      ],
    ]);
    expect(calls[1]).toEqual(["warn", [`Error: fetch failed for ${ID}/full/max/0/default.jpg?Authorization=[redacted]`]]);
    expect(calls[2]).toEqual(["log", ["plain", 3, { level: 0 }]]);
    expect(calls[3]).toEqual(["assert", [false, "?a=1&Authorization=[redacted]&b=2"]]);
  });

  it("puts the redacting console in place once, however many tile sources are built", () => {
    const { osd, browser } = withConsole();
    reviewTileSource(osd, info, `${ID}/info.json`, () => "t");
    const first = osd.console;
    reviewTileSource(osd, info, `${ID}/info.json`, () => "t");
    expect(osd.console).toBe(first);
    osd.console.error("Authorization=t");
    expect(browser.error).toHaveBeenCalledTimes(1);
    expect(browser.error).toHaveBeenCalledWith("Authorization=[redacted]");
  });
});

// @version v0.8.0
