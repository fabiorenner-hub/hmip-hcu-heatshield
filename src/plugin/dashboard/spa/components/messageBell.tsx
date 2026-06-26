/**
 * Header envelope bell with unread badge
 * (smart-shading-notifications Task 10.2).
 *
 * Shows an envelope icon in the app header. When there are unread messages it
 * overlays a small badge with the count; with zero unread the badge is hidden
 * (Requirement 10.3). Activating the bell navigates to the Messages tab
 * (Requirement 10.4).
 *
 * Pure presentational component: the unread count is read from the shared
 * `unreadMessages` signal by the caller and passed in as a prop so the bell
 * stays trivially testable.
 */

import { h, type JSX } from 'preact';

import { t } from '../i18n.js';

export interface MessageBellProps {
  /** Number of unread messages. */
  unread: number;
  /** Navigate to the Messages tab when the bell is activated. */
  onActivate: () => void;
}

export function MessageBell(props: MessageBellProps): JSX.Element {
  const hasUnread = props.unread > 0;
  const label = hasUnread
    ? t(`Nachrichten – ${props.unread} ungelesen`, `Messages – ${props.unread} unread`)
    : t('Nachrichten', 'Messages');
  return (
    <button
      type="button"
      class="message-bell"
      data-testid="message-bell"
      aria-label={label}
      title={label}
      onClick={(): void => props.onActivate()}
    >
      <span class="message-bell__icon" aria-hidden="true">
        ✉
      </span>
      {hasUnread && (
        <span class="message-bell__badge" data-testid="message-bell-badge">
          {props.unread > 99 ? '99+' : String(props.unread)}
        </span>
      )}
    </button>
  );
}
