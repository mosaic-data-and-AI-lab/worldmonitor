import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fromConflict, fromUcdp, fromUnrest, toGeoEvents } from '../shared/geo-events.ts';

// Sample records in the shapes the client actually holds (UcdpGeoEvent,
// ConflictEvent, SocialUnrestEvent), so the converters are proven before the
// UCDP token and ACLED access arrive.

const ucdp = {
  id: '512345',
  date_start: '2026-10-12',
  latitude: 11.85,
  longitude: 13.16,
  country: 'Nigeria',
  side_a: 'Government of Nigeria',
  side_b: 'IS West Africa',
  deaths_best: 7,
  type_of_violence: 'state-based',
};

const acledConflict = {
  id: 'acled-NIG12345',
  eventType: 'explosion',
  country: 'Nigeria',
  region: 'Borno',
  lat: 11.83,
  lon: 13.15,
  time: new Date('2026-10-20T00:00:00Z'),
  fatalities: 3,
  actors: ['JAS', 'Civilians'],
};

const unrest = {
  id: 'gdelt-1331238251',
  title: 'Port workers strike in Durban',
  eventType: 'strike',
  country: 'South Africa',
  lat: -29.86,
  lon: 31.03,
  time: new Date('2026-11-05T09:00:00Z'),
  sourceType: 'gdelt' as const,
};

describe('geo-events converters', () => {
  it('maps a UCDP event: deaths_best, both sides, start date, feed-prefixed id', () => {
    assert.deepEqual(fromUcdp(ucdp), {
      id: 'ucdp:512345',
      source: 'ucdp',
      kind: 'state-based',
      lat: 11.85,
      lon: 13.16,
      time: Date.parse('2026-10-12'),
      country: 'Nigeria',
      fatalities: 7,
      actors: ['Government of Nigeria', 'IS West Africa'],
    });
  });

  it('maps a real ACLED conflict event, keeping its type and region', () => {
    const e = fromConflict(acledConflict);
    assert.equal(e?.id, 'conflict:acled-NIG12345');
    assert.equal(e?.source, 'acled');
    assert.equal(e?.kind, 'explosion');
    assert.equal(e?.region, 'Borno');
    assert.equal(e?.time, Date.parse('2026-10-20T00:00:00Z'));
    assert.deepEqual(e?.actors, ['JAS', 'Civilians']);
  });

  it('counts GDELT fallback records on the ACLED endpoint as GDELT, with no trusted type', () => {
    const e = fromConflict({ ...acledConflict, id: 'gdelt-event-998877', eventType: 'battle' });
    assert.equal(e?.source, 'gdelt');
    assert.equal(e?.kind, 'conflict');
  });

  it('maps an unrest event and defaults missing fatalities and actors', () => {
    const e = fromUnrest(unrest);
    assert.equal(e?.id, 'unrest:gdelt-1331238251');
    assert.equal(e?.source, 'gdelt');
    assert.equal(e?.kind, 'strike');
    assert.equal(e?.fatalities, 0);
    assert.deepEqual(e?.actors, []);
    assert.equal(e?.title, 'Port workers strike in Durban');
    assert.equal('region' in (e ?? {}), false);
  });

  it('keeps the unrest feed source (acled, rss) as reported', () => {
    assert.equal(fromUnrest({ ...unrest, sourceType: 'acled' })?.source, 'acled');
    assert.equal(fromUnrest({ ...unrest, sourceType: 'rss' })?.source, 'rss');
  });

  it('accepts epoch-ms and ISO-string times as well as Date', () => {
    const ms = Date.parse('2026-11-01T12:00:00Z');
    assert.equal(fromUnrest({ ...unrest, time: ms })?.time, ms);
    assert.equal(fromConflict({ ...acledConflict, time: '2026-11-01T12:00:00Z' })?.time, ms);
  });

  it('drops events with no usable location or time', () => {
    assert.equal(fromUcdp({ ...ucdp, latitude: 0, longitude: 0 }), null, 'null island = missing location');
    assert.equal(fromUcdp({ ...ucdp, date_start: '' }), null);
    assert.equal(fromConflict({ ...acledConflict, lat: Number.NaN }), null);
    assert.equal(fromConflict({ ...acledConflict, lon: 181 }), null);
    assert.equal(fromUnrest({ ...unrest, time: new Date('not a date') }), null);
  });

  it('keeps unrest source links (http/https only, de-duplicated) so a protest or riot can be traced', () => {
    const e = fromUnrest({
      ...unrest,
      eventType: 'riot',
      sourceUrls: ['https://a.example/riot', ' https://a.example/riot ', 'javascript:alert(1)', 'http://b.example/x', ''],
    });
    assert.deepEqual(e?.urls, ['https://a.example/riot', 'http://b.example/x']);
    assert.equal('urls' in (fromUnrest(unrest) ?? {}), false, 'no links → no urls field');
  });

  it('keeps outlet names from UCDP and ACLED, which publish no links', () => {
    assert.equal(fromUcdp({ ...ucdp, source_original: 'Reuters; Premium Times' })?.sourceName, 'Reuters; Premium Times');
    assert.equal(fromConflict({ ...acledConflict, source: 'Daily Trust' })?.sourceName, 'Daily Trust');
    assert.equal('sourceName' in (fromUcdp({ ...ucdp, source_original: '  ' }) ?? {}), false);
  });

  it('carries the plain-English summary, city and GDELT report count of an unrest event', () => {
    const e = fromUnrest({
      ...unrest,
      title: 'Demonstration in Tehran, Iran',
      summary: 'Demonstration by students against the government. Reported in 9 news articles.',
      city: 'Tehran',
      tags: ['9 news reports', 'city-level location'],
    });
    assert.equal(e?.summary, 'Demonstration by students against the government. Reported in 9 news articles.');
    assert.equal(e?.city, 'Tehran');
    assert.equal(e?.reports, 9);
    assert.equal('reports' in (fromUnrest({ ...unrest, tags: ['protest'] }) ?? {}), false);
  });

  it('marks an ACLED event that GDELT also reported (merged by the unrest seed)', () => {
    assert.deepEqual(fromUnrest({ ...unrest, sourceType: 'acled', sources: ['Reuters', 'GDELT'] })?.alsoIn, ['gdelt']);
    assert.equal('alsoIn' in (fromUnrest({ ...unrest, sourceType: 'gdelt', sources: ['GDELT'] }) ?? {}), false);
  });

  it('toGeoEvents keeps order and skips dropped events', () => {
    const events = toGeoEvents([ucdp, { ...ucdp, id: 'bad', latitude: 0, longitude: 0 }, { ...ucdp, id: '2' }], fromUcdp);
    assert.deepEqual(events.map((e) => e.id), ['ucdp:512345', 'ucdp:2']);
  });
});
