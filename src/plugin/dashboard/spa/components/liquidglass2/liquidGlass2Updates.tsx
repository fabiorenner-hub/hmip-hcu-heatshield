/**
 * Heat Shield — "Liquid Glass V2" Updates page (lg2-native).
 *
 * Full scope of the v1 `UpdatesTab` (tabs/updates.tsx) in a dedicated lg2
 * layout: the running version/build, the client-side GitHub update check
 * (`useUpdateCheck`) and the human-readable changelog. The changelog is the
 * single source of truth exported from the v1 tab (`getChangelog`) — no data
 * duplication, no function loss. Only `--lg2-*` tokens, own `lg2-upd-*`
 * classes.
 */

import { h, type JSX } from 'preact';

import { APP_VERSION } from '../../version.js';
import { useDiscovery } from '../../hooks/useDiscovery.js';
import { useUpdateCheck, GITHUB_URL, GITHUB_RELEASES_URL } from '../../hooks/useUpdateCheck.js';
import { getChangelog } from '../../tabs/updates.js';
import { t } from '../../i18n.js';
import { Icon } from '../icons.js';

interface RoutableProps {
  path?: string;
}

export function LiquidGlass2Updates(_props: RoutableProps): JSX.Element {
  const discovery = useDiscovery();
  const build = discovery.pluginBuild.value;
  const upd = useUpdateCheck();
  const info = upd.value;

  return (
    <main class="lg2-main lg2-upd" data-testid="liquid-glass2-updates">
      <header class="lg2-header">
        <div>
          <h1 class="lg2-header__title">{t('Updates', 'Updates')}</h1>
          <p class="lg2-header__sub">{t('Version, Build und Changelog', 'Version, build and changelog')}</p>
        </div>
        <div class="lg2-header__right">
          <span class="lg2-headbadge lg2-headbadge--ok">v{APP_VERSION}</span>
        </div>
      </header>

      <section class="lg2-card lg2-upd-version" data-testid="lg2-upd-version">
        <div class="lg2-upd-version__main">
          <span class="lg2-upd-version__label">{t('Aktuelle Version', 'Current version')}</span>
          <span class="lg2-upd-version__value">v{APP_VERSION}</span>
          {build !== null && (
            <span class="lg2-upd-version__build">
              {t('Build', 'Build')} <code>{build}</code>
            </span>
          )}
        </div>
        <p class="lg2-upd-version__hint">
          {t(
            'Neue Builds lädst du in HCUweb hoch; diese Version-Nummer und die Build-Kennung helfen beim Abgleich.',
            'You upload new builds in HCUweb; this version number and the build identifier help with matching.',
          )}
        </p>
      </section>

      {info.updateAvailable ? (
        <section class="lg2-card lg2-upd-banner lg2-upd-banner--new" data-testid="lg2-upd-available">
          <h3 class="lg2-upd-banner__title">
            <Icon name="forecast" size={18} />
            {t(`Update verfügbar: v${info.latest}`, `Update available: v${info.latest}`)}
          </h3>
          <p class="lg2-upd-banner__hint">
            {t(
              `Auf GitHub ist eine neuere Version als deine installierte (v${APP_VERSION}). Lade das .tar.gz aus dem Release und installiere es in HCUweb.`,
              `A newer version than your installed one (v${APP_VERSION}) is available on GitHub. Download the .tar.gz from the release and install it in HCUweb.`,
            )}
          </p>
          <a class="lg2-upd-btn" href={info.url} target="_blank" rel="noopener noreferrer">
            {t(`Release v${info.latest} öffnen`, `Open release v${info.latest}`)}
          </a>
        </section>
      ) : (
        <section class="lg2-card lg2-upd-banner" data-testid="lg2-upd-current">
          <h3 class="lg2-upd-banner__title">
            <Icon name="logo" size={18} />
            {info.checked
              ? t('Du nutzt die neueste Version.', 'You are using the latest version.')
              : t('Prüfe auf Updates…', 'Checking for updates…')}
          </h3>
          <p class="lg2-upd-banner__hint">
            {t('Quelle & Releases auf GitHub:', 'Source & releases on GitHub:')}{' '}
            <a href={GITHUB_RELEASES_URL} target="_blank" rel="noopener noreferrer">
              {GITHUB_URL}
            </a>
          </p>
        </section>
      )}

      <ol class="lg2-upd-list" data-testid="lg2-upd-list">
        {getChangelog().map((e) => (
          <li key={e.version} class="lg2-upd-entry">
            <h2 class="lg2-upd-entry__ver">v{e.version}</h2>
            <ul class="lg2-upd-entry__items">
              {e.items.map((it, i) => (
                <li key={i}>{it}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </main>
  );
}
