#!/usr/bin/env node
// @ts-check
//
// Kaspersky Cyberthreat Real-Time Map — country attack-rate statistics.
//
// Source: the JSON files behind https://cybermap.kaspersky.com/stats, served
// from Kaspersky's media bucket. Undocumented and keyless, and sent without
// CORS headers, so the browser cannot read them — this seeder is the only
// reader. Values are Kaspersky Security Network (KSN) telemetry: the share of
// KSN users in a country who hit a detection that week, per detection
// subsystem. They describe Kaspersky's install base, not a census. Kaspersky
// omits the US and Taiwan from every public file (they are absent from its
// country index), so neither ever appears.
//
// The live map's hourly feed (/data/events/<feed>/<hour>.json) carries two
// base64 Uint32 blobs. `events` is the sampled animation loop (arcs and dots,
// no IOC, actor or target detail) and is not ingested. `totals` holds one
// day's detection counts per subsystem and per country. All 24 files are
// republished together once a day; OAS/ODS/MAV/WAV carry the full-day figure
// in every hour, while IDS/VUL/KAS/RMW accumulate hour by hour, so only hour
// 23 has the complete day for every subsystem. It backs the live map's
// "since 00:00 GMT" counters and "Most infected today" list, and is ingested
// below as `daily`. The site's "Detections per second" chart is the replay
// rate of the sampled loop, not a measurement, so we derive a daily average
// instead.

import { loadEnvFile, runSeed, loadSharedConfig } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const KASPERSKY_CYBERMAP_KEY = 'cyber:kaspersky-stats:v1';
const CACHE_TTL = 3 * 24 * 3600; // 3 days — upstream rolls daily; survives two missed 3-hourly crons with margin
const MAX_STALE_MIN = 2 * 24 * 60;

const BASE = 'https://sm-cybermap-mediaprod.smweb.tech/data/securelist';
const EVENTS_BASE = 'https://sm-cybermap-mediaprod.smweb.tech/data/events/default';
const COUNTRIES_URL = 'https://cybermap.kaspersky.com/map/data/countries.json';
const UA = 'worldmonitor-kaspersky-cybermap-seed/1.0';
const PERIOD = 'w';

// Detection subsystems, in the order the Kaspersky stats page lists them.
// `type` is the subsystem's numeric id in the live map's totals blob.
export const SUBSYSTEMS = [
  { id: 'OAS', label: 'On-Access Scan', type: 1 },
  { id: 'ODS', label: 'On-Demand Scan', type: 2 },
  { id: 'MAV', label: 'Mail Anti-Virus', type: 3 },
  { id: 'WAV', label: 'Web Anti-Virus', type: 4 },
  { id: 'IDS', label: 'Intrusion Detection', type: 5 },
  { id: 'VUL', label: 'Vulnerability Scan', type: 6 },
  { id: 'KAS', label: 'Anti-Spam', type: 7 },
  { id: 'RMW', label: 'Ransomware', type: 9 },
];
const DAILY_TOP_COUNTRIES = 10;

// Kaspersky lists French overseas departments separately; the shared map
// (built from the country geojson) folds them into France.
const ISO2_SUPPLEMENT = { REU: 'RE', MTQ: 'MQ', GLP: 'GP', GUF: 'GF', BES: 'BQ', MYT: 'YT' };

async function getJson(url, attempts = 2) {
  try {
    return await getJsonOnce(url);
  } catch (err) {
    if (attempts <= 1) throw err;
    await new Promise((r) => setTimeout(r, 1000));
    return getJson(url, attempts - 1);
  }
}

