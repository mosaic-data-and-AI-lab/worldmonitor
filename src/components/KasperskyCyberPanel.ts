import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { joinSafeHtml, safeHtml, type SafeHtml } from '@/utils/sanitize';
import { ensureHydrated } from '@/services/bootstrap';

// Payload written by scripts/seed-kaspersky-cybermap.mjs.
interface CountryRow { iso2: string; iso3: string; pct: number; rank: number }
interface TrendPoint { date: string; count: number }
interface TopThreat { name: string; pct: number }
interface Subsystem {
  id: string;
  label: string;
  countries: CountryRow[];
  trend: TrendPoint[];
  topThreats: TopThreat[];
}
interface DailyCountry { iso2: string; iso3: string; count: number }
interface DailyTotals {
  publishedAt: string | null;
  byType: Record<string, number>;
  topCountries: DailyCountry[];
}
interface KasperskyStats {
  source: string;
  sourceUrl: string;
  fetchedAt: string;
  subsystems: Subsystem[];
  // Absent from payloads written before the daily totals were added.
  daily?: DailyTotals | null;
}

const DEFAULT_SUBSYSTEM = 'OAS';
const COLLAPSED_ROWS = 15;
const DAILY_TOP_ROWS = 5;
const THREAT_URL = 'https://threats.kaspersky.com/en/threat/';

const regionNames = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; }
})();

function countryName(row: { iso2: string; iso3: string }): string {
  if (!row.iso2) return row.iso3;
  try { return regionNames?.of(row.iso2) ?? row.iso3; } catch { return row.iso3; }
}

