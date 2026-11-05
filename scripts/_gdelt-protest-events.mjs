// GDELT protest events from the 15-minute Events export (CAMEO root code 14).
//
// Replaces the GKG-theme unrest buckets, which counted *articles that mention a
// place* ("Israel (43 reports)"): one article about a protest in Virginia that
// mentions Israel landed on Israel's country centroid, and a group could hold
// any number of unrelated protests. The Events table instead codes each event
// with who (Actor1), against whom (Actor2), what (CAMEO 14x), where it happened
// (ActionGeo, not every place mentioned) and how many articles reported it.
//
// Rows for the same place, day and kind of activity (demonstration, strike,
// riot…) are one event reported many times; NumArticles is summed as the number
// of news reports behind it. Country-level geolocations are dropped: they say
// "somewhere in this country", which is exactly what the hotspot map cannot use.

import { gdeltTimestampToMs } from './_conflict-gdelt-bulk.mjs';

const PROTEST_ROOT_CODE = '14';
/** ActionGeo_Type: 1 country, 2 US state, 3 US city, 4 world city, 5 world province. */
const CITY_GEO_TYPES = new Set(['3', '4']);
const PROVINCE_GEO_TYPES = new Set(['2', '5']);
const MAX_SOURCE_URLS = 5;
/** An event needs at least this many reports; single-article codings are mostly noise. */
export const GDELT_PROTEST_MIN_REPORTS = 2;
/**
 * An event needs at least one report with negative tone. GDELT's coder reads
 * "demonstrate" in good-news stories as a protest; on a live 2h sample every
 * event whose reports were all neutral-to-positive was such noise (awards
 * press releases at +6 to +12, newsletters), while real protests read negative.
 */
export const GDELT_PROTEST_MAX_TONE = 0;

/** CAMEO 14x base codes: what the event is, and its unrest type. */
const ACTIVITIES = {
  145: { noun: 'violent protest', type: 'UNREST_EVENT_TYPE_RIOT' },
  144: { noun: 'blockade', type: 'UNREST_EVENT_TYPE_CIVIL_UNREST' },
  143: { noun: 'strike', type: 'UNREST_EVENT_TYPE_STRIKE' },
  141: { noun: 'demonstration', type: 'UNREST_EVENT_TYPE_DEMONSTRATION' },
  142: { noun: 'hunger strike', type: 'UNREST_EVENT_TYPE_PROTEST' },
  140: { noun: 'political protest', type: 'UNREST_EVENT_TYPE_PROTEST' },
};

/** Fourth CAMEO digit of 141x–145x: what the protest demanded. */
const DEMANDS = { 1: 'leadership change', 2: 'policy change', 3: 'rights', 4: 'change in institutions or regime' };

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function titleCase(value) {
  return String(value || '').trim().toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * GDELT names generic actors by role in upper case ("PROTESTER", "GOVERNMENT").
 * Roles read as plain English ("by protesters against the government"); proper
 * names (countries, groups) stay title-cased ("Israel", "Hamas").
 */
const ROLE_PLURALS = {
  PROTESTER: 'protesters', STUDENT: 'students', WORKER: 'workers', ACTIVIST: 'activists',
  RESIDENT: 'residents', FARMER: 'farmers', TEACHER: 'teachers', CITIZEN: 'citizens',
  CIVILIAN: 'civilians', EMPLOYEE: 'employees', DOCTOR: 'doctors', NURSE: 'nurses',
  DRIVER: 'drivers', VILLAGER: 'villagers', LAWYER: 'lawyers', JOURNALIST: 'journalists',
  REFUGEE: 'refugees', MIGRANT: 'migrants', MINER: 'miners', PILOT: 'pilots', WOMEN: 'women',
};
const ROLE_THE = {
  GOVERNMENT: 'the government', POLICE: 'the police', MILITARY: 'the military',
  OPPOSITION: 'the opposition', AUTHORITIES: 'the authorities', PRESIDENT: 'the president',
  'PRIME MINISTER': 'the prime minister', PARLIAMENT: 'parliament', COURT: 'the courts',
  EMPLOYER: 'employers', COMPANY: 'a company', 'SECURITY FORCES': 'security forces',
};

function actorPhrase(name) {
  return ROLE_PLURALS[name] ?? ROLE_THE[name] ?? titleCase(name);
}

/** One protest row per GDELT event. Root events only, located to city or province. */
export function mapGdeltExportToProtestRows(csv) {
  const rows = [];
  const seen = new Set();
  for (const line of String(csv || '').split(/\r?\n/)) {
    if (!line) continue;
    const f = line.split('\t');
    if (f.length < 61 || f[28] !== PROTEST_ROOT_CODE || f[25] !== '1') continue;
    const geoType = f[51];
    if (!CITY_GEO_TYPES.has(geoType) && !PROVINCE_GEO_TYPES.has(geoType)) continue;
    const lat = Number(f[56]);
    const lon = Number(f[57]);
    const place = String(f[52] || '').trim();
    const addedAt = gdeltTimestampToMs(f[59]);
    const id = f[0];
    if (
      !id || seen.has(id) || !place || !/^\d{8}$/.test(f[1]) || !Number.isFinite(addedAt)
      || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)
      || Math.abs(lat) > 90 || Math.abs(lon) > 180
    ) continue;
    seen.add(id);
    const code = String(f[26] || '');
    rows.push({
      id: `gdelt-protest-${id}`,
      day: f[1],
      code,
      baseCode: ACTIVITIES[f[27]] ? f[27] : (ACTIVITIES[code.slice(0, 3)] ? code.slice(0, 3) : '140'),
      actor1: String(f[6] || '').trim().toUpperCase(),
      actor2: String(f[16] || '').trim().toUpperCase(),
      place,
      geoType,
      featureId: String(f[58] || ''),
      lat,
      lon,
      articles: Math.max(1, Number.parseInt(f[33], 10) || 1),
      tone: Number(f[34]) || 0,
      url: safeHttpUrl(f[60]),
      occurredAt: addedAt,
      gdeltAddedAt: addedAt,
    });
  }
  return rows;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}


