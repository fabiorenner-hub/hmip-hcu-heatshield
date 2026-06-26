// @vitest-environment jsdom
/**
 * Regression test for the DiscoveryStatus banner.
 *
 * Guards against the JSX-factory shadowing bug: a `.map((h) => …)`
 * callback whose parameter was named `h` shadowed Preact's `h`
 * factory, so rendering the histogram crashed with "h is not a
 * function" (minified: "l is not a function"). This test renders the
 * banner with a populated histogram + temperature sources and
 * asserts it mounts without throwing.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { DiscoveryStatus } from '../../src/plugin/dashboard/spa/components/discoveryStatus.js';
import {
  useDiscovery,
  __resetDiscoveryStateForTests,
} from '../../src/plugin/dashboard/spa/hooks/useDiscovery.js';

afterEach(() => {
  cleanup();
  __resetDiscoveryStateForTests();
});

describe('DiscoveryStatus', () => {
  it('renders the histogram and temperature sources without crashing', () => {
    const discovery = useDiscovery();
    discovery.lastDiscoveryAt.value = new Date().toISOString();
    discovery.connectState.value = 'connected';
    discovery.lastError.value = null;
    discovery.attemptedRefresh.value = true;
    discovery.devices.value = [
      { deviceId: 'd1', deviceType: 'WINDOW_COVERING' },
      { deviceId: 'd2', deviceType: 'WALL_THERMOSTAT' },
    ];
    discovery.histogram.value = [
      { deviceType: 'WINDOW_COVERING', count: 8 },
      { deviceType: 'WALL_THERMOSTAT', count: 12 },
    ];
    discovery.temperatureSources.value = [
      { deviceId: 'd2', deviceType: 'WALL_THERMOSTAT', friendlyName: 'Schlafzimmer' },
    ];

    const { container, getByTestId } = render(
      <DiscoveryStatus discovery={discovery} />,
    );

    expect(getByTestId('discovery-status')).toBeTruthy();
    // The histogram rows must render the deviceType labels.
    expect(container.textContent).toContain('WINDOW_COVERING');
    expect(container.textContent).toContain('WALL_THERMOSTAT');
    expect(container.textContent).toContain('Schlafzimmer');
  });

  it('renders nothing before discovery has run', () => {
    const discovery = useDiscovery();
    const { container } = render(<DiscoveryStatus discovery={discovery} />);
    expect(container.querySelector('[data-testid="discovery-status"]')).toBeNull();
  });
});