function flag(iso2: string): string {
  if (!/^[A-Z]{2}$/.test(iso2)) return '';
  return String.fromCodePoint(...[...iso2].map(c => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function compact(n: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export class KasperskyCyberPanel extends Panel {
  private data: KasperskyStats | null = null;
  private subsystemId = DEFAULT_SUBSYSTEM;
  private expanded = false;

  constructor() {
    super({ id: 'kaspersky-cyber', title: t('panels.kasperskyCyber'), infoTooltip: t('components.kasperskyCyber.infoTooltip') });
    this.content.addEventListener('change', (e) => {
      const target = e.target as HTMLElement;
      if (target instanceof HTMLSelectElement && target.classList.contains('kc-subsystem')) {
        this.subsystemId = target.value;
        this.render();
      }
    });
    this.content.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.kc-toggle')) {
        this.expanded = !this.expanded;
        this.render();
      }
    });
  }

  public async fetchData(): Promise<void> {
    try {
      const data = await ensureHydrated('kasperskyCyberStats') as KasperskyStats | undefined;
      if (!this.element?.isConnected) return;
      if (!data?.subsystems?.some(s => s.countries?.length)) {
        this.showError(t('common.noData'), () => void this.fetchData());
        return;
      }
      this.data = data;
      if (!data.subsystems.some(s => s.id === this.subsystemId)) this.subsystemId = data.subsystems[0]!.id;
      this.render();
    } catch (err) {
      if (this.isAbortError(err)) return;
      if (!this.element?.isConnected) return;
      this.showError(t('common.noData'), () => void this.fetchData());
    }
  }

  private render(): void {
    const data = this.data;
    if (!data) return;
    const sub = data.subsystems.find(s => s.id === this.subsystemId) ?? data.subsystems[0]!;

    const options = joinSafeHtml(data.subsystems
      .filter(s => s.countries.length)
      .map(s => s.id === sub.id
        ? safeHtml`<option value="${s.id}" selected>${s.label}</option>`
        : safeHtml`<option value="${s.id}">${s.label}</option>`));

    const visible = this.expanded ? sub.countries : sub.countries.slice(0, COLLAPSED_ROWS);
    const max = sub.countries[0]?.pct || 1;
    const rows = joinSafeHtml(visible.map(c => safeHtml`
      <tr>
        <td class="kc-rank">${c.rank}</td>
        <td class="kc-country">${flag(c.iso2)} ${countryName(c)}</td>
        <td class="kc-bar-cell"><span class="kc-bar" style="width:${Math.max(2, Math.round((c.pct / max) * 100))}%"></span></td>
        <td class="kc-pct">${c.pct.toFixed(2)}%</td>
      </tr>`));
    const toggle = sub.countries.length > COLLAPSED_ROWS
      ? safeHtml`<button type="button" class="kc-toggle">${this.expanded ? 'Show top 15' : `Show all ${sub.countries.length}`}</button>`
      : safeHtml``;

    this.setCount(sub.countries.length);
    this.setSafeContent(safeHtml`
      <div class="kc-wrapper">
        <div class="kc-controls">
          <select class="kc-subsystem" aria-label="Detection type">${options}</select>
          <span class="kc-period">last 7 days</span>
        </div>
        ${this.renderTrend(sub.trend, data.daily?.byType[sub.id], data.daily?.publishedAt ?? null)}
        <div class="kc-section-title">Share of KSN users attacked, by country</div>
        <table class="kc-table"><tbody>${rows}</tbody></table>
        ${toggle}
        ${this.renderMostDetections(data.daily)}
        ${this.renderTopThreats(sub.topThreats)}
        <div class="kc-footer">
          Source: <a href="${data.sourceUrl}" target="_blank" rel="noopener noreferrer">Kaspersky Cyberthreat Map</a>
          · KSN telemetry, reflects Kaspersky install base; Kaspersky does not publish the US or Taiwan
          · updated ${new Date(data.fetchedAt).toLocaleString()}
        </div>
      </div>`);
  }

  private renderTrend(trend: TrendPoint[], dayTotal: number | undefined, publishedAt: string | null): SafeHtml {
    // Kaspersky's own "detections per second" chart replays a sampled
    // animation loop, so the honest equivalent is one day's total spread
    // over 86,400 seconds. Kaspersky publishes that day a day or two late.
    const published = publishedAt ? ` (published ${new Date(publishedAt).toLocaleDateString()})` : '';
    const daily = dayTotal
      ? safeHtml`<div class="kc-daily">Daily snapshot${published}: <strong>${compact(dayTotal)}</strong> detections · avg <strong>${Math.round(dayTotal / 86_400).toLocaleString()}</strong>/sec</div>`
      : safeHtml``;
    if (trend.length < 2) return daily;
    const max = Math.max(...trend.map(p => p.count)) || 1;
    const first = trend[0]!.count;
    const last = trend[trend.length - 1]!.count;
    const change = first ? ((last - first) / first) * 100 : 0;
    const cls = change > 0 ? 'kc-up' : 'kc-down';
    const bars = joinSafeHtml(trend.map(p => safeHtml`
      <div class="kc-spark-col" title="${p.date}: ${p.count.toLocaleString()}">
        <span class="kc-spark-track"><span class="kc-spark-bar" style="height:${Math.max(4, Math.round((p.count / max) * 100))}%"></span></span>
        <span class="kc-spark-label">${p.date.replace(/^[A-Za-z]+-/, '')}</span>
      </div>`));
    return safeHtml`
      <div class="kc-trend">
        <div class="kc-trend-head">
          <span>Global detections/day: <strong>${compact(last)}</strong></span>
          <span class="${cls}">${change >= 0 ? '▲' : '▼'}${Math.abs(change).toFixed(1)}% over 7d</span>
        </div>
        <div class="kc-spark">${bars}</div>
        ${daily}
      </div>`;
  }

  // Mirrors the live map's "Most infected today": raw detection volume
  // across all subsystems, so it tracks where Kaspersky has the most users.
  private renderMostDetections(daily: DailyTotals | null | undefined): SafeHtml {
    const top = daily?.topCountries.slice(0, DAILY_TOP_ROWS) ?? [];
    if (!top.length) return safeHtml``;
    const max = top[0]!.count || 1;
    const rows = joinSafeHtml(top.map((c, i) => safeHtml`
      <tr>
        <td class="kc-rank">${i + 1}</td>
        <td class="kc-country">${flag(c.iso2)} ${countryName(c)}</td>
        <td class="kc-bar-cell"><span class="kc-bar kc-bar-volume" style="width:${Math.max(2, Math.round((c.count / max) * 100))}%"></span></td>
        <td class="kc-pct">${compact(c.count)}</td>
      </tr>`));
    return safeHtml`
      <div class="kc-section-title">Most detections, daily snapshot (all types)</div>
      <table class="kc-table"><tbody>${rows}</tbody></table>
      <div class="kc-note">Raw counts, so countries with many Kaspersky users rank high.</div>`;
  }

  private renderTopThreats(threats: TopThreat[]): SafeHtml {
    if (!threats.length) return safeHtml``;
    const items = joinSafeHtml(threats.map(th => safeHtml`
      <li><a class="kc-threat-name" href="${THREAT_URL}${encodeURIComponent(th.name)}" target="_blank" rel="noopener noreferrer" title="Open in Kaspersky Threats">${th.name}</a><span class="kc-threat-pct">${th.pct.toFixed(2)}%</span></li>`));
    return safeHtml`
      <div class="kc-section-title">Top detected threats (global)</div>
      <ol class="kc-threats">${items}</ol>`;
  }
}
