/**
 * Heat Shield — message store (smart-shading-notifications Task 7.1).
 *
 * Persists resident notifications append-only at `/data/messages.ndjson` and
 * exposes the small surface the dashboard + notification service need:
 * `append`, `list`, `markRead`, `unreadCount`. Messages survive a restart
 * (Requirement 9.4).
 *
 * The store keeps the full message list in memory (notification volume is
 * low — a handful per day) and mirrors writes to disk:
 *
 *   - `append` adds one NDJSON line (cheap, append-only).
 *   - `markRead` flips the `read` flag in memory and rewrites the whole file
 *     atomically (a torn append-only "read marker" stream would be harder to
 *     reason about than a single compacted rewrite).
 *
 * Reads are defensive: malformed or schema-invalid lines are skipped so one
 * bad line never sinks the whole history (design §Error Handling).
 *
 * No engine logic; the {@link MessageStore} is a plain persistence component.
 */

import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

import { safeParseMessage, type Message } from '../../shared/message-schema.js';

export const DEFAULT_MESSAGES_PATH = '/data/messages.ndjson';

export interface MessageStoreOptions {
  messagesPath?: string;
  /** Optional cap on retained messages (newest kept). Default 500. */
  maxMessages?: number;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    typeof (err as NodeJS.ErrnoException).code === 'string'
  );
}

async function readAllLines(filePath: string): Promise<Message[]> {
  try {
    await fs.stat(filePath);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const out: Message[] = [];
  try {
    for await (const line of rl) {
      if (line.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const res = safeParseMessage(parsed);
      if (res.success) {
        out.push(res.data);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return out;
}

async function atomicWriteText(filePath: string, body: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  let consumed = false;
  try {
    await fs.writeFile(tempPath, body, 'utf8');
    const transientCodes: ReadonlySet<string> = new Set([
      'EPERM',
      'EACCES',
      'EEXIST',
      'EBUSY',
    ]);
    const maxAttempts = 8;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        await fs.rename(tempPath, filePath);
        consumed = true;
        break;
      } catch (err) {
        if (
          attempt + 1 < maxAttempts &&
          isErrnoException(err) &&
          transientCodes.has(err.code ?? '')
        ) {
          await new Promise((resolve) => setTimeout(resolve, 25 + attempt * 25));
          continue;
        }
        throw err;
      }
    }
  } finally {
    if (!consumed) {
      try {
        await fs.unlink(tempPath);
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * In-memory + NDJSON-backed message store. Construct, then `await load()`
 * once on boot to rehydrate; thereafter use `append` / `markRead` / `list` /
 * `unreadCount`.
 */
export class MessageStore {
  private readonly messagesPath: string;

  private readonly maxMessages: number;

  private messages: Message[] = [];

  private loaded = false;

  constructor(options?: MessageStoreOptions) {
    this.messagesPath = options?.messagesPath ?? DEFAULT_MESSAGES_PATH;
    this.maxMessages = options?.maxMessages ?? 500;
  }

  /** Rehydrate from disk. Idempotent; safe to call once on boot. */
  async load(): Promise<void> {
    this.messages = await readAllLines(this.messagesPath);
    // Keep only the newest `maxMessages` in memory (chronological order on disk).
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }
    this.loaded = true;
  }

  /** Append a message (in-memory + NDJSON line). Returns the stored message. */
  async append(message: Message): Promise<Message> {
    this.messages.push(message);
    if (this.messages.length > this.maxMessages) {
      // Trim memory; the file is compacted on the next markRead. We avoid a
      // rewrite on every append to keep the hot path append-only.
      this.messages = this.messages.slice(-this.maxMessages);
    }
    await fs.mkdir(path.dirname(this.messagesPath), { recursive: true });
    await fs.appendFile(this.messagesPath, `${JSON.stringify(message)}\n`, 'utf8');
    return message;
  }

  /** All messages, oldest first (chronological). Returns a copy. */
  list(): Message[] {
    return [...this.messages];
  }

  /** Number of unread messages. */
  unreadCount(): number {
    let n = 0;
    for (const m of this.messages) {
      if (!m.read) {
        n += 1;
      }
    }
    return n;
  }

  /**
   * Mark messages as read. With no ids, marks every message read. Rewrites
   * the file atomically with the updated flags. Returns the new unread count.
   */
  async markRead(ids?: readonly string[]): Promise<number> {
    const idSet = ids === undefined ? null : new Set(ids);
    let changed = false;
    this.messages = this.messages.map((m) => {
      if ((idSet === null || idSet.has(m.id)) && !m.read) {
        changed = true;
        return { ...m, read: true };
      }
      return m;
    });
    if (changed) {
      const body =
        this.messages.length === 0
          ? ''
          : `${this.messages.map((m) => JSON.stringify(m)).join('\n')}\n`;
      await atomicWriteText(this.messagesPath, body);
    }
    return this.unreadCount();
  }

  /** Whether `load()` has been called. */
  isLoaded(): boolean {
    return this.loaded;
  }
}
