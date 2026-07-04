/**
 * Heat Shield — Shared Building Model canonical form, content hash and
 * revisioning (HeatShield Unified Programme, shared-building-model 1.5/1.6).
 *
 * Every saved calculation must reference an immutable model revision + input
 * hash (blueprint §3 / execution-contract invariant). This module provides the
 * deterministic pieces that make that possible:
 *
 *   - {@link canonicalJson}  — stable JSON string: object keys sorted
 *     recursively, ARRAY ORDER PRESERVED (polygon/axis order is meaningful).
 *   - {@link contentHash}    — FNV-1a/64 hex over the canonical form with the
 *     mutable `revision` field excluded, so the hash identifies *geometry +
 *     attributes*, independent of the revision counter.
 *   - {@link nextRevision} / {@link commitRevision} — revision bumping and a
 *     change-aware commit; {@link checkRevision} for optimistic concurrency.
 *
 * PURE: no fs, no network, no globals, no crypto dependency (FNV-1a is a
 * non-cryptographic content hash — adequate for change-detection and
 * reproducibility references, NOT for security).
 */

import type { BuildingModel } from './building-model.js';

// ---------------------------------------------------------------------------
// Canonical JSON.
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    // Order is meaningful (polygons, wall axes) — preserve it, canonicalise
    // each element.
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = canonicalize(obj[key]);
    }
    return out;
  }
  return value;
}

/**
 * Deterministic JSON serialisation: object keys sorted recursively, arrays in
 * their original order. Two structurally equal models always produce the same
 * string regardless of key insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

// ---------------------------------------------------------------------------
// Content hash (FNV-1a, 64-bit, hex).
// ---------------------------------------------------------------------------

const FNV_OFFSET_BASIS = 1469598103934665603n;
const FNV_PRIME = 1099511628211n;
const U64 = (1n << 64n) - 1n;

/** FNV-1a/64 hash of a string, as zero-padded 16-char hex. */
export function fnv1a64Hex(input: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & U64;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Content hash of a building model: identifies geometry + attributes,
 * EXCLUDING the mutable `revision` counter. Same content with a different
 * revision → same hash. Any geometry/attribute change → (overwhelmingly
 * likely) different hash.
 */
export function contentHash(model: BuildingModel): string {
  const { revision: _revision, ...rest } = model;
  return fnv1a64Hex(canonicalJson(rest));
}

// ---------------------------------------------------------------------------
// Revisioning + optimistic concurrency.
// ---------------------------------------------------------------------------

/** Returns a copy of the model with `revision` incremented by one. */
export function nextRevision(model: BuildingModel): BuildingModel {
  return { ...model, revision: model.revision + 1 };
}

/**
 * Commit a draft against a previous model: if the content changed, return the
 * draft with `revision` bumped past the previous; otherwise return the draft
 * unchanged (its revision preserved). This keeps the revision counter
 * monotonic and meaningful — it only advances on a real content change.
 */
export function commitRevision(
  previous: BuildingModel,
  draft: BuildingModel,
): { model: BuildingModel; changed: boolean } {
  const changed = contentHash(previous) !== contentHash(draft);
  if (!changed) return { model: draft, changed: false };
  return { model: { ...draft, revision: previous.revision + 1 }, changed: true };
}

export type RevisionCheck =
  | { ok: true }
  | { ok: false; reason: 'stale'; expected: number; actual: number };

/**
 * Optimistic-concurrency guard. `expected` is the revision the caller based
 * its edit on; `actual` is the current persisted revision. Mismatch = the
 * model moved underneath the caller (stale write).
 */
export function checkRevision(expected: number, actual: number): RevisionCheck {
  if (expected === actual) return { ok: true };
  return { ok: false, reason: 'stale', expected, actual };
}
