/**
 * Hotspot density: bins point events into H3 hexagons so the map can show
 * which part of a country has the most recorded violence and unrest.
 *
 * Pure functions only. h3-js is passed in rather than imported, so it stays a
 * lazily loaded chunk the way DeckGLMap already loads it for GPS jamming.
 */
import type { GeoEvent, GeoEventSource } from '../../shared/geo-events';

/** h3-js `latLngToCell`, injected by the caller. */
export type LatLngToCell = (lat: number, lng: number, res: number) => string;

export interface DensityCell {
  h3: string;
  count: number;
  fatalities: number;
  bySource: Partial<Record<GeoEventSource, number>>;
  /** The country with the most events in this cell. */
  topCountry: string;
  /** The events in this cell, newest first, so a click can list them with their source links. */
  events: GeoEvent[];
}

/**
 * Hexagon resolution for a map zoom. Average edge length (h3-js 4.4):
 * res 2 ~182 km, 3 ~69 km, 4 ~26 km, 5 ~10 km. Changing only at these
 * thresholds means panning or small zooms never re-bin.
 */
export function resolutionForZoom(zoom: number): number {
  if (zoom < 3) return 2;
  if (zoom < 5) return 3;
  if (zoom < 7) return 4;
  return 5;
}

/** Bins events into cells, busiest first (ties broken by cell id for a stable order). */
export function binEvents(events: readonly GeoEvent[], res: number, toCell: LatLngToCell): DensityCell[] {
  const cells = new Map<string, { cell: DensityCell; countries: Map<string, number> }>();
  for (const e of events) {
    const h3 = toCell(e.lat, e.lon, res);
    let entry = cells.get(h3);
    if (!entry) {
      entry = { cell: { h3, count: 0, fatalities: 0, bySource: {}, topCountry: '', events: [] }, countries: new Map() };
      cells.set(h3, entry);
    }
    const { cell, countries } = entry;
    cell.count += 1;
    cell.events.push(e);
    cell.fatalities += e.fatalities;
    cell.bySource[e.source] = (cell.bySource[e.source] ?? 0) + 1;
    if (e.country) countries.set(e.country, (countries.get(e.country) ?? 0) + 1);
  }

  const out: DensityCell[] = [];
  for (const { cell, countries } of cells.values()) {
    let best = '';
    let bestCount = 0;
    for (const [country, n] of countries) {
      if (n > bestCount || (n === bestCount && country < best)) { best = country; bestCount = n; }
    }
    cell.topCountry = best;
    cell.events.sort((a, b) => b.time - a.time);
    out.push(cell);
  }
  return out.sort((a, b) => b.count - a.count || (a.h3 < b.h3 ? -1 : a.h3 > b.h3 ? 1 : 0));
}

/**
 * Colour step 0..steps-1 for a cell, on a log scale relative to the busiest
 * cell on screen. Counts are heavy-tailed (capitals and GDELT place-name
 * snapping pile events up), so a linear scale would leave every cell but one
 * looking empty. The scale is relative: the tooltip carries the real count.
 */
export function densityStep(count: number, maxCount: number, steps = 5): number {
  if (count <= 0 || maxCount <= 0) return 0;
  const t = Math.log1p(count) / Math.log1p(maxCount);
  return Math.min(steps - 1, Math.floor(t * steps));
}
