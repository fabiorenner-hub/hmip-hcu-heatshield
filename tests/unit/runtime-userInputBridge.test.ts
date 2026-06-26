/**
 * Heat Shield — runtime user-input bridge tests (Tasks 9.2 + 9.3).
 *
 * Covers `src/plugin/runtime/userInputBridge.ts`:
 *
 *   - Pause toggle (on/off): persisted intent updates,
 *     `pauseUntil` matches next local midnight, `confirmFromEngine`
 *     called with `('heatshield-control-pause', requestedValue)`.
 *   - Vacation toggle: persisted intent updates, `confirmFromEngine`
 *     called with `('heatshield-control-vacation', true)`.
 *   - **Task 9.3 headline**: state-active=false with three known
 *     windows. All three `manualOverrideUntil` are set to
 *     `now + manualOverrideMinutes * 60_000`, `confirmFromEngine`
 *     called with `('heatshield-state-active', false)`, and the
 *     persisted `manualOverrideUntil` is past once the elapsed
 *     `now` has passed it (orchestrator safety layer would unblock).
 *   - Status-switch toggles for forecast / night-cooling:
 *     `confirmFromEngine` is NOT called for these ids; the
 *     `onReevaluate` callback fires once.
 *   - `stop()` removes the listener: a subsequent emit does not
 *     mutate the in-memory state.
 *
 * The tests use a tiny `OwnDeviceManager` fake that satisfies the
 * structural surface the bridge consumes (`on('userInput', ...)`,
 * `removeListener`, `confirmFromEngine`). No real `EventEmitter`
 * subclass machinery is needed; the fake's `emit('userInput', ...)`
 * is what drives the bridge.
 */

import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  UserInputBridge,
  type UserInputBridgeDeps,
} from '../../src/plugin/runtime/userInputBridge.js';
import {
  createWindowRuntimeState,
  emptyRuntimeState,
} from '../../src/plugin/persistence/state.js';
import type { OwnDeviceManager, OwnDeviceUserInput } from '../../src/plugin/connect/ownDevices.js';
import type { OwnSwitchId, RuntimeState } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const TEST_LOCATION = { timezone: 'Europe/Berlin' };

/**
 * 2026-06-21 08:00 UTC = 10:00 Berlin local (CEST). The next local
 * midnight in Europe/Berlin is 2026-06-22 00:00 local = 2026-06-21
 * 22:00 UTC.
 */
const FIXED_NOW = new Date('2026-06-21T08:00:00.000Z');
const NEXT_MIDNIGHT_ISO = '2026-06-21T22:00:00.000Z';
const MANUAL_OVERRIDE_MINUTES = 60;
const OVERRIDE_UNTIL_ISO = '2026-06-21T09:00:00.000Z';

// ---------------------------------------------------------------------------
// Fake OwnDeviceManager.
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for {@link OwnDeviceManager}. Only the surface
 * the bridge actually consumes is implemented:
 *
 *   - `on('userInput', listener)` / `removeListener('userInput', ...)`
 *     via Node's standard `EventEmitter`,
 *   - `emit('userInput', payload)` — driven by the test,
 *   - `confirmFromEngine(id, value)` — records every call into a
 *     captured array so the test can assert.
 */
class FakeOwnDeviceManager extends EventEmitter {
  public readonly confirmCalls: Array<{ id: OwnSwitchId; value: boolean }> = [];

  public confirmFromEngine(id: OwnSwitchId, value: boolean): void {
    this.confirmCalls.push({ id, value });
  }
}

/**
 * Build the dep bag with an in-memory `state` ref so the test can
 * inspect persisted state directly after emit. Returns the bridge,
 * the fake manager, and a `getState` accessor for assertions.
 */
