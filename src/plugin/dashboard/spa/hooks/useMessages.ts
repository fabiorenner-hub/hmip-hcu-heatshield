/**
 * In-app messages hook (smart-shading-notifications Task 10).
 *
 * Wraps `GET /api/messages` and `POST /api/messages/read`. The message list
 * and unread count are written into the shared store signals (`messages`,
 * `unreadMessages`) so the header bell and the Messages tab both stay in
 * sync. A fetch is performed on mount and on demand (`refresh`); the bell
 * also refreshes whenever a `message.created` SSE event arrives (wired in
 * `useStream`).
 *
 * When the endpoint returns 503 (boot not wired), the hook degrades quietly:
 * the list stays empty and no error banner is shown.
 */

import { signal, type Signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';

import { messages, unreadMessages } from '../store.js';
import type { Message } from '../types.js';

const loadingSig = signal<boolean>(false);
const availableSig = signal<boolean>(true);

let inFlight: Promise<void> | null = null;

/** Fetch the message list + unread count into the store. */
export async function refreshMessages(): Promise<void> {
  if (inFlight !== null) {
    return inFlight;
  }
  loadingSig.value = true;
  inFlight = (async (): Promise<void> => {
    try {
      const res = await fetch('/api/messages', {
        headers: { Accept: 'application/json' },
      });
      if (res.status === 503) {
        availableSig.value = false;
        return;
      }
      if (!res.ok) {
        return;
      }
      const json = (await res.json()) as { messages: Message[]; unread: number };
      availableSig.value = true;
      messages.value = json.messages;
      unreadMessages.value = json.unread;
    } catch {
      // Quiet degradation — messages are non-critical.
    } finally {
      loadingSig.value = false;
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Mark messages read. With no ids, marks all read. Optimistically updates the
 * store, then reconciles with the server's returned unread count.
 */
export async function markMessagesRead(ids?: readonly string[]): Promise<void> {
  const idSet = ids === undefined ? null : new Set(ids);
  messages.value = messages.value.map((m) =>
    idSet === null || idSet.has(m.id) ? { ...m, read: true } : m,
  );
  unreadMessages.value = messages.value.reduce((n, m) => (m.read ? n : n + 1), 0);
  try {
    const res = await fetch('/api/messages/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ids === undefined ? {} : { ids }),
    });
    if (res.ok) {
      const json = (await res.json()) as { unread: number };
      unreadMessages.value = json.unread;
    }
  } catch {
    // Optimistic update already applied; ignore transport errors.
  }
}

export interface UseMessagesResult {
  messages: Signal<Message[]>;
  unread: Signal<number>;
  loading: Signal<boolean>;
  available: Signal<boolean>;
  refresh: () => Promise<void>;
  markRead: (ids?: readonly string[]) => Promise<void>;
}

export function useMessages(): UseMessagesResult {
  useEffect(() => {
    void refreshMessages();
  }, []);
  return {
    messages,
    unread: unreadMessages,
    loading: loadingSig,
    available: availableSig,
    refresh: refreshMessages,
    markRead: markMessagesRead,
  };
}

/** Test-only reset of module-level signals. */
export function __resetMessagesStateForTests(): void {
  messages.value = [];
  unreadMessages.value = 0;
  loadingSig.value = false;
  availableSig.value = true;
  inFlight = null;
}
