/**
 * SVG row glyphs for dsh-file-explorer (browser face).
 *
 * The file browser previously used emoji text glyphs per entry and for empty /
 * warning states; this module provides the same classification as crisp
 * lucide-react SVG icons (bundled into lib/client.js), all stroked in
 * `currentColor` so they follow the surrounding inline palette.
 *
 * @module dsh-file-explorer/icons
 */

import {
  Copy,
  Eye,
  FileCode2,
  FileCog,
  FileText,
  FileType,
  Folder,
  Image as ImageIcon,
  Languages,
  Lock,
  Paperclip,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react'
import type { EntryGlyphId } from './files-api.ts'

/** Every lucide icon is this shape; captured from one instance for typing. */
type IconComponent = typeof Folder

const GLYPHS: Readonly<Record<EntryGlyphId, IconComponent>> = {
  'dir': Folder,
  'image': ImageIcon,
  'markdown': FileText,
  'config': FileCog,
  'code': FileCode2,
  'text': FileType,
  'binary': Paperclip,
}

/** Row/preview icon for one entry glyph id. */
export function EntryGlyph(props: {
  glyph: EntryGlyphId
  size?: number
  strokeWidth?: number
}): JSX.Element {
  const { glyph, size = 13, strokeWidth = 1.7 } = props
  const IconComponent = GLYPHS[glyph]
  return <IconComponent size={size} strokeWidth={strokeWidth} aria-hidden />
}

export {
  Copy,
  Eye,
  FileText,
  Languages,
  Lock,
  RefreshCw,
  TriangleAlert,
}
