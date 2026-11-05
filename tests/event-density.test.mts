import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { latLngToCell } from 'h3-js';

import { binEvents, densityStep, resolutionForZoom } from '../src/services/event-density.ts';
import type { GeoEvent } from '../shared/geo-events.ts';

function ev(over: Partial<GeoEvent>): GeoEvent {
  return {
    id: `t:${Math.random()}`, source: 'gdelt', kind: 'protest',
    lat: 11.85, lon: 13.16, time: 0, country: 'Nigeria', fatalities: 0, actors: [],
    ...over,
  };
}

describe('resolutionForZoom', () => {
  it('steps at zoom 3, 5 and 7', () => {
    assert.deepEqual([0, 2, 2.9, 3, 4.9, 5, 6.9, 7, 14].map(resolutionForZoom), [2, 2, 2, 3, 3, 4, 4, 5, 5]);
  });
});

describe('binEvents', () => {
  it('returns nothing for no events', () => {
    assert.deepEqual(binEvents([], 3, latLngToCell), []);
  });

  it('merges nearby events into one cell with counts, deaths and a per-source breakdown', () => {
    const cells = binEvents([
      ev({ source: 'ucdp', fatalities: 7 }),
      ev({ source: 'acled', fatalities: 3, lat: 11.86 }),
      ev({ source: 'gdelt' }),
    ], 3, latLngToCell);
    assert.equal(cells.length, 1);
    assert.equal(cells[0].h3, latLngToCell(11.85, 13.16, 3));
    assert.equal(cells[0].count, 3);
    assert.equal(cells[0].fatalities, 10);
    assert.deepEqual(cells[0].bySource, { ucdp: 1, acled: 1, gdelt: 1 });
  });

  it('keeps distant events apart and puts the busiest cell first', () => {
    const cells = binEvents([
      ev({ lat: -29.86, lon: 31.03, country: 'South Africa' }),
      ev({}), ev({}),
    ], 3, latLngToCell);
    assert.deepEqual(cells.map((c) => [c.count, c.topCountry]), [[2, 'Nigeria'], [1, 'South Africa']]);
  });

  it('names the country with the most events in a border cell (ties: alphabetical)', () => {
    const near = { lat: 13.0, lon: 14.0 };
    assert.equal(binEvents([ev({ ...near, country: 'Niger' }), ev({ ...near, country: 'Chad' }), ev({ ...near, country: 'Chad' })], 2, latLngToCell)[0].topCountry, 'Chad');
    assert.equal(binEvents([ev({ ...near, country: 'Niger' }), ev({ ...near, country: 'Chad' })], 2, latLngToCell)[0].topCountry, 'Chad');
  });

  it('keeps the events of each cell, newest first, for the click-through popup', () => {
    const cells = binEvents([
      ev({ id: 'old', time: 1_000 }),
      ev({ id: 'new', time: 3_000, urls: ['https://a.example/x'] }),
      ev({ id: 'mid', time: 2_000 }),
    ], 3, latLngToCell);
    assert.deepEqual(cells[0].events.map((e) => e.id), ['new', 'mid', 'old']);
    assert.deepEqual(cells[0].events[0].urls, ['https://a.example/x']);
  });

  it('a coarser resolution merges what a finer one keeps apart', () => {
    const pair = [ev({ lat: 11.85, lon: 13.16 }), ev({ lat: 12.4, lon: 13.6 })];
    assert.equal(binEvents(pair, 5, latLngToCell).length, 2);
    assert.equal(binEvents(pair, 2, latLngToCell).length, 1);
  });
});

describe('densityStep', () => {
  it('stays within 0..steps-1 and never decreases as the count rises', () => {
    const steps = [1, 2, 5, 10, 50, 100, 400].map((n) => densityStep(n, 400));
    assert.equal(steps.at(-1), 4);
    assert.ok(steps.every((s, i) => s >= 0 && s <= 4 && (i === 0 || s >= steps[i - 1])));
  });

  it('a lone event among hundreds is the lowest step; the busiest cell is the highest', () => {
    assert.equal(densityStep(1, 400), 0);
    assert.equal(densityStep(400, 400), 4);
  });

  it('treats empty input as the lowest step', () => {
    assert.equal(densityStep(0, 10), 0);
    assert.equal(densityStep(3, 0), 0);
  });
});
