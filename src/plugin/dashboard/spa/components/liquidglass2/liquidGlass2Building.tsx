/**
 * Heat Shield — "Liquid Glass V2" Building Studio page (route `/building`).
 *
 * A thin, SAFE native-v2 wrapper around the existing v1 floor-plan / 3D editor
 * (`BuildingStudioView`, `../../tabs/buildingStudio.js`). The goal is to give
 * the `/building` route a proper Liquid-Glass-V2 page — an `lg2-main` shell
 * with a real `lg2-header` — WITHOUT routing through the generic `lg2-fallback`
 * wrapper and WITHOUT rewriting the (complex, interactive) editor.
 *
 * The existing editor is rendered verbatim inside an `lg2-building__inner`
 * container below the header. It keeps rendering its own internal panels and
 * retains ALL of its functionality; this file only supplies the native-v2 page
 * chrome around it.
 */

import { h, type JSX } from 'preact';

import { t } from '../../i18n.js';
import { BuildingStudioView } from '../../tabs/buildingStudio.js';

interface RoutableProps {
  path?: string;
}

export function LiquidGlass2Building(_props: RoutableProps): JSX.Element {
  return (
    <main class="lg2-main lg2-building" data-testid="liquid-glass2-building">
      <header class="lg2-header">
        <div>
          <h1 class="lg2-header__title">{t('Gebäude-Studio', 'Building Studio')}</h1>
          <p class="lg2-header__sub">
            {t(
              'Grundriss und 3D-Modell des Gebäudes bearbeiten',
              'Edit the building floor plan and 3D model',
            )}
          </p>
        </div>
      </header>

      <div class="lg2-building__inner">
        <BuildingStudioView />
      </div>
    </main>
  );
}
