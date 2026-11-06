/**
 * Self-hosted-only notice: the open-source data sources this build pulls from
 * have not been individually vetted one by one yet (that audit is still in
 * progress) — flag it to whoever is standing up their own instance so they
 * don't treat every feed as fully verified. Never shown on the hosted
 * worldmonitor.app product.
 *
 * Blocking full-screen modal in front of the whole dashboard (all panels) —
 * no backdrop-click or Escape dismiss, only the explicit acknowledgment
 * button, so it can't be missed. Shown once per browser: the acknowledgment
 * is kept in localStorage. Change DISMISS_KEY to show it to everyone again
 * (e.g. after the source review changes what the notice says).
 */

import { isSelfHostedPremiumUnlocked } from '@/services/self-hosted-unlock';
import { t } from '@/services/i18n';
import { setTrustedHtml, trustedHtml, getFocusableElements } from '@/utils/dom-utils';

const OVERLAY_ID = 'self-hosted-sources-warning-overlay';
const DISMISS_KEY = 'wm-self-hosted-sources-warning-dismissed';

export function initSelfHostedSourcesWarningBanner(): void {
  if (!isSelfHostedPremiumUnlocked()) return;
  if (document.getElementById(OVERLAY_ID)) return;

  try {
    if (localStorage.getItem(DISMISS_KEY) === '1') return;
  } catch { /* noop */ }

  const lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'wm-shsw-title');
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483000',
    background: 'rgba(0,0,0,0.72)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '20px',
  });

  const modal = document.createElement('div');
  Object.assign(modal.style, {
    background: '#1c1608',
    border: '1px solid #b45309',
    borderRadius: '10px',
    maxWidth: '480px',
    width: '100%',
    padding: '24px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    color: '#fff',
  });

  setTrustedHtml(modal, trustedHtml(`
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <h2 id="wm-shsw-title" style="margin:0;font-size:16px;font-weight:700;color:#f59e0b;">${t('components.selfHostedSourcesWarning.title')}</h2>
    </div>
    <p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:#e5e5e5;">${t('components.selfHostedSourcesWarning.message')}</p>
    <div style="display:flex;justify-content:flex-end;">
      <button id="wm-shsw-ack-btn" style="background:#f59e0b;color:#1c1608;border:none;border-radius:6px;padding:8px 18px;font-weight:700;font-size:14px;cursor:pointer;">${t('components.selfHostedSourcesWarning.acknowledge')}</button>
    </div>
  `, "self-hosted sources warning modal"));

  overlay.appendChild(modal);

  const close = (): void => {
    document.removeEventListener('keydown', onKeydown, true);
    overlay.remove();
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* noop */ }
    lastFocusedElement?.focus?.();
  };

  // No backdrop-click / Escape dismiss — acknowledgment is mandatory. Tab is
  // still trapped inside the modal so focus can't leak to the dashboard
  // behind it while it's up.
  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    const focusable = getFocusableElements(overlay);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (!focusable.includes(active as HTMLElement)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKeydown, true);

  document.body.appendChild(overlay);
  modal.querySelector('#wm-shsw-ack-btn')?.addEventListener('click', close);
  requestAnimationFrame(() => {
    modal.querySelector<HTMLElement>('#wm-shsw-ack-btn')?.focus();
  });
}