function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** "Paris, Ile-de-France, France" → city / region / country by GDELT's FullName layout. */
function placeParts(place, geoType) {
  const parts = place.split(',').map((p) => p.trim()).filter(Boolean);
  const country = parts.at(-1) || place;
  if (PROVINCE_GEO_TYPES.has(geoType)) {
    return { city: '', region: parts.length > 1 ? parts[0] : '', country, label: parts.length > 1 ? `${parts[0]}, ${country}` : country };
  }
  return {
    city: parts[0] || '',
    region: parts.length >= 3 ? parts[1] : '',
    country,
    label: parts.length > 1 ? `${parts[0]}, ${country}` : country,
  };
}

/** GDELT sometimes names the event's own place as an actor ("against Delhi" in Delhi). */
function isPlaceName(actor, place) {
  return Boolean(actor) && place.toUpperCase().split(',').some((part) => part.trim() === actor);
}

/** "Demonstration by students against the government, demanding policy change." */
function describeActivity(baseCode, row) {
  const noun = capitalize(ACTIVITIES[baseCode].noun);
  const actor1 = isPlaceName(row.actor1, row.place) ? '' : row.actor1;
  const actor2 = isPlaceName(row.actor2, row.place) ? '' : row.actor2;
  const by = actor1 ? ` by ${actorPhrase(actor1)}` : '';
  const against = actor2 && actor2 !== actor1 ? ` against ${actorPhrase(actor2)}` : '';
  const demand = DEMANDS[row.code[3]] ? `, demanding ${DEMANDS[row.code[3]]}` : '';
  return `${noun}${by}${against}${demand}.`;
}

/**
 * One unrest entry per event: GDELT rows for the same place, day and kind of
 * activity (CAMEO base code) are one event reported many times. Each entry
 * says what happened, where, when, how many news articles reported it, and
 * links to them, in the shape seed-unrest-events publishes (UnrestEvent proto
 * fields). The report count travels as a readable tag ("14 news reports"),
 * which the protest popup shows as a chip and the client reads back.
 */
export function buildGdeltProtestEvents(rows, {
  minReports = GDELT_PROTEST_MIN_REPORTS,
  maxTone = GDELT_PROTEST_MAX_TONE,
} = {}) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const where = row.featureId || `${row.lat.toFixed(2)},${row.lon.toFixed(2)}`;
    const key = `${where}|${row.day}|${row.baseCode}`;
    const group = groups.get(key) ?? { key, baseCode: row.baseCode, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }

  const events = [];
  for (const group of groups.values()) {
    const reports = group.rows.reduce((sum, r) => sum + r.articles, 0);
    const tone = Math.min(...group.rows.map((r) => r.tone));
    if (reports < minReports || tone >= maxTone) continue;

    // The most-reported coding speaks for the event (actors, demand, location).
    const byReports = [...group.rows].sort((a, b) => b.articles - a.articles);
    const lead = byReports[0];
    const where = placeParts(lead.place, lead.geoType);
    const provinceOnly = PROVINCE_GEO_TYPES.has(lead.geoType);
    const activity = ACTIVITIES[group.baseCode];

    const sentences = [describeActivity(group.baseCode, lead), `Reported in ${plural(reports, 'news article')}.`];
    if (provinceOnly) sentences.push(`Location known only to province level (${where.label}).`);

    const sourceUrls = [];
    for (const row of byReports) {
      if (row.url && !sourceUrls.includes(row.url)) sourceUrls.push(row.url);
      if (sourceUrls.length >= MAX_SOURCE_URLS) break;
    }

    events.push({
      id: `gdelt-protest-${group.key.replace(/[^A-Za-z0-9.,|-]/g, '').replace(/[|,]/g, '-')}`,
      title: `${capitalize(activity.noun)} in ${where.label}`,
      summary: sentences.join(' '),
      eventType: activity.type,
      city: where.city,
      country: where.country,
      region: where.region,
      location: { latitude: lead.lat, longitude: lead.lon },
      occurredAt: Math.max(...group.rows.map((r) => r.occurredAt)),
      severity: activity.type === 'UNREST_EVENT_TYPE_RIOT' || reports >= 50
        ? 'SEVERITY_LEVEL_HIGH'
        : (reports >= 10 ? 'SEVERITY_LEVEL_MEDIUM' : 'SEVERITY_LEVEL_LOW'),
      fatalities: 0,
      sources: ['GDELT'],
      sourceType: 'UNREST_SOURCE_TYPE_GDELT',
      tags: [plural(reports, 'news report'), provinceOnly ? 'province-level location' : 'city-level location'],
      actors: [...new Set([lead.actor1, lead.actor2].filter(Boolean).map(titleCase))],
      confidence: reports >= 10 ? 'CONFIDENCE_LEVEL_HIGH' : (reports >= 3 ? 'CONFIDENCE_LEVEL_MEDIUM' : 'CONFIDENCE_LEVEL_LOW'),
      sourceUrls,
      tone,
    });
  }
  return events.sort((a, b) => b.occurredAt - a.occurredAt);
}
