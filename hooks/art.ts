// 桌面版面板用的 SVG：圓角漸層頭像與圓角標籤。SVG 由我們自己產生，插件目錄的文字一律跳脫後才放進去。
// 桌面版把 SVG 當圖片畫，跟著系統的淺色或深色模式換色（prefers-color-scheme）。

export type PillTone = 'accent' | 'plain' | 'warning' | 'success'
export type Pill = { label: string; tone: PillTone }
export type SvgArt = { source: string; width: number; height: number }

const GRADIENTS = [
  ['#7C5CFF', '#B18CFF'],
  ['#2F80ED', '#56CCF2'],
  ['#11998E', '#38EF7D'],
  ['#F2994A', '#F2C94C'],
  ['#EB5757', '#F78CA0'],
  ['#9B51E0', '#E062B4'],
  ['#2D9CDB', '#6FCF97'],
  ['#D9822B', '#EB5757'],
] as const

const FONT = "system-ui, -apple-system, 'Segoe UI', 'Microsoft JhengHei', 'PingFang TC', sans-serif"

export const escapeXml = (text: string) =>
  text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

const hash = (text: string) => [...text].reduce((h, c) => (h * 31 + (c.codePointAt(0) ?? 0)) >>> 0, 7)

/** 估算字寬（px）：中日韓與全形字約一個字級寬，其他約 0.58 倍。 */
export function textWidth(text: string, size: number): number {
  let width = 0
  for (const char of text) width += (char.codePointAt(0) ?? 0) >= 0x2e80 ? size : size * 0.58
  return Math.ceil(width)
}

export function avatarSvg(seed: string, letter: string, size = 36): SvgArt {
  const [from, to] = GRADIENTS[hash(seed) % GRADIENTS.length] ?? GRADIENTS[0]
  const id = `g${hash(seed).toString(36)}`
  const radius = Math.round(size * 0.26)
  const font = Math.round(size * 0.48)
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>` +
    `<rect width="${size}" height="${size}" rx="${radius}" fill="url(#${id})"/>` +
    `<text x="50%" y="50%" dy="0.36em" text-anchor="middle" font-family="${FONT}" font-size="${font}" font-weight="700" fill="#fff">${escapeXml([...letter][0] ?? '?')}</text>` +
    `</svg>`
  return { source, width: size, height: size }
}

/** 依估算字寬截斷，超過就加省略號。 */
export function fitText(text: string, size: number, maxWidth: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (textWidth(flat, size) <= maxWidth) return flat
  let out = ''
  for (const char of flat) {
    if (textWidth(`${out}${char}…`, size) > maxWidth) break
    out += char
  }
  return `${out}…`
}

/**
 * 漸層橫幅：清單頁放標題與統計，插件頁放大頭像、名稱與作者。
 * `seed` 決定漸層顏色；給 `letter` 時左邊畫頭像。
 */
export function bannerSvg({ seed, title, subtitle, stats = [], letter, width = 720 }: { seed: string; title: string; subtitle?: string; stats?: readonly string[]; letter?: string; width?: number }): SvgArt {
  const [from, to] = GRADIENTS[hash(seed) % GRADIENTS.length] ?? GRADIENTS[0]
  const id = `b${hash(seed).toString(36)}`
  const height = 112
  const left = letter ? 104 : 28
  const textRoom = width - left - 28
  const avatar = letter
    ? `<rect x="24" y="24" width="64" height="64" rx="18" fill="#ffffff" fill-opacity="0.22"/>` +
      `<text x="56" y="56" dy="0.36em" text-anchor="middle" font-family="${FONT}" font-size="30" font-weight="700" fill="#fff">${escapeXml([...letter][0] ?? '?')}</text>`
    : ''
  let x = left
  const chips = stats
    .map(stat => {
      const w = textWidth(stat, 12) + 20
      if (x + w > width - 24) return ''
      const chip = `<rect x="${x}" y="76" width="${w}" height="22" rx="11" fill="#ffffff" fill-opacity="0.2"/><text x="${x + w / 2}" y="87" dy="0.35em" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="500" fill="#fff">${escapeXml(stat)}</text>`
      x += w + 8
      return chip
    })
    .join('')
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>` +
    `<rect width="${width}" height="${height}" rx="16" fill="url(#${id})"/>` +
    `<circle cx="${width - 40}" cy="18" r="70" fill="#ffffff" fill-opacity="0.08"/><circle cx="${width - 120}" cy="${height + 10}" r="50" fill="#ffffff" fill-opacity="0.06"/>` +
    avatar +
    `<text x="${left}" y="38" font-family="${FONT}" font-size="22" font-weight="700" fill="#fff">${escapeXml(fitText(title, 22, textRoom))}</text>` +
    (subtitle ? `<text x="${left}" y="62" font-family="${FONT}" font-size="13" fill="#fff" fill-opacity="0.88">${escapeXml(fitText(subtitle, 13, textRoom))}</text>` : '') +
    chips +
    `</svg>`
  return { source, width, height }
}

const STYLE =
  `.accent rect{fill:#E8F0FE}.accent text{fill:#1A56B8}` +
  `.plain rect{fill:#F1F2F4}.plain text{fill:#5B6170}` +
  `.warning rect{fill:#FFF3D6}.warning text{fill:#8A5600}` +
  `.success rect{fill:#E3F6EA}.success text{fill:#1E7A43}` +
  `@media (prefers-color-scheme: dark){` +
  `.accent rect{fill:#1E3557}.accent text{fill:#A7C6FF}` +
  `.plain rect{fill:#2C2F36}.plain text{fill:#B7BCC6}` +
  `.warning rect{fill:#47360F}.warning text{fill:#FFD27A}` +
  `.success rect{fill:#173A27}.success text{fill:#8FE0AE}}`

/** 一排圓角標籤；放不下 maxWidth 的標籤直接略去，不截斷字。 */
export function pillsSvg(pills: readonly Pill[], { size = 12, maxWidth = 640 } = {}): SvgArt | undefined {
  const height = size + 10
  const gap = 6
  let x = 0
  const parts: string[] = []
  for (const pill of pills) {
    const width = textWidth(pill.label, size) + 18
    if (x + width > maxWidth) break
    parts.push(
      `<g class="${pill.tone}"><rect x="${x}" y="0" width="${width}" height="${height}" rx="${height / 2}"/>` +
        `<text x="${x + width / 2}" y="${height / 2}" dy="0.35em" text-anchor="middle" font-family="${FONT}" font-size="${size}" font-weight="500">${escapeXml(pill.label)}</text></g>`,
    )
    x += width + gap
  }
  if (!parts.length) return undefined
  const width = Math.max(1, x - gap)
  return { source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>${STYLE}</style>${parts.join('')}</svg>`, width, height }
}