function setup(opts: {
  initialState?: RuntimeState | null;
  now?: Date;
  manualOverrideMinutes?: number;
  onReevaluate?: () => void;
}): {
  bridge: UserInputBridge;
  fake: FakeOwnDeviceManager;
  getState: () => RuntimeState | null;
  emitInput: (deviceId: OwnSwitchId, requestedValue: boolean) => Promise<void>;
} {
  let state: RuntimeState | null = opts.initialState ?? null;
  const fake = new FakeOwnDeviceManager();
  const deps: UserInputBridgeDeps = {
    // FakeOwnDeviceManager satisfies the structural surface the
    // bridge consumes (`on`, `removeListener`, `confirmFromEngine`).
    ownDevices: fake as unknown as OwnDeviceManager,
    readState: async (): Promise<RuntimeState | null> => state,
    writeState: async (next: RuntimeState): Promise<void> => {
      state = next;
    },
    emptyState: emptyRuntimeState,
    manualOverrideMinutes: opts.manualOverrideMinutes ?? MANUAL_OVERRIDE_MINUTES,
    location: TEST_LOCATION,
    now: (): Date => opts.now ?? FIXED_NOW,
    ...(opts.onReevaluate !== undefined ? { onReevaluate: opts.onReevaluate } : {}),
  };
  const bridge = new UserInputBridge(deps);
  /**
   * Helper: drive a `userInput` event into the bridge and wait one
   * micro-tick for the async listener body to finish. The listener
   * is fire-and-forget (the EventEmitter does not await it), so we
   * `await Promise.resolve()` twice — once to enter the
   * `void this.handle(...)` chain, once for the inner `.catch`
   * handler.
   */
  const emitInput = async (
    deviceId: OwnSwitchId,
    requestedValue: boolean,
  ): Promise<void> => {
    const payload: OwnDeviceUserInput = {
      deviceId,
      requestedValue,
      rawRequest: {
        id: 'req-1',
        pluginId: 'de.fr.renner.plugin.heatshield',
        type: 'CONTROL_REQUEST',
        body: { deviceId, features: [{ type: 'switchState', on: requestedValue }] },
      },
    };
    fake.emit('userInput', payload);
    // Drain microtasks until the listener body settles. The listener
    // executes one async function whose body has at most two awaits
    // (readState + writeState) — three Promise.resolve() ticks are
    // more than enough.
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
  };
  return { bridge, fake, getState: (): RuntimeState | null => state, emitInput };
}

/**
 * Helper: build a runtime state populated with three windows so
 * Task 9.3 can assert `manualOverrideUntil` for each one.
 */
function stateWithThreeWindows(): RuntimeState {
  const base = emptyRuntimeState();
  base.windows = ['bedroom-window', 'office-window', 'living-room'].map((id) =>
    createWindowRuntimeState(id),
  );
  return base;
}

// ---------------------------------------------------------------------------
// 1. Pause toggle.
// ---------------------------------------------------------------------------

