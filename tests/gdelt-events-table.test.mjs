import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildGdeltConflictEvents,
  buildGdeltProtestEvents,
  mapGdeltExportToConflictRows,
  mapGdeltExportToProtestRows,
} from '../scripts/_gdelt-events-table.mjs';
import { fetchMaterializedGdelt } from '../scripts/seed-gdelt-bulk-materializer.mjs';

// A GDELT 2.0 Events export row (61 tab-separated columns) with the fields the
// protest parser reads.
function protestRow({
  id = '1', day = '20260730', code = '1412', actor1 = 'STUDENT', actor2 = 'GOVERNMENT',
  geoType = '4', place = 'Tehran, Tehran, Iran', lat = '35.6944', lon = '51.4215', featureId = '-3075928',
  articles = '6', added = '20260730120000', root = '14', isRoot = '1', url,
} = {}) {
  const f = Array.from({ length: 61 }, () => '');
  f[0] = id; f[1] = day; f[6] = actor1; f[16] = actor2;
  f[25] = isRoot; f[26] = code; f[27] = code.slice(0, 3); f[28] = root; f[29] = '3';
  f[33] = articles; f[34] = '-3.5';
  f[51] = geoType; f[52] = place; f[53] = 'IR'; f[56] = lat; f[57] = lon; f[58] = featureId;
  f[59] = added; f[60] = url ?? `https://news.example/${id}`;
  return f.join('\t');
}

const csv = (...rows) => rows.join('\n');

describe('mapGdeltExportToProtestRows', () => {
  it('keeps root protest events located to a city or province, drops the rest', () => {
    const rows = mapGdeltExportToProtestRows(csv(
      protestRow({ id: 'city' }),
      protestRow({ id: 'province', geoType: '5', place: 'Kerala, India' }),
      protestRow({ id: 'country-only', geoType: '1', place: 'Israel' }),
      protestRow({ id: 'not-protest', root: '19', code: '190' }),
      protestRow({ id: 'not-root', isRoot: '0' }),
      protestRow({ id: 'null-island', lat: '0', lon: '0' }),
    ));
    assert.deepEqual(rows.map((r) => r.id), ['gdelt-protest-city', 'gdelt-protest-province']);
    assert.equal(rows[0].actor1, 'STUDENT');
    assert.equal(rows[0].articles, 6);
    assert.equal(rows[0].baseCode, '141');
    assert.equal(rows[0].url, 'https://news.example/city');
    assert.equal(rows[0].occurredAt, Date.parse('2026-07-30T12:00:00Z'));
  });
});

