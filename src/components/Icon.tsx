/**
 * Icon — minimal inline SVG icon set.
 *
 * All icons use a 24×24 viewBox, stroke-based rendering with currentColor.
 * This matches the VS Code / Lucide visual language: thin geometric strokes,
 * no fill, consistent stroke-width of 1.5.
 *
 * Add new icons here as the app grows. Do NOT import from any icon library.
 */

import type { CSSProperties } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IconName =
  // Planning buckets
  | 'bolt'          // now  — immediate priority
  | 'sun'           // today
  | 'arrow-right'   // tomorrow
  | 'calendar'      // this week
  | 'clock'         // later
  // Planning meta
  | 'due'           // due date (calendar with clock)
  | 'effort'        // effort estimate (hourglass)
  | 'lock'          // planning locked
  | 'unlock'        // planning unlocked
  // Workflow actions
  | 'search'        // analyze
  | 'play'          // do it
  | 'layers'        // skeleton
  | 'check'         // validate / done
  | 'check-square'  // tasks nav
  // Filesystem actions
  | 'folder'        // open repository / folder
  | 'plug'          // plugin folder
  | 'file-text'     // script folder
  | 'terminal'      // open in VS Code
  // Communication
  | 'mail'          // email source / reply
  | 'message'       // teams source
  | 'pencil'        // manual source
  // Navigation
  | 'inbox'         // inbox nav
  | 'building'      // customers nav
  | 'settings'      // settings nav
  // General
  | 'chevron-right'
  | 'pin'           // locked/pinned indicator
  // Import UI
  | 'refresh-cw'    // refresh
  | 'x'             // close
  | 'loader'        // loading
  | 'alert-circle'  // error
  | 'message-square'// Teams chats
  | 'arrow-left'    // back
  | 'trash-2'        // delete
  | 'external-link'  // open external URL
  | 'log-in';        // reconnect / sign in

// ---------------------------------------------------------------------------
// SVG path definitions (24×24 viewBox, Lucide-style)
// ---------------------------------------------------------------------------

/** Each value is an array of <path> d attributes (or a single string). */
const ICON_PATHS: Record<IconName, string[]> = {
  // ⚡ Bolt — immediate / now
  'bolt': [
    'M13 2 3 14h9l-1 8 10-12H12z',
  ],

  // ☀ Sun — today
  'sun': [
    'M12 17A5 5 0 1 0 12 7a5 5 0 0 0 0 10z',
    'M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
  ],

  // → Arrow right — tomorrow
  'arrow-right': [
    'M5 12h14',
    'M12 5l7 7-7 7',
  ],

  // 📆 Calendar — this week
  'calendar': [
    'M8 2v4M16 2v4',
    'M3 8h18',
    'M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  ],

  // 🕐 Clock — later
  'clock': [
    'M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2z',
    'M12 6v6l4 2',
  ],

  // Due date — small calendar with clock hands
  'due': [
    'M8 2v4M16 2v4',
    'M3 8h18',
    'M5 4h14a2 2 0 0 1 2 2v8',
    'M18 21a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    'M18 17v2h1.5',
  ],

  // Effort — hourglass
  'effort': [
    'M5 2h14',
    'M5 22h14',
    'M5 2a14 8 0 0 1 14 0v4l-4 4 4 6v4',
    'M19 22a14 8 0 0 1-14 0v-4l4-6-4-4V2',
  ],

  // Lock — closed padlock
  'lock': [
    'M7 11V6a5 5 0 0 1 10 0v5',
    'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z',
    'M12 16v2',
  ],

  // Unlock — open padlock
  'unlock': [
    'M7 11V6a5 5 0 0 1 9.9-1',
    'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z',
  ],

  // Search / analyze
  'search': [
    'M11 3a8 8 0 1 0 0 16A8 8 0 0 0 11 3z',
    'M21 21l-4.35-4.35',
  ],

  // Play / do it
  'play': [
    'M5 3l14 9-14 9V3z',
  ],

  // Layers / scaffold / skeleton
  'layers': [
    'M12 2L2 7l10 5 10-5-10-5z',
    'M2 17l10 5 10-5',
    'M2 12l10 5 10-5',
  ],

  // Check mark — validate / done
  'check': [
    'M20 6 9 17l-5-5',
  ],

  // Check square — tasks nav
  'check-square': [
    'M9 11l3 3L22 4',
    'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  ],

  // Folder — open repository
  'folder': [
    'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  ],

  // Plug — plugin folder
  'plug': [
    'M7 2v4M17 2v4',
    'M6 6h12v4a6 6 0 0 1-12 0V6z',
    'M12 16v6',
    'M9 22h6',
  ],

  // File text — script folder
  'file-text': [
    'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z',
    'M14 2v6h6',
    'M16 13H8M16 17H8M10 9H8',
  ],

  // Terminal — open in VS Code
  'terminal': [
    'M4 17l6-6-6-6',
    'M12 19h8',
  ],

  // Mail — email source / generate reply
  'mail': [
    'M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z',
    'M22 6l-10 7L2 6',
  ],

  // Message square — Teams source
  'message': [
    'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  ],

  // Pencil — manual source
  'pencil': [
    'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7',
    'M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z',
  ],

  // Inbox — nav
  'inbox': [
    'M22 12h-6l-2 3H10L8 12H2',
    'M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  ],

  // Building — customers nav
  'building': [
    'M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18z',
    'M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2',
    'M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2',
    'M10 6h4M10 10h4M10 14h4M10 18h4',
  ],

  // Settings — gear
  'settings': [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  ],

  // Chevron right — generic directional
  'chevron-right': [
    'M9 18l6-6-6-6',
  ],

  // Pin — locked / pinned
  'pin': [
    'M12 2a3 3 0 0 1 3 3v7l2 3H7l2-3V5a3 3 0 0 1 3-3z',
    'M12 22v-7',
  ],

  // Refresh CW
  'refresh-cw': [
    'M23 4v6h-6',
    'M1 20v-6h6',
    'M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
  ],

  // X — close
  'x': [
    'M18 6L6 18M6 6l12 12',
  ],

  // Loader (circle with arc)
  'loader': [
    'M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83',
  ],

  // Alert circle
  'alert-circle': [
    'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z',
    'M12 8v4M12 16h.01',
  ],

  // Message square — Teams chats
  'message-square': [
    'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  ],

  // Arrow left — back
  'arrow-left': [
    'M19 12H5M12 19l-7-7 7-7',
  ],

  // 🗑 Trash-2 — delete
  'trash-2': [
    'M3 6h18',
    'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
    'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
    'M10 11v6',
    'M14 11v6',
  ],

  // ↗ External link — open in browser
  'external-link': [
    'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
    'M15 3h6v6',
    'M10 14L21 3',
  ],

  // Log-in / reconnect — door with arrow entering
  'log-in': [
    'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4',
    'M10 17l5-5-5-5',
    'M15 12H3',
  ],
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface IconProps {
  name: IconName;
  /** Size in px; default 14 */
  size?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

export default function Icon({ name, size = 14, className, style, title }: IconProps) {
  const paths = ICON_PATHS[name];
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`icon${className ? ` ${className}` : ''}`}
      style={style}
      aria-hidden={!title}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
