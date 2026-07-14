/**
 * Heat Shield — inline SVG icon set (predictive-control-dashboard polish).
 *
 * Hand-drawn, fully transparent line icons rendered inline as Preact
 * components so they inherit `currentColor` from the surrounding text
 * (the nav highlights the active module, the env chips tint by context).
 * `<img>`-referenced SVGs cannot inherit `currentColor`, hence inline.
 *
 * The same shapes are mirrored as static files under
 * `public/assets/icons/*.svg` for any non-Preact consumer.
 */

import { h, type JSX } from 'preact';

export type IconName =
  | 'logo'
  | 'beschattung'
  | 'lueftung'
  | 'klima'
  | 'forecast'
  | 'automation'
  | 'einstellungen'
  | 'pinsel'
  | 'warnung'
  | 'sonne'
  | 'uv'
  | 'wind'
  | 'feuchte'
  | 'fenster'
  | 'pv'
  | 'thermometer'
  | 'haus'
  | 'flamme'
  | 'schloss'
  | 'schloss-auf'
  | 'tropfen'
  | 'glocke'
  | 'frage'
  | 'mehr'
  | 'schliessen';

export interface IconProps {
  name: IconName;
  /** Pixel size (width = height). Defaults to 18. */
  size?: number;
  class?: string;
  title?: string;
}

const COMMON = {
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 1.7,
  'stroke-linecap': 'round' as const,
  'stroke-linejoin': 'round' as const,
};

