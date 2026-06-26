/**
 * preact-router type shim.
 *
 * preact-router augments the runtime `Attributes` interface with
 * `path` / `default`, but the TS type-checker validates JSX component
 * props against `JSXInternal.IntrinsicAttributes` from preact. This
 * shim adds the routing props to that interface so the route table
 * in `app.tsx` type-checks without per-call casts.
 *
 * The augmentation is scoped to this SPA via `tsconfig.spa.json` —
 * it does not leak into the engine, persistence, or Connect API
 * type graphs.
 */

import 'preact';

declare module 'preact' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicAttributes {
      /** Route path matched against the current URL (preact-router). */
      path?: string;
      /** Default route used when no other route matches. */
      default?: boolean;
    }
  }
}

export {};
