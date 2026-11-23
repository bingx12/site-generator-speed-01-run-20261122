// solve.js — a faster drop-in for makefun-site 1.0.0.
//
// Written from the makefun-site 1.0.0 spec (vendor README) and its reference
// semantics, as an original implementation: single-pass line lexer, a batching
// inline scanner (plain runs are sliced and escaped whole instead of one
// character at a time), cached slugify, per-directory slug counters, and
// templates compiled to plain JS functions (with an interpreter fallback if
// compilation is ever refused). No dependency, no I/O, no cross-case state:
// every run() call builds its own caches from its input alone.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const CMP = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const RESERVED = ['posts', 'tags', 'page'];
const MARK_RE = /\p{M}/gu;
const ESC_RE = /[&<>"']/g;
const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const CONTINUED = /^ {2,}\S/;
const BLANK = /^[ \t]*$/;

/** HTML escaping: & < > " ' and nothing else. Single-threaded and never
 * re-entered mid-scan, so one shared /g pattern is safe. */
function esc(s) {
  ESC_RE.lastIndex = 0;
  let m;
  let out = '';
  let last = 0;
  while ((m = ESC_RE.exec(s)) !== null) {
    out += s.slice(last, m.index) + ENT[m[0]];
    last = m.index + 1;
  }
  if (last === 0) return s;
  return out + s.slice(last);
}

/** A code unit of `s` at `i` is a whitespace character (the \s set). */
function isWS(c) {
  if (c < 128) return c === 32 || (c >= 9 && c <= 13);
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** `line` is blank: spaces and tabs only. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs dropped at both ends. */
function trimLine(line) {
  const f = line.charCodeAt(0);
  const l = line.charCodeAt(line.length - 1);
  if (f !== 32 && f !== 9 && l !== 32 && l !== 9) return line;
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** `s` with spaces and tabs dropped at its end. */
function stripTrailing(s) {
  let b = s.length;
  while (b > 0 && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(0, b);
}

/** Whether `line` (a fence candidate) is only backticks plus spaces/tabs from `from`. */
function onlySpaces(line, from) {
  for (let i = from; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** A fence opening: its language, or null. ` ```lang ` then spaces/tabs only. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  if (!onlySpaces(line, i)) return null;
  return line.slice(3, i);
}

/** Whether `line` closes a fence: three backticks, spaces/tabs after. */
function fenceClose(line) {
  return line.charCodeAt(0) === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && onlySpaces(line, 3);
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break: `---` or `***`, spaces/tabs after. */
function isHr(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  return onlySpaces(line, 3);
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  if (isBlank(line)) return true;
  const c = line.charCodeAt(0);
  if (c === 96) return fenceLang(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

// ---------------------------------------------------------------- slugs and dates

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of other characters one `-`, at most 64 chars. */
function slugifySlow(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/**
 * `slug` made unique against `taken` (and added to it): the first of slug,
 * slug-2, slug-3 ... not taken. `next` remembers the next suffix to try per
 * base slug, which is exact because `taken` only grows.
 */
function uniqueSlug(slug, taken, next) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = next.get(slug) || 2;
  let out;
  while (taken.has((out = `${slug}-${n}`))) n++;
  next.set(slug, n + 1);
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

// ---------------------------------------------------------------- front matter

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigit(c) {
  return c >= 48 && c <= 57;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw.charCodeAt(i))) {
            ok = false;
            break;
          }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t.charCodeAt(i);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "slug": not a slug' };
      }
      if (raw.charCodeAt(0) === 45 || raw.charCodeAt(raw.length - 1) === 45 || raw.includes('--')) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter: { data, bodyStart } (the first body line's index
 * in `lines`), or { error } with the first reason it is refused.
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    const ci = line.indexOf(':');
    if (ci <= 0) return { error: `line ${i + 1} is not "key: value"` };
    let keyOk = true;
    for (let k = 0; k < ci; k++) {
      const c = line.charCodeAt(k);
      if (!((c >= 97 && c <= 122) || c === 95)) {
        keyOk = false;
        break;
      }
    }
    if (!keyOk) return { error: `line ${i + 1} is not "key: value"` };
    let raw;
    if (ci === line.length - 1) raw = '';
    else if (line.charCodeAt(ci + 1) === 32) raw = line.slice(ci + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    raw = stripTrailing(raw);
    const key = line.slice(0, ci);
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- Markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const ESC1 = { '>': '&gt;' };

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const SPEC_RE = /[\\`*\[]/g;

/** The next inline special (`\`, backtick, `*` or `[`) at or after `from`, or -1. */
function nextSpecial(s, from) {
  SPEC_RE.lastIndex = from;
  const m = SPEC_RE.exec(s);
  return m === null ? -1 : m.index;
}

/**
 * `s` rendered inline, appended to `out`; `link(target)` is a link's href.
 * Plain runs are sliced whole and escaped in one pass, so the common text
 * costs a few native scans instead of one call per character.
 */
function inlineInto(s, link, out) {
  const n = s.length;
  let i = 0;
  let start = 0;
  while (true) {
    const j = nextSpecial(s, i);
    if (j === -1) break;
    const c = s.charCodeAt(j);
    if (c === 92) {
      // Backslash: an escapable character after it is written escaped.
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        if (j > start) out.push(esc(s.slice(start, j)));
        const ch = s[j + 1];
        out.push(ESC1[ch] || ch);
        i = j + 2;
        start = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > start) out.push(esc(s.slice(start, j)));
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        start = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > start) out.push(esc(s.slice(start, j)));
          out.push('<strong>');
          inlineInto(s.slice(j + 2, k), link, out);
          out.push('</strong>');
          i = k + 2;
          start = i;
        } else {
          i = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > start) out.push(esc(s.slice(start, j)));
        out.push('<em>');
        inlineInto(s.slice(j + 1, k), link, out);
        out.push('</em>');
        i = k + 1;
        start = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    // `[`: a link, or a literal `[` when the target does not read.
    const k = findUnescaped(s, ']', j + 1);
    const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      if (j > start) out.push(esc(s.slice(start, j)));
      out.push('<a href="', esc(link(target)), '">');
      inlineInto(s.slice(j + 1, k), link, out);
      out.push('</a>');
      i = m + 1;
      start = i;
    } else {
      i = j + 1;
    }
  }
  if (n > start) out.push(esc(s.slice(start, n)));
}

/** `s` rendered inline, as one string. */
function inlineStr(s, link) {
  const out = [];
  inlineInto(s, link, out);
  return out.join('');
}

/** The words of the body lines: runs of characters other than whitespace. */
function wordCount(lines, lo, hi) {
  let n = 0;
  for (let li = lo; li < hi; li++) {
    const line = lines[li];
    let inW = false;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      // A line holds no \n or \r; its ASCII whitespace is space, tab, \v, \f.
      if (c === 32 || c === 9 || c === 11 || c === 12) inW = false;
      else if (c >= 128 && isWS(c)) inW = false;
      else if (!inW) {
        inW = true;
        n++;
      }
    }
  }
  return n;
}

/**
 * The body lines `lines[lo..hi)` rendered: { html, toc, excerpt }. `link`
 * resolves a link target to its href, `slugOf` slugs heading text.
 */
function renderMarkdown(lines, lo, hi, link, slugOf) {
  const ids = new Set();
  const idsNext = new Map();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = lo;
  while (i < hi) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < hi && !fenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = lang === '' ? '' : ` class="language-${lang}"`;
        blocks.push(`<pre><code${cls}>`);
        for (const l of body) {
          blocks.push(esc(l));
          blocks.push('\n');
        }
        blocks.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugOf(heading.text), ids, idsNext);
        const html = inlineStr(heading.text, link);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        blocks.push('<hr>\n');
        i++;
        continue;
      }
    }
    if (line.charCodeAt(0) === 62) {
      let text = '';
      let first = true;
      while (i < hi && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        const t = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') {
          if (!first) text += '\n';
          first = false;
          text += t;
        }
      }
      blocks.push(first ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inlineStr(text, link)}</p>\n</blockquote>\n`);
      continue;
    }
    const b0 = line.charCodeAt(0);
    const bullet = (b0 === 45 || b0 === 42) && line.charCodeAt(1) === 32;
    let ordered = null;
    if (!bullet) {
      let d = 0;
      while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
      if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) ordered = { start: Number(line.slice(0, d)), at: d + 2 };
    }
    if (bullet || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < hi) {
        const l = lines[i];
        if (isOrdered) {
          let d = 0;
          while (d < l.length && l.charCodeAt(d) >= 48 && l.charCodeAt(d) <= 57) d++;
          if (d >= 1 && d <= 9 && l.charCodeAt(d) === 46 && l.charCodeAt(d + 1) === 32) {
            items.push(trimLine(l.slice(d + 2)));
            i++;
            continue;
          }
        } else if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
          items.push(trimLine(l.slice(2)));
          i++;
          continue;
        }
        if (CONTINUED.test(l)) {
          items[items.length - 1] += `\n${trimLine(l)}`;
          i++;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.start !== 1 ? `<ol start="${ordered.start}">` : `<${tag}>`;
      blocks.push(`${open}\n`);
      for (const item of items) {
        blocks.push('<li>');
        inlineInto(item, link, blocks);
        blocks.push('</li>\n');
      }
      blocks.push(`</${tag}>\n`);
      continue;
    }
    let text = trimLine(line);
    i++;
    while (i < hi && !endsParagraph(lines[i])) {
      text += `\n${trimLine(lines[i++])}`;
    }
    if (excerpt === null) {
      const html = inlineStr(text, link);
      excerpt = html;
      blocks.push(`<p>${html}</p>\n`);
    } else {
      blocks.push('<p>');
      inlineInto(text, link, blocks);
      blocks.push('</p>\n');
    }
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lk(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function txt(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(txt).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Lookup plus text conversion, in one call: the value at `path`, as text. */
function rv(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return '';
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return '';
    v = v[path[k]];
  }
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(txt).join(', ');
  return '';
}

/** Lookup plus text conversion plus HTML escaping, in one call. */
function ev(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return '';
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return '';
    v = v[path[k]];
  }
  if (typeof v === 'string') return esc(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return esc(v.map(txt).join(', '));
  return '';
}

/** Lookup plus truthiness, in one call. */
function iv(scope, path) {
  const v = lk(scope, path);
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Compile parsed `nodes` to a function (helpers, scope, depth, out) that appends the rendered string to `out`. */
function compileTemplate(nodes) {
  let code = '';
  let uid = 0;
  const gen = (ns, sv, depth) => {
    for (const n of ns) {
      if (n.kind === 'text') code += `o.push(${JSON.stringify(n.text)});\n`;
      else if (n.kind === 'var') code += `o.push(H.ev(${sv},${JSON.stringify(n.path)}));\n`;
      else if (n.kind === 'raw') code += `o.push(H.rv(${sv},${JSON.stringify(n.path)}));\n`;
      else if (n.kind === 'if') {
        code += `if(H.iv(${sv},${JSON.stringify(n.path)})!==${n.not}){\n`;
        gen(n.then, sv, depth);
        if (n.else !== null) {
          code += '}else{\n';
          gen(n.else, sv, depth);
        }
        code += '}\n';
      } else if (n.kind === 'for') {
        const id = uid++;
        const child = `s${depth + 1}`;
        // One scope object per execution of the loop, mutated per element:
        // rendering is synchronous, so nothing observes the previous element.
        code += `var _x${id}=H.lk(${sv},${JSON.stringify(n.path)});\n`;
        code += `if(Array.isArray(_x${id})){var ${child}={vars:{},parent:${sv}};var _l${id}={index:0,first:false,last:false,length:_x${id}.length};for(var _k${id}=0;_k${id}<_x${id}.length;_k${id}++){${child}.vars[${JSON.stringify(n.name)}]=_x${id}[_k${id}];_l${id}.index=_k${id}+1;_l${id}.first=_k${id}===0;_l${id}.last=_k${id}===_x${id}.length-1;${child}.vars.loop=_l${id};\n`;
        gen(n.body, child, depth + 1);
        code += '}}\n';
      } else if (n.kind === 'include') {
        const id = uid++;
        code += `var _t${id}=H.tm.get(${JSON.stringify(n.name)});\n`;
        code += `if(_t${id}!==undefined&&d<8)_t${id}(H,${sv},d+1,o);\n`;
      }
    }
  };
  gen(nodes, 's0', 0);
  return new Function('H', 's0', 'd', 'o', code);
}

/** The interpreter, used only when compilation is refused: `nodes` rendered in `scope`. */
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'text') out += n.text;
    else if (n.kind === 'var') out += esc(txt(lk(scope, n.path)));
    else if (n.kind === 'raw') out += txt(lk(scope, n.path));
    else if (n.kind === 'if') {
      const v = truthy(lk(scope, n.path));
      const branch = v !== n.not ? n.then : n.else;
      if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
    } else if (n.kind === 'for') {
      const xs = lk(scope, n.path);
      if (!Array.isArray(xs)) continue;
      xs.forEach((x, k) => {
        const vars = { [n.name]: x, loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
        out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
      });
    } else if (n.kind === 'include') {
      const t = ctx.templates.get(n.name);
      if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the build

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const slugOf = (s) => {
    let v = slugCache.get(s);
    if (v === undefined) {
      v = slugifySlow(s);
      slugCache.set(s, v);
    }
    return v;
  };

  // Templates, parsed in code-unit order of name; one that does not parse is
  // reported and left out, as if it were not there.
  const report = [];
  const tmNodes = new Map();
  for (const name of Object.keys(input.templates).sort(CMP)) {
    try {
      tmNodes.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  let compiled = true;
  const tmFns = new Map();
  try {
    for (const [name, nodes] of tmNodes) tmFns.set(name, compileTemplate(nodes));
  } catch {
    compiled = false;
    tmFns.clear();
  }
  const H = { lk, txt, esc, truthy, tm: tmFns, ev, rv, iv };
  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of path; `.md` is a source, the rest static.
  const files = [...input.files].sort((x, y) => CMP(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order: refused sources and drafts are reported
  // and dropped, the first failing check the one reported.
  const kept = [];
  for (const s of sources) {
    const lines = s.text.split('\n');
    const fm = parseFrontMatter(lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.lines = lines;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!tmNodes.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug, unique in its directory, in source order.
  const takenByDir = new Map();
  const takenIn = (dir) => {
    let t = takenByDir.get(dir);
    if (t === undefined) {
      t = { taken: new Set(dir === '' ? RESERVED : []), next: new Map() };
      takenByDir.set(dir, t);
    }
    return t;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const t = takenIn(dir);
    s.slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), t.taken, t.next);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.lines, s.bodyStart, s.lines.length, link, slugOf);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.readingMinutes = Math.max(1, Math.ceil(wordCount(s.lines, s.bodyStart, s.lines.length) / 200));
  }

  // Collections: the posts, newest first, equal dates by slug; neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => CMP(y.data.date, x.data.date) || CMP(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, each named as first met walking the posts in
  // collection order; ordered by count, then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugOf(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ name, slug });
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || CMP(x.slug, y.slug));

  // The records templates read.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => {
    if (s.post) {
      return {
        ...cards.get(s),
        slug: s.slug,
        content: s.html,
        toc: s.toc,
        newer: linkOf(s.newer ?? null),
        older: linkOf(s.older ?? null),
        is_post: true,
      };
    }
    return {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: s.readingMinutes,
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: null,
      older: null,
      is_post: false,
    };
  };

  // Layouts: every page through its layout, the index and tag pages.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, scope) => {
    if (compiled) {
      const fn = tmFns.get(name);
      if (fn === undefined) return null;
      const o = [];
      fn(H, scope, 0, o);
      return o.join('');
    }
    const nodes = tmNodes.get(name);
    return nodes === undefined ? null : renderNodes(nodes, scope, { templates: tmNodes, escape: esc }, 0);
  };
  // One vars object and one scope object per render kind, mutated per
  // render: rendering is synchronous, and each kind's keys are exactly the
  // reference's.
  const pageScope = { vars: { site, tags: allTags, recent, page: null }, parent: null };
  const indexScope = { vars: { site, tags: allTags, recent, posts: null, pager: null }, parent: null };
  const tagScope = { vars: { site, tags: allTags, recent, tag: null }, parent: null };
  const tagsScope = { vars: { site, tags: allTags, recent }, parent: null };
  for (const s of kept) {
    pageScope.vars.page = pageOf(s);
    output[`${s.outDir}/index.html`] = render(s.layout, pageScope);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    indexScope.vars.posts = posts.slice((k - 1) * per, k * per).map((p) => cards.get(p));
    indexScope.vars.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
    const html = render('index', indexScope);
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    tagScope.vars.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
    const html = render('tag', tagScope);
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', tagsScope);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported above and each broken link, sorted,
  // then the counts.
  const lines = [...report, ...broken].sort(CMP);
  lines.push(`built ${kept.length - posts.length} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
