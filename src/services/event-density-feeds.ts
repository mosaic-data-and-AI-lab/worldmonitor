/**
 * Combines the point feeds into the one event list the hotspot density layer
 * bins: UCDP, the ACLED conflict endpoint, the unrest feed and, while ACLED has
 * no conflict data, located GDELT conflict events.
 */
import {
  fromConflict, fromGdeltConflict, fromUcdp, fromUnrest, toGeoEvents,
  type ConflictEventInput, type GdeltConflictEventInput, type GeoEvent, type UcdpEventInput, type UnrestEventInput,
} from '../../shared/geo-events';
import { isDuplicatedByAcled, type AcledDedupEvent } from './conflict/ucdp-dedupe';

export interface DensityFeeds {
  /** Already de-duplicated against the unrest feed by the data loader. */
  ucdp: readonly UcdpEventInput[];
  conflicts: readonly ConflictEventInput[];
  unrest: readonly UnrestEventInput[];
  /** Located GDELT conflict events; used only when ACLED supplied no conflict events. */
  gdeltConflict?: readonly GdeltConflictEventInput[];
}

function toAcledDedup(e: ConflictEventInput): AcledDedupEvent | null {
  const ms = e.time instanceof Date ? e.time.getTime() : typeof e.time === 'number' ? e.time : Date.parse(e.time);
  if (!Number.isFinite(ms)) return null;
  return { latitude: e.lat, longitude: e.lon, event_date: new Date(ms).toISOString(), fatalities: e.fatalities };
}

/**
 * UCDP and ACLED record many of the same battles, so a UCDP event that a real
 * ACLED conflict event matches (same rule the UCDP panel uses: within 50 km,
 * 7 days and a similar death toll) is dropped. GDELT fallback records on the
 * ACLED endpoint are never used for this — too imprecise to cancel a UCDP
 * event.
 */
export function combineDensityEvents(feeds: DensityFeeds): GeoEvent[] {
  const acled: AcledDedupEvent[] = [];
  for (const e of feeds.conflicts) {
    if (e.id.startsWith('gdelt')) continue;
    const d = toAcledDedup(e);
    if (d) acled.push(d);
  }
  const ucdp = acled.length === 0 ? feeds.ucdp : feeds.ucdp.filter((u) => !isDuplicatedByAcled({
    latitude: u.latitude,
    longitude: u.longitude,
    dateMs: Date.parse(u.date_start),
    deathsBest: u.deaths_best,
  }, acled));
  // GDELT conflict stands in for ACLED while ACLED has no conflict data (no
  // access, or an outage); with real ACLED events it would double-count them.
  const gdeltConflict = acled.length === 0 ? feeds.gdeltConflict ?? [] : [];
  return [
    ...toGeoEvents(ucdp, fromUcdp),
    ...toGeoEvents(feeds.conflicts, fromConflict),
    ...toGeoEvents(gdeltConflict, fromGdeltConflict),
    ...toGeoEvents(feeds.unrest, fromUnrest),
  ];
}
