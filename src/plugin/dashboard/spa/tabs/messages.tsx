/**
 * Messages tab (smart-shading-notifications Task 10.3).
 *
 * Lists all in-app notifications newest-first, highlights unread entries, and
 * marks everything read when the tab is opened (Requirement 9.3). Each row
 * shows a kind icon, title, body and a localized timestamp.
 */

import { h, type JSX } from 'preact';
import { useEffect } from 'preact/hooks';

import { useMessages } from '../hooks/useMessages.js';
import { t, locale } from '../i18n.js';
import type { Message, MessageKind } from '../types.js';

const KIND_ICON: Record<MessageKind, string> = {
  ventilate: '🪟',
  open: '⬆',
  close: '🛡',
  weather: '☀︎',
  info: 'ℹ',
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
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  try {
    return new Intl.DateTimeFormat(locale(), {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

export interface MessagesTabProps {
  /** preact-router passes `path`; unused but accepted. */
  path?: string;
}

export function MessagesTab(_props: MessagesTabProps): JSX.Element {
  const { messages, unread, available, markRead, refresh } = useMessages();

  // On open: refresh, then mark everything read (Requirement 9.3).
  useEffect(() => {
    void (async (): Promise<void> => {
      await refresh();
      await markRead();
    })();
  }, []);

  const list: Message[] = [...messages.value].reverse(); // newest first

  return (
    <section class="tab tab--messages" data-testid="tab-messages">
      <header class="tab__header">
        <h2 class="tab__title">{t('Nachrichten', 'Messages')}</h2>
        <span class="tab__subtitle" data-testid="messages-unread-count">
          {unread.value > 0
            ? t(`${unread.value} ungelesen`, `${unread.value} unread`)
            : t('Alle gelesen', 'All read')}
        </span>
      </header>

      {!available.value && (
        <p class="empty" data-testid="messages-unavailable">
          {t('Nachrichten sind derzeit nicht verfügbar.', 'Messages are currently unavailable.')}
        </p>
      )}

      {available.value && list.length === 0 && (
        <p class="empty" data-testid="messages-empty">
          {t('Noch keine Nachrichten.', 'No messages yet.')}
        </p>
      )}

      <ul class="message-list" data-testid="message-list">
        {list.map((m) => (
          <li
            key={m.id}
            class={`message-item ${m.read ? 'message-item--read' : 'message-item--unread'}`}
            data-testid="message-item"
            data-read={m.read ? 'true' : 'false'}
          >
            <span class="message-item__icon" aria-hidden="true">
              {KIND_ICON[m.kind]}
            </span>
            <div class="message-item__body">
              <div class="message-item__top">
                <span class="message-item__title">{m.title}</span>
                <span class="message-item__kind">{kindLabel(m.kind)}</span>
              </div>
              <p class="message-item__text">{m.body}</p>
              <time class="message-item__ts" dateTime={m.ts}>
                {formatTimestamp(m.ts)}
              </time>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
