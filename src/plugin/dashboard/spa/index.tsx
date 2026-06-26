/**
 * SPA bundle entry point (Task 11.5).
 *
 * Mounts <App/> into the `#root` element declared in
 * `public/index.html`. The bundle is produced by the `build:spa`
 * npm script and written to `public/app.js` next to the static
 * stylesheet.
 *
 * No CDN imports — every dependency is resolved through node_modules
 * at build time and inlined by esbuild.
 */

import { h, render } from 'preact';

import 'leaflet/dist/leaflet.css';

import { App } from './app.js';

const mount = document.getElementById('root');
if (mount !== null) {
  render(<App />, mount);
}
