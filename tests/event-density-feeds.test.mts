import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { combineDensityEvents } from '../src/services/event-density-feeds.ts';

const ucdp = {
  id: '512345', date_start: '2026-10-20', latitude: 11.85, longitude: 13.16, country: 'Nigeria',
  side_a: 'Government of Nigeria', side_b: 'IS West Africa', deaths_best: 6, type_of_violence: 'state-based',
};
// 5 km away, same day, similar death toll: the same battle as `ucdp`.
const acledSameBattle = {
  id: 'acled-NIG1', eventType: 'battle', country: 'Nigeria', lat: 11.88, lon: 13.13,
  time: new Date('2026-10-20T00:00:00Z'), fatalities: 5, actors: [],
};
const unrest = {
  id: 'gdelt-1', eventType: 'protest', country: 'Kenya', lat: -1.29, lon: 36.82,
  time: new Date('2026-11-04T10:00:00Z'), sourceType: 'gdelt' as const,
};

describe('combineDensityEvents', () => {
  it('returns every feed as GeoEvents', () => {
    const events = combineDensityEvents({ ucdp: [ucdp], conflicts: [], unrest: [unrest] });
    assert.deepEqual(events.map((e) => e.id), ['ucdp:512345', 'unrest:gdelt-1']);
  });

  it('drops the UCDP copy of a battle that a real ACLED event already records', () => {
    const events = combineDensityEvents({ ucdp: [ucdp], conflicts: [acledSameBattle], unrest: [] });
    assert.deepEqual(events.map((e) => e.id), ['conflict:acled-NIG1']);
  });

  it('keeps UCDP when the match is only a GDELT fallback record', () => {
    const gdelt = { ...acledSameBattle, id: 'gdelt-event-77' };
    const events = combineDensityEvents({ ucdp: [ucdp], conflicts: [gdelt], unrest: [] });
    assert.deepEqual(events.map((e) => [e.id, e.source]), [['ucdp:512345', 'ucdp'], ['conflict:gdelt-event-77', 'gdelt']]);
  });

  it('keeps UCDP when the ACLED event is far away or weeks apart', () => {
    const far = { ...acledSameBattle, lat: 9.06, lon: 7.49 };
    const later = { ...acledSameBattle, time: new Date('2026-11-20T00:00:00Z') };
    assert.equal(combineDensityEvents({ ucdp: [ucdp], conflicts: [far], unrest: [] }).length, 2);
    assert.equal(combineDensityEvents({ ucdp: [ucdp], conflicts: [later], unrest: [] }).length, 2);
  });

  it('does not throw on an ACLED event with an invalid time', () => {
    const bad = { ...acledSameBattle, time: new Date('nope') };
    const events = combineDensityEvents({ ucdp: [ucdp], conflicts: [bad], unrest: [] });
    assert.deepEqual(events.map((e) => e.id), ['ucdp:512345']);
  });

  const gdeltClash = {
    id: 'gdelt-conflict--3365261-20261104-193',
    title: 'Armed clash in Khartoum, Sudan',
    summary: 'Armed clash by the military against rebels. Reported in 7 news articles.',
    eventType: 'armed clash',
    city: 'Khartoum',
    country: 'Sudan',
    location: { latitude: 15.55, longitude: 32.53 },
    occurredAt: Date.parse('2026-11-04T12:00:00Z'),
    tags: ['7 news reports', 'city-level location'],
    sourceUrls: ['https://news.example/clash'],
  };

  it('shows located GDELT conflict events, with title, reports and links, while ACLED has none', () => {
    const [event] = combineDensityEvents({ ucdp: [], conflicts: [], unrest: [], gdeltConflict: [gdeltClash] });
    assert.equal(event?.id, 'conflict:gdelt-conflict--3365261-20261104-193');
    assert.equal(event?.source, 'gdelt');
    assert.equal(event?.kind, 'armed clash');
    assert.equal(event?.title, 'Armed clash in Khartoum, Sudan');
    assert.equal(event?.reports, 7);
    assert.deepEqual(event?.urls, ['https://news.example/clash']);
    assert.deepEqual([event?.lat, event?.lon], [15.55, 32.53]);
  });

  it('drops GDELT conflict events once ACLED supplies real conflict events', () => {
    const events = combineDensityEvents({ ucdp: [], conflicts: [acledSameBattle], unrest: [], gdeltConflict: [gdeltClash] });
    assert.deepEqual(events.map((e) => e.id), ['conflict:acled-NIG1']);
  });

  it('drops GDELT conflict events without a location', () => {
    const { location: _drop, ...noLocation } = gdeltClash;
    assert.deepEqual(combineDensityEvents({ ucdp: [], conflicts: [], unrest: [], gdeltConflict: [noLocation] }), []);
  });
});