async function getJsonOnce(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url}`);
  // A missing file comes back as the site's 200 HTML 404 page, not a 404.
  const text = await resp.text();
  if (!/^\s*[[{]/.test(text)) throw new Error(`non-JSON body ${url}`);
  return JSON.parse(text);
}

/** Kaspersky numeric country id -> ISO3, from entries named MAP_COUNTRY_<ISO3>. */
export function parseCountryIndex(rows) {
  const out = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const m = /^MAP_COUNTRY_([A-Z]{3})$/.exec(String(row?.name ?? ''));
    if (m && Number.isFinite(row?.key) && row.key !== 0) out.set(String(row.key), m[1]);
  }
  return out;
}

export function buildCountryRanking(raw, countryIndex, iso3ToIso2) {
  const rows = [];
  for (const [id, value] of Object.entries(raw ?? {})) {
    const iso3 = countryIndex.get(id);
    const pct = Number(value);
    if (!iso3 || !Number.isFinite(pct)) continue;
    rows.push({ iso3, iso2: iso3ToIso2[iso3] ?? ISO2_SUPPLEMENT[iso3] ?? '', pct });
  }
  rows.sort((a, b) => b.pct - a.pct);
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

export function parseTrend(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((p) => ({ date: String(p?.date ?? ''), count: Number(p?.count) }))
    .filter((p) => p.date && Number.isFinite(p.count));
}

export function parseTopThreats(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((p) => ({ name: String(p?.name ?? ''), pct: Number(p?.percent) }))
    .filter((p) => p.name && Number.isFinite(p.pct));
}

/**
 * Decode the live map's `totals` blob: little-endian Uint32 pairs of
 * (header, count), header = type << 24 | country << 12. Country 0 is the
 * worldwide figure. Countries missing from the index (Kaspersky's own
 * exclusions) are dropped, matching what its "Most infected today" shows.
 */
export function parseDailyTotals(base64, countryIndex, iso3ToIso2) {
  const buf = Buffer.from(String(base64 ?? ''), 'base64');
  const words = new Uint32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  const typeToId = new Map(SUBSYSTEMS.map((s) => [s.type, s.id]));
  const byType = {};
  const byCountry = new Map();
  for (let i = 0; i + 1 < words.length; i += 2) {
    const header = words[i];
    const count = words[i + 1];
    const id = typeToId.get((header >>> 24) & 0xfff);
    if (!id) continue;
    const country = (header >>> 12) & 0xfff;
    if (country === 0) {
      byType[id] = count;
      continue;
    }
    const iso3 = countryIndex.get(String(country));
    if (iso3) byCountry.set(iso3, (byCountry.get(iso3) ?? 0) + count);
  }
  const topCountries = [...byCountry.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, DAILY_TOP_COUNTRIES)
    .map(([iso3, count]) => ({ iso3, iso2: iso3ToIso2[iso3] ?? ISO2_SUPPLEMENT[iso3] ?? '', count }));
  return { byType, topCountries };
}

// Hour 23 is the only file with the complete day for every subsystem (see the
// header). Best-effort: the weekly statistics still publish if this feed is down.
async function fetchDailyTotals(countryIndex, iso3ToIso2) {
  try {
    const resp = await fetch(`${EVENTS_BASE}/23.json`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = await resp.json();
    const parsed = parseDailyTotals(body?.totals, countryIndex, iso3ToIso2);
    if (Object.keys(parsed.byType).length === 0) throw new Error('empty totals');
    const lastModified = Date.parse(resp.headers.get('last-modified') ?? '');
    return {
      publishedAt: Number.isFinite(lastModified) ? new Date(lastModified).toISOString() : null,
      ...parsed,
    };
  } catch (err) {
    console.warn(`  [kaspersky] daily totals: ${err?.message ?? err}`);
    return null;
  }
}

async function fetchSubsystem(sub, countryIndex, iso3ToIso2) {
  const code = sub.id.toLowerCase();
  const [countries, graph, top10] = await Promise.allSettled([
    getJson(`${BASE}/country_${code}_${PERIOD}.json`),
    getJson(`${BASE}/graph_${code}_${PERIOD}_0.json`),
    getJson(`${BASE}/top10_${code}_${PERIOD}_0.json`),
  ]);
  for (const r of [countries, graph, top10]) {
    if (r.status === 'rejected') console.warn(`  [kaspersky] ${sub.id}: ${r.reason?.message ?? r.reason}`);
  }
  return {
    id: sub.id,
    label: sub.label,
    countries: countries.status === 'fulfilled' ? buildCountryRanking(countries.value, countryIndex, iso3ToIso2) : [],
    trend: graph.status === 'fulfilled' ? parseTrend(graph.value) : [],
    topThreats: top10.status === 'fulfilled' ? parseTopThreats(top10.value) : [],
  };
}

export async function fetchKasperskyStats() {
  const countryIndex = parseCountryIndex(await getJson(COUNTRIES_URL));
  if (countryIndex.size < 100) throw new Error(`country index too small (${countryIndex.size})`);
  const iso3ToIso2 = loadSharedConfig('iso3-to-iso2.json');

  const subsystems = [];
  // Sequential: 8 × 3 small files, and the bucket is Kaspersky's public CDN —
  // no reason to burst it.
  for (const sub of SUBSYSTEMS) subsystems.push(await fetchSubsystem(sub, countryIndex, iso3ToIso2));

  return {
    source: 'Kaspersky Cyberthreat Real-Time Map (KSN telemetry)',
    sourceUrl: 'https://cybermap.kaspersky.com/stats',
    period: PERIOD,
    fetchedAt: new Date().toISOString(),
    subsystems,
    daily: await fetchDailyTotals(countryIndex, iso3ToIso2),
  };
}

export function declareRecords(data) {
  return (data?.subsystems ?? []).filter((s) => s.countries?.length > 0).length;
}

// At least half the subsystems must carry a country ranking; a wholesale
// upstream change (moved bucket, renamed files) then fails loud instead of
// publishing an empty panel over last-good data.
export function validate(data) {
  return declareRecords(data) >= SUBSYSTEMS.length / 2;
}

const isMain = process.argv[1]?.endsWith('seed-kaspersky-cybermap.mjs');

if (isMain) {
  runSeed('cyber', 'kaspersky-stats', KASPERSKY_CYBERMAP_KEY, fetchKasperskyStats, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    recordCount: declareRecords,
    declareRecords,
    sourceVersion: 'kaspersky-cybermap-securelist-v2',
    schemaVersion: 1,
    maxStaleMin: MAX_STALE_MIN,
    emptyDataIsFailure: true,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