function paths(name: IconName): JSX.Element {
  switch (name) {
    case 'logo':
      return (
        <g>
          <path d="M12 2.5 4.5 5.5v6c0 4.6 3.2 7.9 7.5 9.5 4.3-1.6 7.5-4.9 7.5-9.5v-6L12 2.5Z" />
          <path d="M8.4 12.2c1.2 1.4 2.3 2 3.6 2s2.4-.6 3.6-2" />
        </g>
      );
    case 'pinsel':
      return (
        <g>
          {/* handle */}
          <path d="M19.5 4.5a1.8 1.8 0 0 0-2.5 0L10 11.5l2.5 2.5 7-7a1.8 1.8 0 0 0 0-2.5Z" />
          <path d="M11 10.5l2.5 2.5" />
          {/* bristles / paint blob */}
          <path d="M10 11.5 8.4 13a3.2 3.2 0 0 0-.9 2.2c0 .8-.6 1.3-1.3 1.6-.7.3-.9 1.2-.4 1.8 1 1.2 2.7 1.7 4.2 1.2a3.4 3.4 0 0 0 2.2-3.2c0-.9-.4-1.7-1-2.3" />
        </g>
      );
    case 'warnung':
      return (
        <g>
          <path d="M12 3.2 21 19.5H3L12 3.2Z" />
          <path d="M12 9.5v4.2" />
          <path d="M12 16.6v.1" />
        </g>
      );
    case 'beschattung':
      return (
        <g>
          <path d="M4 10.5 12 4l8 6.5" />
          <path d="M5.5 9.5v10h13v-10" />
          <rect x="9" y="12" width="6" height="7.5" rx="0.6" />
          <path d="M9 14.4h6M9 16.6h6" />
        </g>
      );
    case 'lueftung':
    case 'wind':
      return (
        <g>
          <path d="M3 8.5h11a2.5 2.5 0 1 0-2.5-2.5" />
          <path d="M3 12.5h15a2.5 2.5 0 1 1-2.5 2.5" />
          <path d="M3 16.5h9a2.2 2.2 0 1 1-2.2 2.2" />
        </g>
      );
    case 'klima':
      return (
        <g>
          <path d="M9 13.5V5a2 2 0 1 1 4 0v8.5a3.5 3.5 0 1 1-4 0Z" />
          <path d="M11 13.8a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2Z" fill="currentColor" stroke="none" />
          <path d="M16 6h4M16 9h3M16 12h4" />
        </g>
      );
    case 'forecast':
      return (
        <g>
          <circle cx="8" cy="7.5" r="3" />
          <path d="M8 1.8v1.4M8 11.8v1.4M1.8 7.5h1.4M12.8 7.5h1.4M3.7 3.2l1 1M11.3 3.2l-1 1" />
          <path d="M9 14.5a4 4 0 0 1 7.7 1.3A3 3 0 1 1 17 21.5H9a3.5 3.5 0 0 1 0-7Z" />
          <path d="M10 22.5l-.6 1.2M13 22.5l-.6 1.2M16 22.5l-.6 1.2" opacity="0.7" />
        </g>
      );
    case 'automation':
      return (
        <g>
          <path d="M3.5 11 12 4l8.5 7" />
          <path d="M5.5 9.7V20h13V9.7" />
          <circle cx="12" cy="14" r="2.2" />
          <path d="M12 10.6v1M12 17.4v1M8.6 14h1M14.4 14h1M9.6 11.6l.7.7M14.4 11.6l-.7.7M9.6 16.4l.7-.7M14.4 16.4l-.7-.7" />
        </g>
      );
    case 'einstellungen':
      // Clean modern gear (8-lobe cog + hub). Fills the 24×24 box for a bigger,
      // crisper look in the navigation.
      return (
        <g>
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
          <circle cx="12" cy="12" r="3" />
        </g>
      );
    case 'sonne':
      return (
        <g>
          <circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none" />
          <path d="M12 2.5v2.6M12 18.9v2.6M21.5 12h-2.6M5.1 12H2.5M18.7 5.3l-1.9 1.9M7.2 16.8l-1.9 1.9M18.7 18.7l-1.9-1.9M7.2 7.2 5.3 5.3" />
        </g>
      );
    case 'uv':
      return (
        <g>
          <path d="M12 2.5v2M12 20v1.5M19.5 12h2M2.5 12h2M17.6 6.4l1.4-1.4M5 19l1.4-1.4M17.6 17.6l1.4 1.4M5 5l1.4 1.4" opacity="0.8" />
          <circle cx="12" cy="12" r="3.4" />
          <text x="12" y="13.4" text-anchor="middle" font-size="4.2" font-family="Arial, sans-serif" font-weight="700" fill="currentColor" stroke="none">
            UV
          </text>
        </g>
      );
    case 'feuchte':
      return (
        <g>
          <path d="M12 3.2c3.4 4 5.5 6.9 5.5 9.6a5.5 5.5 0 0 1-11 0c0-2.7 2.1-5.6 5.5-9.6Z" />
          <path d="M9.8 13.4a2.3 2.3 0 0 0 2.2 2.4" opacity="0.7" />
        </g>
      );
    case 'fenster':
      // Open window: a frame with one sash swung open.
      return (
        <g>
          <rect x="3.5" y="4" width="9" height="16" rx="0.8" />
          <path d="M8 4v16" />
          <path d="M12.5 6.5 20.5 4v16l-8-2.5" fill="currentColor" stroke="none" opacity="0.85" />
          <path d="M12.5 6.5 20.5 4v16l-8-2.5Z" />
        </g>
      );
    case 'pv':
      // Lightning bolt (PV power). Filled for a solid, iconic glyph.
      return (
        <path
          d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"
          fill="currentColor"
          stroke="currentColor"
          stroke-width="1.2"
        />
      );
    case 'thermometer':
      // Outdoor temperature: tube + filled bulb + two scale ticks.
      return (
        <g>
          <path d="M14 14.6V5.5a2.5 2.5 0 0 0-5 0v9.1a4 4 0 1 0 5 0Z" />
          <circle cx="11.5" cy="17.5" r="1.9" fill="currentColor" stroke="none" />
          <path d="M14 8h2.2M14 10.7h1.6" opacity="0.85" />
        </g>
      );
    case 'haus':
      // Indoor: a simple house with a door (room temperature).
      return (
        <g>
          <path d="M3.8 11 12 4.3 20.2 11" />
          <path d="M5.7 9.6V19.6h12.6V9.6" />
          <path d="M9.8 19.6v-5.2h4.4v5.2" />
        </g>
      );
    case 'flamme':
      // Heat index: a flame. Filled for a strong silhouette.
      return (
        <path
          d="M12 3.4c3 3.2 4.8 5.4 4.8 8.7a4.8 4.8 0 0 1-9.6 0c0-1.7.7-3 1.9-4.4.1 1.1.8 1.8 1.7 1.8 1.1 0 1.8-.9 1.5-2.4-.2-1.1-.3-2.3-.2-3.7Z"
          fill="currentColor"
          stroke="currentColor"
          stroke-width="1.1"
        />
      );
    case 'schloss':
      // Closed padlock (badges locked): body + shackle down + keyhole.
      return (
        <g>
          <rect x="5.5" y="10.5" width="13" height="9.2" rx="1.8" />
          <path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7" />
          <circle cx="12" cy="14.4" r="1.25" fill="currentColor" stroke="none" />
          <path d="M12 15.5v2" />
        </g>
      );
    case 'schloss-auf':
      // Open padlock (badges movable): shackle swung open to the side.
      return (
        <g>
          <rect x="5.5" y="10.5" width="13" height="9.2" rx="1.8" />
          <path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 6.9-.9" />
          <circle cx="12" cy="14.4" r="1.25" fill="currentColor" stroke="none" />
          <path d="M12 15.5v2" />
        </g>
      );
    case 'tropfen':
      // Raindrop (Bewässerung / precipitation).
      return (
        <g>
          <path d="M12 3.2c3 4 5 6.6 5 9.3a5 5 0 0 1-10 0c0-2.7 2-5.3 5-9.3Z" />
          <path d="M9.7 12.8a2.3 2.3 0 0 0 2.3 2.4" opacity="0.7" />
        </g>
      );
    case 'glocke':
      // Notification bell (Nachrichten).
      return (
        <g>
          <path d="M18 8.5a6 6 0 0 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5Z" />
          <path d="M10.3 19a2 2 0 0 0 3.4 0" />
        </g>
      );
    case 'frage':
      // Help / question mark in a circle.
      return (
        <g>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.8c0 1.7-2.4 2-2.4 3.6" />
          <path d="M12 17.2h.01" />
        </g>
      );
    case 'mehr':
      // "More" — three horizontal dots.
      return (
        <g>
          <circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
        </g>
      );
    case 'schliessen':
      // Close (X).
      return (
        <g>
          <path d="M6 6l12 12" />
          <path d="M18 6 6 18" />
        </g>
      );
  }
}

export function Icon(props: IconProps): JSX.Element {
  const size = props.size ?? 18;
  return (
    <svg
      {...COMMON}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      class={props.class ?? ''}
      role="img"
      aria-hidden={props.title === undefined ? 'true' : undefined}
      aria-label={props.title}
    >
      {props.title !== undefined && <title>{props.title}</title>}
      {paths(props.name)}
    </svg>
  );
}
