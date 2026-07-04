// @vitest-environment jsdom
/**
 * Premium desktop/tablet shell toggle (Gate 2 G2.2).
 *
 * Verifies the `app--premium` root class is applied only when the
 * `premiumUiV2` flag is on (jsdom default width 1024 = tablet-up), and absent
 * by default — so the shipped shell is unaffected while the flag is off.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { App } from '../../src/plugin/dashboard/spa/app.js';
import { setFlag } from '../../src/plugin/dashboard/spa/featureFlags.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';

afterEach(() => {
  cleanup();
  snapshot.value = null;
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe('premium shell toggle', () => {
  it('is OFF by default (no app--premium class)', () => {
    const { container } = render(<App initialUrl="/beschattung" />);
    const root = container.querySelector('.app');
    expect(root).not.toBeNull();
    expect(root!.classList.contains('app--premium')).toBe(false);
  });

  it('is ON when premiumUiV2 flag is set (tablet-up width)', () => {
    setFlag('premiumUiV2', true);
    const { container } = render(<App initialUrl="/beschattung" />);
    const root = container.querySelector('.app');
    expect(root!.classList.contains('app--premium')).toBe(true);
  });
});
