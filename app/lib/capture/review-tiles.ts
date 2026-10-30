/**
 * Capture QC Viewer — Reading the Review Tiles from B2
 *
 * This module deals with the addresses the capture QC viewer uses to
 * read a page's review tiles straight from the federation's private
 * review-tiles bucket on Backblaze B2. Each page's tiles sit under
 * `{downloadUrl}/file/{bucket}/{prefix}{page key}/`, where the review
 * run wrote an IIIF Image API 3 `info.json` (level 0, 512-pixel tiles)
 * whose `id` is that page's B2 download address. The download
 * authorisation that lets the browser read them comes from the
 * review-access route (`useReviewAccess`).
 *
 * B2 sets two constraints on every request. The token travels as the
 * `?Authorization=` query parameter, never as a header: B2 answers the
 * CORS preflight that a header would cause with 401. And a path may
 * not hold a literal comma: B2 refuses it with 400 ("Bad character in
 * percent-encoded string: 44"), while the same path with each comma
 * written as `%2C` is served. IIIF regions and sizes are made of
 * commas, so `reviewTileUrl` writes every comma in them as `%2C`.
 *
 * OpenSeadragon builds an IIIF tile address as
 * `[id, region, size, "0", "default.jpg"].join("/")`, with raw commas
 * and no token, so it never requests a tile itself.
 * `reviewTileSource` builds OpenSeadragon's own IIIF tile source from a
 * fetched `info.json`, which keeps its arithmetic for levels, regions
 * and edge tiles, and wraps its `getTileUrl`: the wrapper takes the
 * region and size OpenSeadragon computed and answers with a function
 * that builds the address through `reviewTileUrl` when the tile is
 * loaded. OpenSeadragon calls that function at load time
 * (`Tile.getUrl`), so a tile reads whatever token is current then, and
 * a refreshed token applies to every later request. A tile whose
 * address is a function is cached under its level and position, so a
 * new token does not make OpenSeadragon load tiles it already holds.
 *
 * OpenSeadragon logs a tile that failed to load with its full address,
 * token included (`_onTileLoad`, through `OpenSeadragon.console`).
 * `reviewTileSource` therefore puts a console in front of
 * OpenSeadragon's, once per namespace, that writes every
 * `Authorization=` value in its string and error arguments as
 * `[redacted]`. OpenSeadragon's direct calls to the browser's console
 * carry fixed text only.
 *
 * The viewer fetches `info.json` itself, with the token in the query
 * string, and hands the parsed document to
 * `reviewTileSource`; OpenSeadragon is never given the `info.json`
 * address, which it would request without the token.
 *
 * @version v0.8.0
 */

/** IIIF parameters may not carry a literal comma on B2. */
function encodeCommas(value: string): string {
  return value.replace(/,/g, "%2C");
}

/**
 * The address of one review tile: `{id}/{region}/{size}/0/default.jpg`,
 * with every comma of the region and the size written as `%2C`, and the
 * download authorisation token as the URL-encoded `Authorization` query
 * parameter.
 */
export function reviewTileUrl(id: string, region: string, size: string, token: string): string {
  return `${id}/${encodeCommas(region)}/${encodeCommas(size)}/0/default.jpg?Authorization=${encodeURIComponent(token)}`;
}

/** An `Authorization` query parameter's value, wherever it appears in text. */
const AUTHORIZATION_VALUE = /(Authorization=)[^&#\s"'<>)]*/gi;

function redact(arg: unknown): unknown {
  if (typeof arg === "string") return arg.replace(AUTHORIZATION_VALUE, "$1[redacted]");
  if (arg instanceof Error) return `${arg.name}: ${String(arg.message).replace(AUTHORIZATION_VALUE, "$1[redacted]")}`;
  return arg;
}

/** The consoles already put in front of OpenSeadragon's. */
const redactingConsoles = new WeakSet<object>();

/**
 * Puts a console in front of OpenSeadragon's (`osd.console`, the
 * browser's own by default) that redacts every `Authorization=` value in
 * its string and error arguments, once per namespace. OpenSeadragon
 * logs a tile that failed to load with its full address, which carries
 * the download authorisation token.
 */
function redactConsole(osd: { console?: Record<string, unknown> }): void {
  const inner = osd.console;
  if (!inner || redactingConsoles.has(inner)) return;
  const outer: Record<string, unknown> = {};
  for (const name of ["log", "debug", "info", "warn", "error", "assert"]) {
    const method = inner[name];
    if (typeof method !== "function") continue;
    outer[name] = (...args: unknown[]) => method.apply(inner, args.map(redact));
  }
  redactingConsoles.add(outer);
  osd.console = outer;
}

/** The parts of OpenSeadragon's IIIF tile source this module relies on. */
type IiifTileSource = {
  _id: string;
  getTileUrl(level: number, x: number, y: number): string | (() => string);
};

/**
 * OpenSeadragon's IIIF tile source for a fetched `info.json`, with its
 * `getTileUrl` answering a function that builds the tile's address
 * through `reviewTileUrl` with the token `token()` gives when the tile
 * is loaded. `infoUrl` is the `info.json` address without the token,
 * which OpenSeadragon reads only for an `info.json` that has no
 * `@context`. It also puts a redacting console in front of
 * OpenSeadragon's, once, so no log line carries a token.
 */
export function reviewTileSource(
  osd: {
    console?: Record<string, unknown>;
    IIIFTileSource: {
      new (options: object): IiifTileSource;
      prototype: { configure(data: object, url: string, postData: unknown): object };
    };
  },
  info: object,
  infoUrl: string,
  token: () => string,
): IiifTileSource {
  redactConsole(osd);
  // `configure` reads the IIIF version from `@context`, as OpenSeadragon
  // does when it fetches an `info.json` itself.
  const options = osd.IIIFTileSource.prototype.configure(structuredClone(info), infoUrl, null);
  const source = new osd.IIIFTileSource(options);
  const computed = source.getTileUrl.bind(source);
  source.getTileUrl = (level: number, x: number, y: number) => {
    const plain = computed(level, x, y);
    const address = typeof plain === "function" ? plain() : plain;
    // `${id}/${region}/${size}/0/default.jpg`; the id may hold slashes.
    const [region, size] = address.slice(source._id.length + 1).split("/");
    const id = source._id;
    return () => reviewTileUrl(id, region, size, token());
  };
  return source;
}

// @version v0.8.0