describe('buildGdeltProtestEvents', () => {
  it('turns repeated codings of one event into one entry: what, where, when, reports, links', () => {
    const rows = mapGdeltExportToProtestRows(csv(
      protestRow({ id: 'a', articles: '6' }),
      protestRow({ id: 'b', articles: '3', added: '20260730121500', actor1: 'PROTESTER' }),
    ));
    const [event, ...rest] = buildGdeltProtestEvents(rows);
    assert.equal(rest.length, 0);
    assert.equal(event.title, 'Demonstration in Tehran, Iran');
    assert.equal(
      event.summary,
      'Demonstration by students against the government, demanding policy change. Reported in 9 news articles.',
    );
    assert.equal(event.eventType, 'UNREST_EVENT_TYPE_DEMONSTRATION');
    assert.equal(event.city, 'Tehran');
    assert.equal(event.country, 'Iran');
    assert.equal(event.occurredAt, Date.parse('2026-07-30T12:15:00Z'), 'when = latest report');
    assert.deepEqual(event.tags, ['9 news reports', 'city-level location']);
    assert.deepEqual(event.sourceUrls, ['https://news.example/a', 'https://news.example/b']);
    assert.deepEqual(event.actors, ['Student', 'Government']);
    assert.equal(event.sourceType, 'UNREST_SOURCE_TYPE_GDELT');
  });

  it('keeps different kinds of protest at the same place and day as separate events', () => {
    const events = buildGdeltProtestEvents(mapGdeltExportToProtestRows(csv(
      protestRow({ id: 'demo', code: '141' }),
      protestRow({ id: 'strike', code: '143', actor1: 'WORKER', actor2: '' }),
      protestRow({ id: 'riot', code: '145', actor1: '', actor2: 'POLICE' }),
    )));
    const byTitle = Object.fromEntries(events.map((e) => [e.title, e]));
    assert.deepEqual(Object.keys(byTitle).sort(), [
      'Demonstration in Tehran, Iran', 'Strike in Tehran, Iran', 'Violent protest in Tehran, Iran',
    ]);
    assert.equal(byTitle['Strike in Tehran, Iran'].summary, 'Strike by workers. Reported in 6 news articles.');
    assert.equal(byTitle['Violent protest in Tehran, Iran'].eventType, 'UNREST_EVENT_TYPE_RIOT');
    assert.equal(byTitle['Violent protest in Tehran, Iran'].severity, 'SEVERITY_LEVEL_HIGH');
  });

  it('keeps proper names and says when the place is only known to province level', () => {
    const [event] = buildGdeltProtestEvents(mapGdeltExportToProtestRows(csv(
      protestRow({ geoType: '5', place: 'Kerala, India', actor1: 'FARMER', actor2: 'UNITED STATES', code: '141' }),
    )));
    assert.equal(event.title, 'Demonstration in Kerala, India');
    assert.equal(event.city, '');
    assert.equal(event.region, 'Kerala');
    assert.match(event.summary, /^Demonstration by farmers against United States\. /);
    assert.match(event.summary, /Location known only to province level \(Kerala, India\)\.$/);
    assert.deepEqual(event.tags, ['6 news reports', 'province-level location']);
  });

  it('drops events reported by a single article', () => {
    assert.deepEqual(buildGdeltProtestEvents(mapGdeltExportToProtestRows(protestRow({ articles: '1' }))), []);
  });

  it('drops good-news stories miscoded as protests (no report with negative tone)', () => {
    const positive = (row) => row.replace('\t-3.5\t', '\t6.6\t');
    assert.deepEqual(buildGdeltProtestEvents(mapGdeltExportToProtestRows(positive(protestRow()))), []);
    const mixed = csv(positive(protestRow({ id: 'a' })), protestRow({ id: 'b' }));
    assert.equal(buildGdeltProtestEvents(mapGdeltExportToProtestRows(mixed)).length, 1);
  });

  it('does not name the event\'s own place as the target', () => {
    const [event] = buildGdeltProtestEvents(mapGdeltExportToProtestRows(
      protestRow({ place: 'Delhi, Delhi, India', actor1: 'PROTESTER', actor2: 'DELHI', code: '141' }),
    ));
    assert.equal(event.summary, 'Demonstration by protesters. Reported in 6 news articles.');
  });
});

