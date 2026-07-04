// @vitest-environment jsdom
/**
 * Liquid Glass V2 theme system — palette, import/export and custom-preset
 * over-save (added for the appearance-configurator round).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_PALETTE,
  DEFAULT_THEME,
  applyPreset,
  customPresets,
  exportThemeJson,
  importThemeJson,
  saveCurrentAsPreset,
  theme,
  themeStyle,
  tweak,
  updateCustomPreset,
} from '../../src/plugin/dashboard/spa/components/liquidglass2/shell/lg2Theme.js';

beforeEach(() => {
  localStorage.clear();
  applyPreset('glass');
  customPresets.value = [];
});
afterEach(() => localStorage.clear());

describe('themeStyle — configurable palette tokens', () => {
  it('emits the palette colours as --lg2 semantic tokens', () => {
    tweak({ palette: { success: '#112233', warning: '#445566', danger: '#778899', info: '#aabbcc' } });
    const { style } = themeStyle(theme.value, theme.value.accent);
    expect(style['--lg2-green']).toBe('#112233');
    expect(style['--lg2-yellow']).toBe('#445566');
    expect(style['--lg2-red']).toBe('#778899');
    expect(style['--lg2-blue']).toBe('#aabbcc');
    // RGB variant stays in sync for tints.
    expect(style['--lg2-green-rgb']).toBe('17, 34, 51');
  });

  it('defaults to the Apple palette', () => {
    const { style } = themeStyle(DEFAULT_THEME, DEFAULT_THEME.accent);
    expect(style['--lg2-green']).toBe(DEFAULT_PALETTE.success);
    expect(style['--lg2-red']).toBe(DEFAULT_PALETTE.danger);
  });
});

describe('export / import', () => {
  it('round-trips the current theme through JSON', () => {
    tweak({ accent: '#123456', accentAuto: false, gap: 21 });
    const json = exportThemeJson();
    const parsed = JSON.parse(json) as { kind: string; theme: { accent: string; gap: number } };
    expect(parsed.kind).toBe('heatshield.lg2.theme');
    expect(parsed.theme.accent).toBe('#123456');

    applyPreset('glass'); // change away
    expect(theme.value.gap).not.toBe(21);

    const res = importThemeJson(json);
    expect(res.ok).toBe(true);
    expect(theme.value.accent).toBe('#123456');
    expect(theme.value.gap).toBe(21);
    expect(theme.value.preset).toBe('custom');
  });

  it('accepts a bare theme object and fills missing fields defensively', () => {
    const res = importThemeJson(JSON.stringify({ accent: '#0a84ff' }));
    expect(res.ok).toBe(true);
    expect(theme.value.accent).toBe('#0a84ff');
    // Missing palette/background are backfilled from the defaults.
    expect(theme.value.palette).toEqual(DEFAULT_PALETTE);
    expect(theme.value.background).toBeDefined();
  });

  it('rejects invalid JSON and non-theme objects', () => {
    expect(importThemeJson('{ not json').ok).toBe(false);
    expect(importThemeJson('42').ok).toBe(false);
    expect(importThemeJson(JSON.stringify({ hello: 'world' })).ok).toBe(false);
  });
});

describe('custom preset over-save', () => {
  it('keeps the custom id active while editing, then overwrites in place', () => {
    tweak({ accent: '#ff0000', accentAuto: false });
    saveCurrentAsPreset('Mine');
    const id = customPresets.value[0]!.id;
    expect(theme.value.preset).toBe(id);

    // Editing a saved custom keeps its id (so it can be over-saved).
    tweak({ gap: 25 });
    expect(theme.value.preset).toBe(id);
    // Stored copy is still the old one until we overwrite.
    expect(customPresets.value[0]!.theme.gap).not.toBe(25);

    updateCustomPreset(id);
    expect(customPresets.value[0]!.theme.gap).toBe(25);
    expect(customPresets.value[0]!.name).toBe('Mine');
  });

  it('editing a built-in preset detaches to "custom"', () => {
    applyPreset('glass');
    tweak({ gap: 24 });
    expect(theme.value.preset).toBe('custom');
  });
});
