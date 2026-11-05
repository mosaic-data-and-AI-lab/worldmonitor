/**
 * Hotspot density popup: each event leads with what happened ("Demonstration in
 * Paris, France"), then one quiet line for when / feed / reports, then links.
 * No per-event icons, and the summary's repeated activity and report count are
 * not shown twice.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MapPopup } from '@/components/MapPopup';
import type { DensityCell } from '@/services/event-density';
import type { GeoEvent } from '../../shared/geo-events';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

let container: HTMLElement | null = null;

afterEach(() => {
  document.querySelectorAll('.map-popup').forEach((el) => el.remove());
  container?.remove();
  container = null;
});

const gdelt: GeoEvent = {
  id: 'unrest:gdelt-protest-1',
  source: 'gdelt',
  kind: 'demonstration',
  lat: 48.85,
  lon: 2.35,
  time: Date.parse('2026-11-05T15:45:00Z'),
  country: 'France',
  city: 'Paris',
  fatalities: 0,
  actors: ['Students'],
  title: 'Demonstration in Paris, France',
  summary: 'Demonstration by students against the government, demanding policy change. Reported in 7 news articles.',
  reports: 7,
  urls: ['https://www.example.com/a', 'https://news.example.org/b', 'https://third.example.net/c'],
};

const ucdp: GeoEvent = {
  id: 'ucdp:1',
  source: 'ucdp',
  kind: 'one-sided',
  lat: 11.85,
  lon: 13.16,
  time: Date.parse('2026-10-12'),
  country: 'Nigeria',
  fatalities: 4,
  actors: [],
  sourceName: 'Reuters',
};

function render(events: GeoEvent[]): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  const popup = new MapPopup(container);
  const cell: DensityCell = {
    h3: '831f8dfffffffff',
    count: events.length,
    fatalities: events.reduce((n, e) => n + e.fatalities, 0),
    bySource: { gdelt: 1, ucdp: 1 },
    topCountry: 'France',
    events,
  } as DensityCell;
  popup.show({ type: 'eventDensity', data: cell, x: 100, y: 100 } as unknown as Parameters<MapPopup['show']>[0]);
  return document.querySelector<HTMLElement>('.map-popup')!;
}

describe('event density popup', () => {
  it('leads each event with its title, then who, then one meta line and links', () => {
    const el = render([gdelt]);
    const item = el.querySelector('.density-event')!;
    expect(item.querySelector('.density-event-title')?.textContent).toBe('Demonstration in Paris, France');
    expect(item.querySelector('.density-event-detail')?.textContent)
      .toBe('By students against the government, demanding policy change.');
    const [meta, links] = [...item.querySelectorAll('.density-event-meta')].map((m) => m.textContent ?? '');
    expect(meta).toMatch(/UTC · GDELT · 7 news reports$/);
    expect(meta).not.toContain('Paris'); // the title already says where
    expect(links).toBe('example.com · news.example.org +1');
  });

  it('gives untitled feeds a title from their type and place, and drops the icons', () => {
    const el = render([gdelt, ucdp]);
    const titles = [...el.querySelectorAll('.density-event-title')].map((t) => t.textContent);
    expect(titles).toEqual(['Demonstration in Paris, France', 'Violence against civilians in Nigeria']);
    const ucdpMeta = [...el.querySelectorAll('.density-event')][1]!.querySelectorAll('.density-event-meta');
    expect(ucdpMeta[0]?.textContent).toMatch(/UCDP · 4 deaths$/);
    expect(ucdpMeta[1]?.textContent).toBe('Reuters');
    expect(el.querySelector('.density-overview')?.textContent).toBe('GDELT 1, UCDP 1 · 7 news reports · 4 deaths');
    expect(el.textContent).not.toMatch(/[📍🗓💀📰🔥📢✊⚔⬢]/u);
  });

  it('skips the detail line when the summary only repeats the title', () => {
    const el = render([{ ...gdelt, summary: 'Demonstration. Reported in 26 news articles.' }]);
    expect(el.querySelector('.density-event-detail')).toBeNull();
  });
});
