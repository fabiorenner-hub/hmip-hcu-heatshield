/**
 * Heat Shield — house background image upload (dashboard polish).
 *
 * Lets the user replace the 3D-house background shown on the Beschattung
 * dashboard. The picked file is read as a `data:` URL client-side and posted
 * as JSON to `POST /api/house-image` (no multipart dependency). On success the
 * served `/assets/house/house.png` is overridden by the upload; we bust the
 * image cache by appending a timestamp query the next time the twin mounts.
 */

import { h, type JSX } from 'preact';
import { useState } from 'preact/hooks';

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB picked-file ceiling.

type Status =
  | { kind: 'idle' }
  | { kind: 'uploading' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string };

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => resolve(String(reader.result));
    reader.onerror = (): void => reject(new Error('Datei konnte nicht gelesen werden.'));
    reader.readAsDataURL(file);
  });
}

export function HouseImageUpload(): JSX.Element {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [preview, setPreview] = useState<string | null>(null);

  const onPick = async (ev: Event): Promise<void> => {
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file === undefined) {
      return;
    }
    if (!/^image\/(png|jpeg|jpg|webp)$/.test(file.type)) {
      setStatus({ kind: 'error', message: 'Bitte ein PNG-, JPEG- oder WebP-Bild wählen.' });
      return;
    }
    if (file.size > MAX_BYTES) {
      setStatus({ kind: 'error', message: 'Bild ist zu groß (max. 8 MB).' });
      return;
    }
    try {
      setStatus({ kind: 'uploading' });
      const dataUrl = await readAsDataUrl(file);
      setPreview(dataUrl);
      const res = await fetch('/api/house-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `Upload fehlgeschlagen (HTTP ${res.status}).`);
      }
      setStatus({ kind: 'ok' });
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <section class="house-upload" data-testid="house-upload">
      <h2 class="house-upload__title">Hausbild</h2>
      <p class="house-upload__hint">
        Tausche das Hintergrundbild des 3D-Hauses auf dem Dashboard. Empfohlen:
        transparentes PNG, Querformat (z. B. 1024×480). Die Overlays bleiben
        unverändert darüber liegen.
      </p>
      <label class="house-upload__btn" data-testid="house-upload-label">
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          data-testid="house-upload-input"
          onChange={(e): void => void onPick(e)}
        />
        Bild auswählen
      </label>
      {preview !== null && (
        <img class="house-upload__preview" src={preview} alt="Vorschau" />
      )}
      {status.kind === 'uploading' && (
        <p class="house-upload__status" data-testid="house-upload-status">
          Wird hochgeladen …
        </p>
      )}
      {status.kind === 'ok' && (
        <p class="house-upload__status house-upload__status--ok" data-testid="house-upload-status">
          Gespeichert. Lade das Dashboard neu, um das neue Bild zu sehen.
        </p>
      )}
      {status.kind === 'error' && (
        <p
          class="house-upload__status house-upload__status--error"
          data-testid="house-upload-status"
        >
          {status.message}
        </p>
      )}
    </section>
  );
}