describe('UserInputBridge — heatshield-control-pause', () => {
  it('on (true) sets paused/pauseUntil and confirms (pause, true)', async () => {
    const { fake, getState, emitInput } = setup({
      initialState: emptyRuntimeState(),
    });

    await emitInput('heatshield-control-pause', true);

    const persisted = getState();
    expect(persisted).not.toBeNull();
    expect(persisted!.userIntent.paused).toBe(true);
    expect(persisted!.userIntent.pauseUntil).toBe(NEXT_MIDNIGHT_ISO);
    expect(persisted!.userIntent.vacation).toBe(false);

    expect(fake.confirmCalls).toEqual([
      { id: 'heatshield-control-pause', value: true },
    ]);
  });

  it('off (false) after pause was on clears the persisted intent', async () => {
    const seed = emptyRuntimeState();
    seed.userIntent = {
      paused: true,
      pauseUntil: NEXT_MIDNIGHT_ISO,
      vacation: false,
    };
    const { fake, getState, emitInput } = setup({ initialState: seed });

    await emitInput('heatshield-control-pause', false);

    const persisted = getState();
    expect(persisted!.userIntent.paused).toBe(false);
    expect(persisted!.userIntent.pauseUntil).toBeNull();

    expect(fake.confirmCalls).toEqual([
      { id: 'heatshield-control-pause', value: false },
    ]);
  });

  it('falls back to emptyState when readState returns null', async () => {
    const { fake, getState, emitInput } = setup({ initialState: null });

    await emitInput('heatshield-control-pause', true);

    const persisted = getState();
    expect(persisted).not.toBeNull();
    expect(persisted!.userIntent.paused).toBe(true);
    expect(persisted!.userIntent.pauseUntil).toBe(NEXT_MIDNIGHT_ISO);
    expect(fake.confirmCalls).toEqual([
      { id: 'heatshield-control-pause', value: true },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Vacation toggle.
// ---------------------------------------------------------------------------

describe('UserInputBridge — heatshield-control-vacation', () => {
  it('on (true) sets vacation and confirms (vacation, true)', async () => {
    const { fake, getState, emitInput } = setup({
      initialState: emptyRuntimeState(),
    });

    await emitInput('heatshield-control-vacation', true);

    const persisted = getState();
    expect(persisted!.userIntent.vacation).toBe(true);
    expect(persisted!.userIntent.paused).toBe(false);
    expect(persisted!.userIntent.pauseUntil).toBeNull();

    expect(fake.confirmCalls).toEqual([
      { id: 'heatshield-control-vacation', value: true },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. Task 9.3 headline: state-active=false → all windows clamped.
// ---------------------------------------------------------------------------

describe('UserInputBridge — Task 9.3: state-active=false force-opens every window', () => {
  it('sets manualOverrideUntil for every persisted window and confirms (state-active, false)', async () => {
    const { fake, getState, emitInput } = setup({
      initialState: stateWithThreeWindows(),
    });

    await emitInput('heatshield-state-active', false);

    const persisted = getState();
    expect(persisted).not.toBeNull();

    // a. All three windows carry the same override timestamp.
    const ids = ['bedroom-window', 'office-window', 'living-room'];
    for (const id of ids) {
      const row = persisted!.windows.find((w) => w.windowId === id);
      expect(row).toBeDefined();
      expect(row!.manualOverrideUntil).toBe(OVERRIDE_UNTIL_ISO);
    }

    // b. confirmFromEngine called with the documented effective value.
    expect(fake.confirmCalls).toEqual([
      { id: 'heatshield-state-active', value: false },
    ]);

    // c. After manualOverrideMinutes elapse, the persisted
    //    `manualOverrideUntil` is in the past relative to the new
    //    `now` — i.e. the orchestrator's safety layer would unblock
    //    the window on the next cycle.
    const elapsedNow = new Date(
      FIXED_NOW.getTime() + MANUAL_OVERRIDE_MINUTES * 60 * 1000 + 1,
    );
    for (const id of ids) {
      const row = persisted!.windows.find((w) => w.windowId === id);
      const until = new Date(row!.manualOverrideUntil ?? '');
      expect(until.getTime()).toBeLessThan(elapsedNow.getTime());
    }
  });

  it('respects custom manualOverrideMinutes', async () => {
    const { getState, emitInput } = setup({
      initialState: stateWithThreeWindows(),
      manualOverrideMinutes: 90,
    });

    await emitInput('heatshield-state-active', false);

    const persisted = getState();
    const expectedIso = new Date(
      FIXED_NOW.getTime() + 90 * 60 * 1000,
    ).toISOString();
    for (const row of persisted!.windows) {
      expect(row.manualOverrideUntil).toBe(expectedIso);
    }
  });

  it('creates a fresh runtime row when a window has no row yet', async () => {
    // Seed an empty windows[] so the bridge has to materialise rows
    // via createWindowRuntimeState. The reducer's allWindowIds list
    // is sourced from state.windows, so an empty windows[] means no
    // force-open entries — to exercise the branch we push a row for
    // a single id but leave the others absent. The reducer will then
    // populate the map from `allWindowIds = ['bedroom-window']`, and
    // the bridge has to overwrite the row.
    const seed = emptyRuntimeState();
    seed.windows = [createWindowRuntimeState('bedroom-window')];
    const { getState, emitInput } = setup({ initialState: seed });

    await emitInput('heatshield-state-active', false);

    const persisted = getState();
    expect(persisted!.windows).toHaveLength(1);
    expect(persisted!.windows[0]!.manualOverrideUntil).toBe(OVERRIDE_UNTIL_ISO);
  });
});

// ---------------------------------------------------------------------------
// 4. Status-switch toggles (forecast / night-cooling) → re-evaluate, no confirm.
// ---------------------------------------------------------------------------

describe('UserInputBridge — status-switch toggles request a re-evaluation', () => {
  it('forecast toggle does NOT call confirmFromEngine and fires onReevaluate once', async () => {
    const onReevaluate = vi.fn();
    const { fake, getState, emitInput } = setup({
      initialState: emptyRuntimeState(),
      onReevaluate,
    });

    const before = getState();
    await emitInput('heatshield-state-forecast', true);
    const after = getState();

    // Persisted high-level intent unchanged.
    expect(after!.userIntent).toEqual(before!.userIntent);
    // No confirmFromEngine for the forecast switch — the engine
    // reasserts on its next cycle.
    expect(fake.confirmCalls).toEqual([]);
    // Single re-eval request fired.
    expect(onReevaluate).toHaveBeenCalledTimes(1);
  });

  it('night-cooling toggle does NOT call confirmFromEngine and fires onReevaluate once', async () => {
    const onReevaluate = vi.fn();
    const { fake, emitInput } = setup({
      initialState: emptyRuntimeState(),
      onReevaluate,
    });

    await emitInput('heatshield-state-night-cooling', false);

    expect(fake.confirmCalls).toEqual([]);
    expect(onReevaluate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 5. stop() removes the listener.
// ---------------------------------------------------------------------------

describe('UserInputBridge — stop() detaches the listener', () => {
  it('a userInput emitted after stop() leaves state untouched', async () => {
    const { bridge, fake, getState, emitInput } = setup({
      initialState: emptyRuntimeState(),
    });

    bridge.stop();

    const before = getState();
    await emitInput('heatshield-control-pause', true);
    const after = getState();

    // Identity of the in-memory ref is unchanged because writeState
    // was never called.
    expect(after).toBe(before);
    expect(fake.confirmCalls).toEqual([]);
  });

  it('stop() is idempotent', async () => {
    const { bridge, fake, getState, emitInput } = setup({
      initialState: emptyRuntimeState(),
    });

    bridge.stop();
    bridge.stop();
    bridge.stop();

    await emitInput('heatshield-control-pause', true);
    expect(fake.confirmCalls).toEqual([]);
    expect(getState()!.userIntent.paused).toBe(false);
  });
});