describe('fetchMaterializedGdelt unrest output', () => {
  const now = Date.parse('2026-07-30T12:05:00Z');
  const gkgRecord = {
    id: 'gkg-1', date: '2026-07-30T12:00:00.000Z', url: 'https://example.com/gkg-1', source: 'example.com',
    title: 'Military exercise', image: '', tone: -2, themes: ['MILITARY'],
    locations: [{ name: 'Cairo, Egypt', countryCode: 'EG', latitude: 30.0444, longitude: 31.2357 }],
  };
  const conflictRowAt = (id, added) => {
    const f = Array.from({ length: 61 }, () => '');
    f[0] = id; f[25] = '1'; f[26] = '190'; f[28] = '19'; f[29] = '4'; f[53] = 'SU';
    f[59] = added; f[60] = `https://example.com/${id}`;
    return f.join('\t');
  };
  const conflictRow = conflictRowAt('c1', '20260730120000');
  const files = (exportCsv) => [
    { descriptor: { kind: 'gkg', timestamp: '20260730120000' }, records: [gkgRecord] },
    { descriptor: { kind: 'export', timestamp: '20260730120000' }, csv: exportCsv },
  ];

  it('publishes protest events from the Events export and keeps the rows in state', async () => {
    const result = await fetchMaterializedGdelt({
      _now: () => now,
      _readSnapshot: async () => ({ cursor: {} }),
      _fetchFiles: async () => files(csv(conflictRow, protestRow({ id: 'p1' }))),
    });
    assert.deepEqual(result._unrest.events.map((e) => e.title), ['Demonstration in Tehran, Iran']);
    assert.equal(result._unrest.fetchedAt, now);
    assert.deepEqual(result._state.protests.events.map((r) => r.id), ['gdelt-protest-p1']);
  });

  it('carries protest rows across runs (24h rolling window)', async () => {
    const first = await fetchMaterializedGdelt({
      _now: () => now,
      _readSnapshot: async () => ({ cursor: {} }),
      _fetchFiles: async () => files(csv(conflictRow, protestRow({ id: 'p1' }))),
    });
    const later = now + 15 * 60 * 1000;
    const second = await fetchMaterializedGdelt({
      _now: () => later,
      _readSnapshot: async (key) => (key.includes('state') ? first._state : { cursor: {} }),
      _fetchFiles: async () => [
        { descriptor: { kind: 'gkg', timestamp: '20260730121500' }, records: [{ ...gkgRecord, id: 'gkg-2', date: '2026-07-30T12:15:00.000Z' }] },
        { descriptor: { kind: 'export', timestamp: '20260730121500' }, csv: csv(conflictRow, protestRow({ id: 'p2', code: '143', added: '20260730121500' })) },
      ],
    });
    assert.deepEqual(second._state.protests.events.map((r) => r.id).sort(), ['gdelt-protest-p1', 'gdelt-protest-p2']);
    assert.deepEqual(second._unrest.events.map((e) => e.title).sort(), ['Demonstration in Tehran, Iran', 'Strike in Tehran, Iran']);
  });

  it('keeps protest rows for 7 days (the map\'s 7d filter), conflict rows for 24h', async () => {
    const day = 86_400_000;
    const first = await fetchMaterializedGdelt({
      _now: () => now,
      _readSnapshot: async () => ({ cursor: {} }),
      _fetchFiles: async () => files(csv(conflictRow, protestRow({ id: 'p1' }))),
    });
    const nextFile = (ts, nowMs, ids) => fetchMaterializedGdelt({
      _now: () => nowMs,
      _readSnapshot: async (key) => (key.includes('state') ? ids.state : { cursor: {} }),
      _fetchFiles: async () => [
        { descriptor: { kind: 'gkg', timestamp: ts }, records: [{ ...gkgRecord, id: `gkg-${ts}`, date: new Date(nowMs - 5 * 60_000).toISOString() }] },
        { descriptor: { kind: 'export', timestamp: ts }, csv: csv(conflictRowAt(ids.conflict, ts), protestRow({ id: ids.protest, day: ts.slice(0, 8), added: ts })) },
      ],
    });

    const threeDaysLater = await nextFile('20260802120000', now + 3 * day, { state: first._state, conflict: 'c2', protest: 'p2' });
    assert.deepEqual(threeDaysLater._state.protests.events.map((r) => r.id).sort(), ['gdelt-protest-p1', 'gdelt-protest-p2']);
    assert.deepEqual(threeDaysLater._state.conflict.events.map((e) => e.id), ['gdelt-event-c2'], 'conflict keeps 24h');
    assert.equal(threeDaysLater._unrest.events.length, 2, 'one event per day at the same place');

    const eightDaysLater = await nextFile('20260807120000', now + 8 * day, { state: threeDaysLater._state, conflict: 'c3', protest: 'p3' });
    assert.deepEqual(eightDaysLater._state.protests.events.map((r) => r.id).sort(), ['gdelt-protest-p2', 'gdelt-protest-p3'], 'p1 aged out after 7 days');
  });

  it('publishes located conflict events for the map and keeps their rows for 7 days', async () => {
    const clash = (id, added) => protestRow({
      id, root: '19', code: '193', actor1: 'MILITARY', actor2: 'REBEL', articles: '4',
      place: 'Khartoum, Khartoum, Sudan', featureId: '-3365261', day: added.slice(0, 8), added,
    });
    const first = await fetchMaterializedGdelt({
      _now: () => now,
      _readSnapshot: async () => ({ cursor: {} }),
      _fetchFiles: async () => files(csv(conflictRow, clash('k1', '20260730120000'))),
    });
    assert.deepEqual(first._conflictMap.events.map((e) => e.title), ['Armed clash in Khartoum, Sudan']);
    assert.equal(first._conflictMap.fetchedAt, now);

    const later = now + 3 * 86_400_000;
    const second = await fetchMaterializedGdelt({
      _now: () => later,
      _readSnapshot: async (key) => (key.includes('state') ? first._state : { cursor: {} }),
      _fetchFiles: async () => [
        { descriptor: { kind: 'gkg', timestamp: '20260802120000' }, records: [{ ...gkgRecord, id: 'gkg-k2', date: new Date(later - 5 * 60_000).toISOString() }] },
        { descriptor: { kind: 'export', timestamp: '20260802120000' }, csv: csv(conflictRowAt('c2', '20260802120000'), clash('k2', '20260802120000')) },
      ],
    });
    assert.deepEqual(second._state.conflictRows.events.map((r) => r.id).sort(), ['gdelt-conflict-k1', 'gdelt-conflict-k2']);
    assert.equal(second._conflictMap.events.length, 2, 'one clash per day');
  });
});

