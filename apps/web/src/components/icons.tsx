/**
 * Shared inline SVG icons for the sender/web UI (lucide-style stroke paths).
 *
 * Every icon inherits `currentColor`, so state colors (success green, error
 * red, muted grey) apply with no extra CSS. These replace the emoji glyphs
 * previously used in the UI — emoji render with platform-specific artwork and
 * ignore the app's color scheme.
 */

const svgProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const

interface IconProps {
  size?: number
}

export function FolderIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  )
}

export function PenIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </svg>
  )
}

export function FileIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  )
}

export function TextDocIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M8 13h8" />
      <path d="M8 17h5" />
    </svg>
  )
}

export function UploadIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" x2="12" y1="3" y2="15" />
    </svg>
  )
}

export function PackageIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <path d="m7.5 4.27 9 5.15" />
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  )
}

export function WarningIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  )
}

export function ErrorIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </svg>
  )
}

export function CheckCircleIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

export function CheckIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

export function ChevronRightIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

export function ChevronLeftIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}

export function ChevronDownIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

export function XIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

export function LoaderIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}

export function MinusIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <path d="M5 12h14" />
    </svg>
  )
}

export function CircleIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <circle cx="12" cy="12" r="9" />
    </svg>
  )
}

export function HistoryIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  )
}

export function DeleteIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  )
}

export function SettingsIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export function CloseIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
