/**
 * One shape for point events from every conflict/unrest feed.
 *
 * The map receives three feeds in three shapes — UCDP (`UcdpGeoEvent`), the
 * ACLED conflict endpoint (`ConflictEvent`) and the unrest feed
 * (`SocialUnrestEvent`). Anything that wants to treat them as one set of
 * events (the hotspot density layer, the affected-infrastructure join, a
 * future history store) converts them here first.
 *
 * Lives in shared/ with no src/ imports so a server handler or seeder can use
 * the same shape. The converters accept structural inputs, so the src/ types
 * pass straight in.
 */

/** Who reported the event. Shown per source so a GDELT-only map is obvious. */
export type GeoEventSource = 'ucdp' | 'acled' | 'gdelt' | 'rss';

export interface GeoEvent {
  /** Prefixed by feed (`ucdp:`, `conflict:`, `unrest:`) so ids never collide across feeds. */
  id: string;
  source: GeoEventSource;
  /**
   * The feed's own category, unchanged: `one-sided`, `riot`, `explosion`…
   * The peril filter maps these to perils later; this layer does not.
   */
  kind: string;
  lat: number;
  lon: number;
  /** Epoch milliseconds. */
  time: number;
  country: string;
  /** Sub-national region (admin1) when the feed carries one. UCDP does not. */
  region?: string;
  fatalities: number;
  actors: string[];
  title?: string;
  /**
   * Links to the original reports (http/https only). GDELT unrest records carry
   * article URLs; ACLED and UCDP publish outlet names, not links.
   */
  urls?: string[];
  /** Outlet names when the feed has no link (ACLED `source`, UCDP `source_original`). */
  sourceName?: string;
  /** Plain-English description of what happened (GDELT protest events, ACLED notes). */
  summary?: string;
  /** City, when the feed names one. */
  city?: string;
  /** How many news articles reported the event, when the feed says (GDELT). */
  reports?: number;
  /** Other feeds that reported the same event and were merged into this one. */
  alsoIn?: GeoEventSource[];
}

/** The fields read from a UCDP GED event (`UcdpGeoEvent` in src/types). */
export interface UcdpEventInput {
  id: string;
  date_start: string;
  latitude: number;
  longitude: number;
  country: string;
  side_a: string;
  side_b: string;
  deaths_best: number;
  type_of_violence: string;
  source_original?: string;
}

/** The fields read from an ACLED-endpoint event (`ConflictEvent` in src/services/conflict). */
export interface ConflictEventInput {
  id: string;
  eventType: string;
  country: string;
  region?: string;
  lat: number;
  lon: number;
  time: Date | number | string;
  fatalities: number;
  actors: string[];
  source?: string;
}

/** The fields read from an unrest event (`SocialUnrestEvent` in src/types). */
export interface UnrestEventInput {
  id: string;
  title?: string;
  eventType: string;
  country: string;
  region?: string;
  lat: number;
  lon: number;
  time: Date | number | string;
  fatalities?: number;
  actors?: string[];
  sourceUrls?: string[];
  sourceType: 'acled' | 'gdelt' | 'rss';
  summary?: string;
  city?: string;
  /** Readable tags; GDELT protest events carry their report count as "N news reports". */
  tags?: string[];
  /** Feed names after de-duplication, e.g. an ACLED event that also lists "GDELT". */
  sources?: string[];
}

const REPORTS_TAG = /^(\d+) news reports?$/;

/** Keeps http(s) links only, de-duplicated, in feed order. */
function webLinks(urls: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of urls ?? []) {
    const url = typeof raw === 'string' ? raw.trim() : '';
    if (/^https?:\/\//i.test(url) && !out.includes(url)) out.push(url);
  }
  return out;
}

function toMs(t: Date | number | string): number {
  if (t instanceof Date) return t.getTime();
  return typeof t === 'number' ? t : Date.parse(t);
}

/**
 * Feeds map a missing location to 0/0 (the UCDP adapter uses `?? 0`), so
 * "null island" is treated as no location rather than an event off Africa.
 */
function isUsablePoint(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    && !(lat === 0 && lon === 0);
}

export function fromUcdp(e: UcdpEventInput): GeoEvent | null {
  const time = Date.parse(e.date_start);
  if (!isUsablePoint(e.latitude, e.longitude) || !Number.isFinite(time)) return null;
  return {
    id: `ucdp:${e.id}`,
    source: 'ucdp',
    kind: e.type_of_violence,
    lat: e.latitude,
    lon: e.longitude,
    time,
    country: e.country,
    fatalities: e.deaths_best || 0,
    actors: [e.side_a, e.side_b].filter(Boolean),
    ...(e.source_original?.trim() ? { sourceName: e.source_original.trim() } : {}),
  };
}

/**
 * The ACLED endpoint is also filled from GDELT when ACLED is unavailable
 * (seed-conflict-intel's fallback, ids `gdelt-…`). Those records are counted
 * as GDELT, and their type is not trusted: the client maps any unrecognised
 * type to `battle`, so a GDELT record's `eventType` says nothing real.
 */
export function fromConflict(e: ConflictEventInput): GeoEvent | null {
  const time = toMs(e.time);
  if (!isUsablePoint(e.lat, e.lon) || !Number.isFinite(time)) return null;
  const isGdelt = e.id.startsWith('gdelt');
  return {
    id: `conflict:${e.id}`,
    source: isGdelt ? 'gdelt' : 'acled',
    kind: isGdelt ? 'conflict' : e.eventType,
    lat: e.lat,
    lon: e.lon,
    time,
    country: e.country,
    ...(e.region ? { region: e.region } : {}),
    fatalities: e.fatalities || 0,
    actors: e.actors ?? [],
    ...(e.source?.trim() ? { sourceName: e.source.trim() } : {}),
  };
}

export function fromUnrest(e: UnrestEventInput): GeoEvent | null {
  const time = toMs(e.time);
  if (!isUsablePoint(e.lat, e.lon) || !Number.isFinite(time)) return null;
  const urls = webLinks(e.sourceUrls);
  const summary = e.summary?.trim();
  const reportsMatch = (e.tags ?? []).map((tag) => REPORTS_TAG.exec(tag.trim())).find(Boolean);
  // The unrest seed merges the same event from ACLED and GDELT into the ACLED
  // record and lists both feeds in `sources`.
  const alsoIn = e.sourceType !== 'gdelt' && (e.sources ?? []).some((s) => s.toUpperCase() === 'GDELT')
    ? (['gdelt'] as GeoEventSource[])
    : [];
  return {
    id: `unrest:${e.id}`,
    source: e.sourceType,
    kind: e.eventType,
    lat: e.lat,
    lon: e.lon,
    time,
    country: e.country,
    ...(e.region ? { region: e.region } : {}),
    ...(e.city ? { city: e.city } : {}),
    fatalities: e.fatalities ?? 0,
    actors: e.actors ?? [],
    ...(e.title ? { title: e.title } : {}),
    ...(summary ? { summary } : {}),
    ...(reportsMatch ? { reports: Number(reportsMatch[1]) } : {}),
    ...(alsoIn.length > 0 ? { alsoIn } : {}),
    ...(urls.length > 0 ? { urls } : {}),
  };
}

/** Converts a feed, dropping events without a usable location or time. */
export function toGeoEvents<T>(items: readonly T[], convert: (item: T) => GeoEvent | null): GeoEvent[] {
  const out: GeoEvent[] = [];
  for (const item of items) {
    const event = convert(item);
    if (event) out.push(event);
  }
  return out;
}
