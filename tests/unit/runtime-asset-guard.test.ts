/**
 * Runtime asset guard (stability-asset-pipeline T-05).
 *
 * Enforces that the shipped runtime NEVER imports SVG modules or references the
 * offline asset-generation scratch space / source manifest. Rationale:
 *   - SVG imports would either inline vector markup into the JS bundle or pull a
 *     loader we don't ship; hero art is PNG referenced via CSS `url()` only.
 *   - `.tmp-assets/` holds the AWS-SDK generation tooling + secrets and must
 *     never be reachable from runtime code.
 *
 * The guard walks the runtime source tree (excluding tests) and fails on the
 * first offending import. It is deterministic and needs no network/build.
 */

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = path.resolve(here, '..', '..', 'src', 'plugin');

/** Collect every .ts/.tsx file under a directory (recursively). */
async function collectSources(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (/\.(ts|tsx)$/u.test(e.name) && !/\.test\.(ts|tsx)$/u.test(e.name)) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

// import/export ... from '….svg'  OR  a dynamic import('….svg')
const SVG_IMPORT = /(?:from|import)\s*\(?\s*['"][^'"]*\.svg['"]/u;
// any reference to the offline scratch space or the source asset manifest
const REFERENCE_IMPORT = /['"][^'"]*(?:\.tmp-assets|stability-only-manifest)[^'"]*['"]/u;

describe('runtime asset guard (T-05)', () => {
  it('no runtime source imports an SVG module', async () => {
    const files = await collectSources(RUNTIME_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const f of files) {
      const src = await fs.readFile(f, 'utf8');
      if (SVG_IMPORT.test(src)) offenders.push(path.relative(RUNTIME_ROOT, f));
    }
    expect(offenders).toEqual([]);
  });

  it('no runtime source references the offline tooling or the source manifest', async () => {
    const files = await collectSources(RUNTIME_ROOT);
    const offenders: string[] = [];
    for (const f of files) {
      const src = await fs.readFile(f, 'utf8');
      if (REFERENCE_IMPORT.test(src)) offenders.push(path.relative(RUNTIME_ROOT, f));
    }
    expect(offenders).toEqual([]);
  });
});
