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
interface KasperskyStats {
  source: string;
  sourceUrl: string;
  fetchedAt: string;
  subsystems: Subsystem[];
}

const DEFAULT_SUBSYSTEM = 'OAS';
const COLLAPSED_ROWS = 15;

const regionNames = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; }
})();

function countryName(row: CountryRow): string {
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
        ${this.renderTrend(sub.trend)}
        <div class="kc-section-title">Share of KSN users attacked, by country</div>
        <table class="kc-table"><tbody>${rows}</tbody></table>
        ${toggle}
        ${this.renderTopThreats(sub.topThreats)}
        <div class="kc-footer">
          Source: <a href="${data.sourceUrl}" target="_blank" rel="noopener noreferrer">Kaspersky Cyberthreat Map</a>
          · KSN telemetry, reflects Kaspersky install base
          · updated ${new Date(data.fetchedAt).toLocaleString()}
        </div>
      </div>`);
  }

  private renderTrend(trend: TrendPoint[]): SafeHtml {
    if (trend.length < 2) return safeHtml``;
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
      </div>`;
  }

  private renderTopThreats(threats: TopThreat[]): SafeHtml {
    if (!threats.length) return safeHtml``;
    const items = joinSafeHtml(threats.map(th => safeHtml`
      <li><span class="kc-threat-name">${th.name}</span><span class="kc-threat-pct">${th.pct.toFixed(2)}%</span></li>`));
    return safeHtml`
      <div class="kc-section-title">Top detected threats (global)</div>
      <ol class="kc-threats">${items}</ol>`;
  }
}
