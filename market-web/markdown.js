// 把插件作者寫的自述文件（Markdown）轉成安全的 HTML：所有文字一律跳脫，只產生下面寫死的標籤；
// 作者寫的 HTML 不保留（圖片、連結、標題轉成 Markdown，其他標籤只留文字）；連結只接受 http、https，
// 圖片只接受 https，相對路徑依原始檔的位置補成完整網址。頁面另有內容安全政策（CSP）擋掉任何腳本。

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ESCAPES[c]);
const unescapeHtml = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[n]);

/** 補成完整網址；不是 http、https（或圖片不是 https）就回傳空字串。 */
export function safeUrl(raw, base, { image = false } = {}) {
  const value = String(raw ?? '').trim().replace(/^<|>$/g, '');
  if (!value || value.startsWith('#') || value.startsWith('//')) return '';
  let url;
  try {
    url = /^[a-z][a-z0-9+.-]*:/i.test(value) ? new URL(value) : base ? new URL(value, base) : null;
  } catch {
    return '';
  }
  if (!url || url.username || url.password) return '';
  if (image ? url.protocol !== 'https:' : url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  return url.href;
}

const attr = (name, value) => (value ? ` ${name}="${escapeHtml(value)}"` : '');
const attrValue = (tag, name) => {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? (match[2] ?? match[3] ?? match[4] ?? '') : '';
};

/** 作者寫的 HTML 轉成 Markdown 或只留文字。 */
function stripHtml(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|svg|math|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<img\b[^>]*>/gi, tag => {
      const src = attrValue(tag, 'src');
      return src ? `![${attrValue(tag, 'alt').replace(/[[\]]/g, '')}](${src.replace(/[()\s]/g, encodeURIComponent)})` : '';
    })
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi, (tag, inner) => {
      const href = attrValue(tag, 'href');
      return href ? `[${inner.trim() || href}](${href.replace(/[()\s]/g, encodeURIComponent)})` : inner;
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, n, inner) => `\n\n${'#'.repeat(Number(n))} ${inner.replace(/\s+/g, ' ').trim()}\n\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|details|summary|li|tr|table|blockquote|section|center)\s*>/gi, '\n\n')
    .replace(/<\/?[a-z][a-z0-9-]*\b[^>]*>/gi, '')
    .replace(/&nbsp;/g, ' ');
}

/** 一行內的格式：程式碼、圖片、連結、粗體、斜體、刪除線、網址。 */
function inline(text, base) {
  const slots = [];
  const hold = html => `\u0000${slots.push(html) - 1}\u0000`;
  const format = source => {
    const held = source
      .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => hold(`<code>${escapeHtml(code.trim())}</code>`))
      .replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g, (_, alt, src) => {
        const url = safeUrl(src, base, { image: true });
        return hold(url ? `<img${attr('src', url)}${attr('alt', alt)} loading="lazy" referrerpolicy="no-referrer">` : escapeHtml(alt ? imageLabel(alt) : ''));
      })
      .replace(/\[((?:[^[\]]|\u0000\d+\u0000)*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g, (_, label, href) => {
        const url = safeUrl(href, base);
        const body = format(label);
        return hold(url ? `<a${attr('href', url)} target="_blank" rel="noopener noreferrer">${body}</a>` : body);
      });
    return emphasis(held);
  };
  let out = format(text);
  // 連結文字裡可能還有先前保留的圖片或程式碼，一路換回去。
  for (let round = 0; round < 8 && /\u0000\d+\u0000/.test(out); round++) out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)] ?? '');
  return out;
}

/** 跳脫後套上粗體、斜體、刪除線、網址與換行。保留位置的記號（\u0000數字\u0000）不受影響。 */
function emphasis(text) {
  return escapeHtml(text)
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/(^|[\s(（])(https?:\/\/[^\s<\u0000）)]+)/g, (_, lead, raw) => {
      const url = safeUrl(unescapeHtml(raw));
      return url ? `${lead}<a${attr('href', url)} target="_blank" rel="noopener noreferrer">${raw}</a>` : `${lead}${raw}`;
    })
    .replace(/ {2,}\n|\\\n/g, '<br>');
}

const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const splitRow = line => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));

/** 一段區塊（多行）轉成 HTML。 */
function blocks(lines, base, depth = 0) {
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      html.push(`<pre><code${attr('data-lang', fence[2])}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { html.push(`<h${heading[1].length}>${inline(heading[2], base)}</h${heading[1].length}>`); i++; continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { html.push('<hr>'); i++; continue; }
    if (/^\s{0,3}>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      html.push(depth < 8 ? `<blockquote>${blocks(quoted, base, depth + 1)}</blockquote>` : `<p>${inline(quoted.join(' '), base)}</p>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      const cell = (tag, text, n) => `<${tag}${align[n] ? ` class="a-${align[n]}"` : ''}>${inline(text, base)}</${tag}>`;
      html.push(`<div class="table"><table><thead><tr>${head.map((c, n) => cell('th', c, n)).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${head.map((_, n) => cell('td', r[n] ?? '', n)).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const item = LIST.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]);
      const indent = item[1].length;
      const items = [];
      while (i < lines.length) {
        const current = LIST.exec(lines[i]);
        if (current && current[1].length <= indent + 1 && /\d/.test(current[2]) === ordered) {
          items.push([current[3]]);
          i++;
        } else if (items.length && lines[i].trim() && (/^\s/.test(lines[i]) || !LIST.exec(lines[i])) && !/^\s{0,3}(#|>|```|~~~)/.test(lines[i])) {
          items[items.length - 1].push(lines[i].slice(Math.min(indent + 2, lines[i].search(/\S/))));
          i++;
        } else if (!lines[i].trim() && i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && items.length) {
          items[items.length - 1].push('');
          i++;
        } else break;
      }
      const render = parts => {
        const [first, ...rest] = parts;
        const task = /^\[([ xX])\]\s+(.*)$/.exec(first);
        const label = task ? `<span class="task">${task[1] === ' ' ? '☐' : '☑'}</span> ${inline(task[2], base)}` : inline(first, base);
        return `<li>${label}${rest.length && depth < 8 ? blocks(rest, base, depth + 1) : ''}</li>`;
      };
      html.push(`<${ordered ? 'ol' : 'ul'}>${items.map(render).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>)/.test(lines[i]) && !LIST.exec(lines[i]) && !/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    html.push(`<p>${inline(para.join('\n'), base)}</p>`);
  }
  return html.join('\n');
}

/** 拿掉作者寫的 HTML，但程式碼區塊與行內程式碼原樣保留（裡面的標籤要當文字顯示）。 */
function stripOutsideCode(text) {
  const out = [];
  let prose = [];
  let fence = null;
  const flush = () => {
    if (!prose.length) return;
    const kept = [];
    const held = prose.join('\n').replace(/(`+)[^`\n]*?[^`\n]?\1(?!`)/g, code => `\u0001${kept.push(code) - 1}\u0001`);
    out.push(stripHtml(held).replace(/\u0001(\d+)\u0001/g, (_, i) => kept[Number(i)]));
    prose = [];
  };
  for (const line of text.split('\n')) {
    const mark = /^\s*(```+|~~~+)/.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = null;
    } else if (mark) {
      flush();
      out.push(line);
      fence = mark;
    } else prose.push(line);
  }
  flush();
  return out.join('\n');
}

/** 圖片讀不到時代替它的文字；網頁照介面語言換掉。 */
let imageLabel = alt => `［圖片：${alt}］`;
export const setImageLabel = fn => { imageLabel = fn; };

/** 自述文件轉成安全的 HTML；`base` 是原始檔所在的資料夾網址，用來補相對路徑。 */
export function renderMarkdown(text, base = '') {
  return blocks(stripOutsideCode(String(text ?? '').replace(/\r\n?/g, '\n')).split('\n'), base);
}
