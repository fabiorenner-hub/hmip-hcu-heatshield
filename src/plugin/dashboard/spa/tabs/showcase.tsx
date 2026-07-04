/**
 * Design-system showcase (premium-ui-rework T-02). A dev route that renders the
 * semantic primitives and tokens in one place for visual QA. Reachable at
 * `/showcase`; surfaced in the UI only when the `premiumUiV2` dev flag is on
 * (see `appearance.tsx`), but the route itself always resolves so it can be
 * opened directly. Uses only existing token-driven classes — no new styling.
 */

import { h, type JSX } from 'preact';

import { t } from '../i18n.js';
import { getFlag } from '../featureFlags.js';

interface RoutableProps {
  path?: string;
}

const SURFACE_TOKENS = ['--hs-bg-0', '--hs-bg-1', '--hs-surface-1', '--hs-surface-2', '--hs-border'];
const ACCENT_TOKENS = ['--hs-amber', '--hs-amber-soft', '--hs-cyan', '--hs-blue', '--hs-green', '--hs-red', '--hs-violet'];

function Swatch(props: { token: string }): JSX.Element {
  return (
    <div class="showcase__swatch">
      <span class="showcase__swatch-chip" style={{ background: `var(${props.token})` }} />
      <code>{props.token}</code>
    </div>
  );
}

export function ShowcaseView(_props: RoutableProps): JSX.Element {
  const flagOn = getFlag('premiumUiV2');
  return (
    <section class="module-panel" data-testid="tab-showcase">
      <div class="module-panel__head">
        <h1>{t('Design-System', 'Design system')}</h1>
        <span class="module-panel__badge">{flagOn ? t('Premium aktiv', 'Premium on') : t('Vorschau', 'Preview')}</span>
      </div>
      <p class="module-panel__hint">
        {t(
          'Referenzseite für Tokens und Bausteine (Design-QA). Nur über den Premium-Schalter sichtbar.',
          'Reference page for tokens and primitives (design QA). Surfaced via the Premium toggle.',
        )}
      </p>

      <div class="module-panel__card" data-testid="showcase-surfaces">
        <h3>{t('Flächen', 'Surfaces')}</h3>
        <div class="showcase__swatches">{SURFACE_TOKENS.map((tk) => <Swatch key={tk} token={tk} />)}</div>
      </div>

      <div class="module-panel__card" data-testid="showcase-accents">
        <h3>{t('Akzente & Status', 'Accents & status')}</h3>
        <div class="showcase__swatches">{ACCENT_TOKENS.map((tk) => <Swatch key={tk} token={tk} />)}</div>
      </div>

      <div class="module-panel__card" data-testid="showcase-primitives">
        <h3>{t('Bausteine', 'Primitives')}</h3>
        <div class="showcase__row">
          <span class="hs-chip">Chip</span>
          <span class="hs-chip hs-chip--expert">Expert</span>
          <span class="hs-dot hs-dot--ok"><span class="hs-dot__mark" /><span class="hs-dot__label">ok</span></span>
          <span class="hs-dot hs-dot--warm"><span class="hs-dot__mark" /><span class="hs-dot__label">warm</span></span>
          <span class="hs-dot hs-dot--hot"><span class="hs-dot__mark" /><span class="hs-dot__label">hot</span></span>
        </div>
        <div class="showcase__row seg" role="group">
          <button type="button" class="seg__btn seg__btn--active">AUTO</button>
          <button type="button" class="seg__btn">DE</button>
          <button type="button" class="seg__btn">EN</button>
        </div>
      </div>
    </section>
  );
}