describe('GDELT conflict events', () => {
  it('keeps root assault / fight / mass-violence events with a city or province location', () => {
    const rows = mapGdeltExportToConflictRows(csv(
      protestRow({ id: 'clash', root: '19', code: '193' }),
      protestRow({ id: 'bomb', root: '18', code: '1832' }),
      protestRow({ id: 'mass', root: '20', code: '202' }),
      protestRow({ id: 'protest', root: '14', code: '141' }),
      protestRow({ id: 'country-only', root: '19', code: '190', geoType: '1' }),
      protestRow({ id: 'not-root', root: '19', code: '190', isRoot: '0' }),
    ));
    assert.deepEqual(rows.map((r) => [r.id, r.baseCode]), [
      ['gdelt-conflict-clash', '193'], ['gdelt-conflict-bomb', '183'], ['gdelt-conflict-mass', '202'],
    ]);
  });

  it('says what happened, where, who, and how many reports, in plain English', () => {
    const [event, ...rest] = buildGdeltConflictEvents(mapGdeltExportToConflictRows(csv(
      protestRow({ id: 'a', root: '19', code: '195', actor1: 'ISRAEL', actor2: 'MILITANT', articles: '3', place: 'Gaza, Gaza Strip, Palestine' }),
      protestRow({ id: 'b', root: '19', code: '195', actor1: 'ISRAEL', actor2: 'MILITANT', articles: '4', place: 'Gaza, Gaza Strip, Palestine' }),
    )));
    assert.equal(rest.length, 0);
    assert.equal(event.title, 'Air strike in Gaza, Palestine');
    assert.equal(event.summary, 'Air strike by Israel against militants. Reported in 7 news articles.');
    assert.equal(event.eventType, 'air strike');
    assert.equal(event.severity, 'SEVERITY_LEVEL_MEDIUM');
    assert.deepEqual(event.tags, ['7 news reports', 'city-level location']);
    assert.equal('sourceType' in event, false, 'not an unrest record');
  });

  it('rates mass violence high and drops single-report codings', () => {
    const [mass] = buildGdeltConflictEvents(mapGdeltExportToConflictRows(protestRow({ root: '20', code: '202' })));
    assert.equal(mass.title, 'Mass killing in Tehran, Iran');
    assert.equal(mass.severity, 'SEVERITY_LEVEL_HIGH');
    assert.deepEqual(buildGdeltConflictEvents(mapGdeltExportToConflictRows(protestRow({ root: '19', code: '193', articles: '1' }))), []);
  });
});
