/**
 * Heat Shield — "Liquid Glass V2" Messages page (lg2-native).
 *
 * Full scope of the v1 `MessagesTab` (tabs/messages.tsx): lists all in-app
 * notifications newest-first, highlights unread entries, refreshes and marks
 * everything read when the page is opened, and shows a per-kind icon + label
 * with a localized timestamp. Rebuilt in a dedicated lg2 layout with its own
 * `lg2-msg-*` classes and only `--lg2-*` tokens; the emoji glyphs of v1 are
 * replaced by the lg2 SVG icon set (family rule: no emoji in the final UI).
 */

import { h, type JSX } from 'preact';
import { useEffect } from 'preact/hooks';

import { useMessages } from '../../hooks/useMessages.js';
import { t, locale } from '../../i18n.js';
import { Icon, type IconName } from '../icons.js';
import type { Message, MessageKind } from '../../types.js';

const KIND_ICON: Record<MessageKind, IconName> = {
  ventilate: 'lueftung',
  open: 'fenster',
  close: 'beschattung',
  weather: 'sonne',
  info: 'logo',
};

const KIND_TONE: Record<MessageKind, string> = {
  ventilate: 'var(--lg2-cyan)',
  open: 'var(--lg2-blue)',
  close: 'var(--lg2-orange)',
  weather: 'var(--lg2-yellow)',
  info: 'var(--lg2-label-2)',
};

function kindLabel(kind: MessageKind): string {
  switch (kind) {
    case 'ventilate':
      return t('Lüften', 'Ventilate');
    case 'open':
      return t('Öffnen', 'Open');
    case 'close':
      return t('Hitzeschutz', 'Heat protection');
    case 'weather':
      return t('Wetter', 'Weather');
    case 'info':
      return t('Info', 'Info');
    default:
      return kind;
  }
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale(), { dateStyle: 'short', timeStyle: 'short' }).format(d);
  } catch {
    return d.toISOString();
  }
}

interface RoutableProps {
  path?: string;
}

export function LiquidGlass2Messages(_props: RoutableProps): JSX.Element {
  const { messages, unread, available, markRead, refresh } = useMessages();

  // On open: refresh, then mark everything read (v1 parity, Requirement 9.3).
  useEffect(() => {
    void (async (): Promise<void> => {
      await refresh();
      await markRead();
    })();
  }, []);

  const list: Message[] = [...messages.value].reverse(); // newest first

  return (
    <main class="lg2-main lg2-msg" data-testid="liquid-glass2-messages">
      <header class="lg2-header">
        <div>
          <h1 class="lg2-header__title">{t('Nachrichten', 'Messages')}</h1>
          <p class="lg2-header__sub">{t('Neueste zuerst', 'Newest first')}</p>
        </div>
        <div class="lg2-header__right">
          <span class="lg2-headbadge lg2-headbadge--ok" data-testid="lg2-msg-unread-count">
            {unread.value > 0
              ? t(`${unread.value} ungelesen`, `${unread.value} unread`)
              : t('Alle gelesen', 'All read')}
          </span>
        </div>
      </header>

      {!available.value && (
        <div class="lg2-card lg2-msg-empty" data-testid="lg2-msg-unavailable">
          {t('Nachrichten sind derzeit nicht verfügbar.', 'Messages are currently unavailable.')}
        </div>
      )}

      {available.value && list.length === 0 && (
        <div class="lg2-card lg2-msg-empty" data-testid="lg2-msg-empty">
          {t('Noch keine Nachrichten.', 'No messages yet.')}
        </div>
      )}

      {list.length > 0 && (
        <ul class="lg2-msg-list" data-testid="lg2-msg-list">
          {list.map((m) => (
            <li
              key={m.id}
              class={`lg2-card lg2-msg-item ${m.read ? 'lg2-msg-item--read' : 'lg2-msg-item--unread'}`}
              data-testid="lg2-msg-item"
              data-read={m.read ? 'true' : 'false'}
            >
              <span class="lg2-msg-item__icon" style={{ color: KIND_TONE[m.kind] }} aria-hidden="true">
                <Icon name={KIND_ICON[m.kind]} size={20} />
              </span>
              <div class="lg2-msg-item__body">
                <div class="lg2-msg-item__top">
                  <span class="lg2-msg-item__title">{m.title}</span>
                  <span class="lg2-msg-item__kind">{kindLabel(m.kind)}</span>
                </div>
                <p class="lg2-msg-item__text">{m.body}</p>
                <time class="lg2-msg-item__ts" dateTime={m.ts}>
                  {formatTimestamp(m.ts)}
                </time>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
