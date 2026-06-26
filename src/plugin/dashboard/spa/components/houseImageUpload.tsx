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

import { t } from '../i18n.js';

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
    reader.onerror = (): void => reject(new Error(t('Datei konnte nicht gelesen werden.', 'File could not be read.')));
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
      setStatus({ kind: 'error', message: t('Bitte ein PNG-, JPEG- oder WebP-Bild wählen.', 'Please choose a PNG, JPEG or WebP image.') });
      return;
    }
    if (file.size > MAX_BYTES) {
      setStatus({ kind: 'error', message: t('Bild ist zu groß (max. 8 MB).', 'Image is too large (max. 8 MB).') });
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
        throw new Error(body.message ?? t(`Upload fehlgeschlagen (HTTP ${res.status}).`, `Upload failed (HTTP ${res.status}).`));
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
      <h2 class="house-upload__title">{t('Hausbild', 'House image')}</h2>
      <p class="house-upload__hint">
        {t(
          'Tausche das Hintergrundbild des 3D-Hauses auf dem Dashboard. Empfohlen: transparentes PNG, Querformat (z. B. 1024×480). Die Overlays bleiben unverändert darüber liegen.',
          'Replace the background image of the 3D house on the dashboard. Recommended: transparent PNG, landscape (e.g. 1024×480). The overlays stay unchanged on top.',
        )}
      </p>
      <label class="house-upload__btn" data-testid="house-upload-label">
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          data-testid="house-upload-input"
          onChange={(e): void => void onPick(e)}
        />
        {t('Bild auswählen', 'Choose image')}
      </label>
      {preview !== null && (
        <img class="house-upload__preview" src={preview} alt={t('Vorschau', 'Preview')} />
      )}
      {status.kind === 'uploading' && (
        <p class="house-upload__status" data-testid="house-upload-status">
          {t('Wird hochgeladen …', 'Uploading …')}
        </p>
      )}
      {status.kind === 'ok' && (
        <p class="house-upload__status house-upload__status--ok" data-testid="house-upload-status">
          {t(
            'Gespeichert. Lade das Dashboard neu, um das neue Bild zu sehen.',
            'Saved. Reload the dashboard to see the new image.',
          )}
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
