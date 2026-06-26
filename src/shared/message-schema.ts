/**
 * Heat Shield — notification message schema
 * (smart-shading-notifications Task 7.1).
 *
 * Messages are the resident-facing notifications the plugin emits (ventilate,
 * open, close, weather brief, info). They are persisted append-only as
 * `/data/messages.ndjson` and surfaced both in the dashboard Messages tab and
 * (optionally) via Telegram. The schema lives in `shared/` next to the other
 * Zod schemas so the persistence + dashboard layers share one source of truth.
 *
 * Field naming follows the English-identifier convention; the human-readable
 * `title` / `body` are German (resident-facing copy).
 */

import { z } from 'zod';

/**
 * Message kind. Drives the icon/colour in the dashboard and the prefix in the
 * Telegram text.
 *
 *   - `ventilate` — "jetzt lüften" suggestion.
 *   - `open`      — open a window/shutter suggestion.
 *   - `close`     — close suggestion.
 *   - `weather`   — daily morning weather brief.
 *   - `info`      — generic informational message.
 */
export const MessageKindSchema = z.enum([
  'ventilate',
  'open',
  'close',
  'weather',
  'info',
]);

export const MessageSchema = z.object({
  id: z.string().min(1),
  ts: z.iso.datetime(),
  kind: MessageKindSchema,
  title: z.string().min(1),
  body: z.string(),
  read: z.boolean(),
});

export type MessageKind = z.infer<typeof MessageKindSchema>;
export type Message = z.infer<typeof MessageSchema>;

/** Non-throwing validator used when reading NDJSON lines defensively. */
export function safeParseMessage(input: unknown): z.ZodSafeParseResult<Message> {
  return MessageSchema.safeParse(input);
}
