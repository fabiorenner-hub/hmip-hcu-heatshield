// @vitest-environment jsdom
/**
 * Design-system showcase (premium-ui-rework T-02). Renders the primitives page
 * and asserts the token swatches + primitive blocks appear.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { ShowcaseView } from '../../src/plugin/dashboard/spa/tabs/showcase.js';

afterEach(cleanup);

describe('ShowcaseView', () => {
  it('renders the token swatches and primitive blocks', () => {
    const { container } = render(<ShowcaseView />);
    expect(container.querySelector('[data-testid="tab-showcase"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="showcase-surfaces"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="showcase-accents"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="showcase-primitives"]')).not.toBeNull();
    // Accent swatches include the amber token.
    const codes = Array.from(container.querySelectorAll('code')).map((c) => c.textContent);
    expect(codes).toContain('--hs-amber');
    // Primitive chips + status dots render.
    expect(container.querySelectorAll('.hs-chip').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelectorAll('.hs-dot').length).toBeGreaterThanOrEqual(3);
  });
});
