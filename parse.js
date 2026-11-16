// parse.js — a fast Markdown renderer that returns exactly the HTML marked
// 18.1.3 renders with its default options (GFM on, breaks off). Written from
// scratch in this session from the CommonMark 0.31.2 and GFM 0.29 specifications
// and from observing marked's behaviour on the spec examples. It is a
// dependency-free ES module exporting parse(markdown).
//
// Layout: small helpers, the inline parser (a scanner plus a delimiter stack
// for emphasis / strong emphasis / strikethrough), then the block parser (a
// line based container walk: block quotes, lists, leaf blocks), then the
// renderer that turns the block tree into HTML.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_ALL_RE = /[&<>"']/g;
const ESC_NOENC_RE = /&(?!(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);)|[<>"']/g;

// Escape &, <, >, " and ' (used for code spans, code blocks and autolink text).
function escFull(s) {
  if (!ESC_ALL_RE.test(s)) return s;
  return s.replace(ESC_ALL_RE, (c) => ESC_MAP[c]);
}

// Escape text, but leave an & alone when it starts something that looks like
// a character reference (&word; or &#123; or &#xAB;). This is how marked
// renders plain text: named entities are never decoded, they pass through.
function escText(s) {
  if (!ESC_NOENC_RE.test(s)) return s;
  return s.replace(ESC_NOENC_RE, (c) => ESC_MAP[c]);
}

function isDigit(c) { return c >= 48 && c <= 57; }
function isHex(c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102); }
function isAlphaNumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// Unicode whitespace (CommonMark's set).
function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
}

const ASCII_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
function isPunctCode(c) {
  if (c < 128) return ASCII_PUNCT.indexOf(String.fromCharCode(c)) !== -1;
  return PUNCT_RE.test(String.fromCodePoint(c));
}
const PUNCT_RE = /[\p{P}\p{S}]/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;
function isAlnumChar(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isAlphaNumCode(c);
  return ALNUM_RE.test(ch);
}

// Decode a numeric character reference at s[i] === '&' (&#65;, &#x41;).
// Returns { text, end } — the decoded text and the index just past the
// reference — or null when it is not a valid reference. &#38; decodes to
// the literal text "&amp;" (marked's unescape quirk).
function numericRef(s, i) {
  if (s.charCodeAt(i + 1) !== 35) return null; // '#'
  let j = i + 2;
  let hex = false;
  const c0 = s.charCodeAt(j);
  if (c0 === 120 || c0 === 88) { hex = true; j++; } // 'x' / 'X'
  const start = j;
  while (j < s.length && (hex ? isHex(s.charCodeAt(j)) : isDigit(s.charCodeAt(j)))) j++;
  const len = j - start;
  if (len === 0 || len > (hex ? 6 : 7) || s.charCodeAt(j) !== 59) return null; // ';'
  const v = parseInt(s.slice(start, j), hex ? 16 : 10);
  const end = j + 1;
  if (v === 0 || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) return { text: '\uFFFD', end };
  if (v === 38) return { text: '&amp;', end };
  return { text: String.fromCodePoint(v), end };
}

// Clean a link destination the way marked does: encodeURI, then put back
// any %25 (so existing %XX escapes survive). Returns null on failure
// (a lone surrogate makes encodeURI throw), which makes the link render as
// plain text.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Unescape backslash-escaped punctuation/symbol characters in a link
// destination or title: \X becomes X when X is punctuation or a symbol.
function unescapePunct(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length) { // backslash
      const n = s.charCodeAt(i + 1);
      if (isPunctCode(n)) {
        out += s.slice(start, i) + s[i + 1];
        i++;
        start = i + 1;
      }
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Split a table row into cells, marked's splitCells: an unescaped | is a
// separator (a space is inserted before it, then the row is split on " |"),
// an escaped \| stays and becomes | inside the cell. Leading and trailing
// empty cells (from edge pipes) are dropped; the result is padded or cut to
// `count` cells when count is given.
function splitCells(row, count) {
  const n = row.length;
  let t = '';
  let start = 0;
  for (let i = 0; i < n; i++) {
    if (row.charCodeAt(i) === 124) { // '|'
      let backslashes = 0;
      for (let p = i - 1; p >= 0 && row.charCodeAt(p) === 92; p--) backslashes++;
      if (backslashes % 2 === 0) {
        t += row.slice(start, i) + ' |';
        start = i + 1;
      }
    }
  }
  t += row.slice(start);
  const parts = t.split(' |');
  if (parts.length > 0 && parts[0].trim() === '') parts.shift();
  if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop();
  if (count !== undefined) {
    if (parts.length > count) parts.length = count;
    else while (parts.length < count) parts.push('');
  }
  for (let i = 0; i < parts.length; i++) {
    let cell = parts[i].trim();
    if (cell.indexOf('\\|') !== -1) cell = cell.replace(/\\\|/g, '|');
    parts[i] = cell;
  }
  return parts;
}

// Normalise a link label for lookup: trim, collapse inner whitespace to
// single spaces, and case-fold (lower, upper, lower, as marked does).
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// ---------------------------------------------------------------------------
// Inline HTML tag scanning
// ---------------------------------------------------------------------------

// Attribute values in a tag may hold a > inside quotes; scan an open tag
// starting at s[i] === '<'. Returns the index just past '>' or -1.
function scanOpenTag(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n || !isAlphaTagStart(s.charCodeAt(j))) return -1;
  j++;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45) { j++; continue; }
    break;
  }
  while (true) {
    // skip whitespace
    let k = j;
    while (k < n && isSpaceCode(s.charCodeAt(k))) k++;
    if (k >= n) return -1;
    const c = s.charCodeAt(k);
    if (c === 62) return k + 1; // '>'
    if (c === 47) { // '/'
      if (s.charCodeAt(k + 1) === 62) return k + 2;
      return -1;
    }
    // An attribute name must be preceded by whitespace: after the tag
    // name (or a value) a bare name char is not a valid tag.
    if (k === j) return -1;
    // attribute name
    if (!isAttrNameStart(s.charCodeAt(k))) return -1;
    j = k + 1;
    while (j < n) {
      const d = s.charCodeAt(j);
      if ((d >= 97 && d <= 122) || (d >= 65 && d <= 90) || (d >= 48 && d <= 57) ||
          d === 46 || d === 58 || d === 45 || d === 95) { j++; continue; }
      break;
    }
    k = j;
    while (k < n && isSpaceCode(s.charCodeAt(k))) k++;
    if (k < n && s.charCodeAt(k) === 61) { // '='
      k++;
      while (k < n && isSpaceCode(s.charCodeAt(k))) k++;
      if (k >= n) return -1;
      const q = s.charCodeAt(k);
      if (q === 34 || q === 39) { // quoted value
        const end = s.indexOf(String.fromCharCode(q), k + 1);
        if (end === -1) return -1;
        j = end + 1;
      } else {
        // unquoted value: no spaces, quotes, =, <, > or backtick
        j = k;
        while (j < n) {
          const d = s.charCodeAt(j);
          if (isSpaceCode(d) || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          j++;
        }
        if (j === k) return -1;
      }
    }
  }
}
function isAlphaTagStart(c) { return (c >= 97 && c <= 122) || (c >= 65 && c <= 90); }
function isAttrNameStart(c) {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 58;
}

// Scan an inline HTML construct starting at s[i] === '<'.
// Returns the index just past the construct, or -1 when it is not raw HTML.
function scanTag(s, i) {
  const n = s.length;
  if (s.startsWith('<!--', i)) {
    // Abrupt closing of an empty comment: <!--> and <!---> are complete.
    if (s.charCodeAt(i + 4) === 62) return i + 5;
    if (s.charCodeAt(i + 4) === 45 && s.charCodeAt(i + 5) === 62) return i + 6;
    const end = s.indexOf('-->', i + 4);
    return end === -1 ? n : end + 3;
  }
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    return end === -1 ? -1 : end + 2;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const end = s.indexOf(']]>', i + 9);
    return end === -1 ? -1 : end + 3;
  }
  if (s.startsWith('<!', i) && i + 2 < n && isAlphaTagStart(s.charCodeAt(i + 2))) {
    // Declaration: <! + letters + whitespace + up to the first >.
    let j = i + 2;
    while (j < n && isAlphaTagStart(s.charCodeAt(j))) j++;
    if (j < n && isSpaceCode(s.charCodeAt(j))) {
      const end = s.indexOf('>', j);
      return end === -1 ? -1 : end + 1;
    }
    return -1;
  }
  if (s.startsWith('</', i)) {
    let j = i + 2;
    if (j >= n || !isAlphaTagStart(s.charCodeAt(j))) return -1;
    j++;
    while (j < n) {
      const c = s.charCodeAt(j);
      if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45) { j++; continue; }
      break;
    }
    while (j < n && isSpaceCode(s.charCodeAt(j))) j++;
    return (j < n && s.charCodeAt(j) === 62) ? j + 1 : -1;
  }
  return scanOpenTag(s, i);
}

// The tag name of a raw HTML fragment (lower-cased), for <a>/<pre> handling.
function tagNameOf(raw) {
  let j = raw.charCodeAt(1) === 47 ? 2 : 1; // skip '<' and optional '/'
  let name = '';
  while (j < raw.length) {
    const c = raw.charCodeAt(j);
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45) {
      name += raw[j];
      j++;
    } else break;
  }
  return name.toLowerCase();
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------
// Node kinds: 0 text, 1 code span, 2 hard break, 3 raw html, 4 link,
// 5 image, 6 em, 7 strong, 8 del, 9 delimiter (temporary, resolved later).

// A character of a bare email address's local part, as marked's extended
// autolink rule sees it: letters, digits, and . _ + - only (the wider RFC
// set applies to <...> autolinks, not to bare addresses).
function isEmailLocalChar(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    c === 46 || c === 95 || c === 43 || c === 45;
}
function isDomainChar(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45;
}
function isWordChar(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

// Match an email address starting at s[i]. Returns the index just past it,
// or -1. Local part, @, then a domain with at least one dot, ending in a
// letter or digit, not followed by a word character or hyphen.
// Email end position after the domain (no trailing-character check).
function matchEmailPrefix(s, i) {
  const n = s.length;
  let j = i;
  while (j < n && isEmailLocalChar(s.charCodeAt(j))) j++;
  if (j === i || j >= n || s.charCodeAt(j) !== 64) return -1; // '@'
  j++;
  let k = j;
  while (k < n && (isDomainChar(s.charCodeAt(k)) || s.charCodeAt(k) === 95)) k++;
  if (k === j) return -1;
  j = k;
  let dots = 0;
  while (j < n && s.charCodeAt(j) === 46) { // '.'
    let m = j + 1;
    while (m < n && (isDomainChar(s.charCodeAt(m)) || s.charCodeAt(m) === 95)) m++;
    while (m > j + 1 && !isAlphaNumCode(s.charCodeAt(m - 1))) m--;
    if (m === j + 1) break;
    j = m;
    dots++;
  }
  if (dots === 0) return -1;
  return j;
}

function matchEmail(s, i) {
  let end = matchEmailPrefix(s, i);
  if (end === -1) return -1;
  const n = s.length;
  if (end >= n || (!isWordChar(s.charCodeAt(end)) && s.charCodeAt(end) !== 45)) return end;
  // The regex backtracks: the longest domain fails the lookahead, so
  // drop the last dot-segment and retry (the char after the shorter
  // domain is '.', which passes the lookahead). The domain must keep
  // at least one dot.
  const at = s.indexOf('@', i);
  for (;;) {
    let dot = -1;
    for (let p = end - 1; p > at; p--) {
      if (s.charCodeAt(p) === 46) { dot = p; break; }
    }
    if (dot === -1) return -1;
    let keepsDot = false;
    for (let p = at + 1; p < dot; p++) {
      if (s.charCodeAt(p) === 46) { keepsDot = true; break; }
    }
    if (!keepsDot) return -1;
    end = dot;
    if (end >= n || (!isWordChar(s.charCodeAt(end)) && s.charCodeAt(end) !== 45)) return end;
  }
}

// Match http://, https:// or ftp:// (any case) at s[i]; returns the index
// just past "://", or -1.
function matchScheme(s, i) {
  const t = s.slice(i, i + 8).toLowerCase();
  if (t.startsWith('http://')) return i + 7;
  if (t.startsWith('https://')) return i + 8;
  if (t.startsWith('ftp://')) return i + 6;
  return -1;
}

// After a scheme or www., match the domain and the rest of the URL
// (everything up to whitespace or '<'). Returns the end index or -1.
function matchUrlTail(s, j) {
  const n = s.length;
  let k = j;
  let ok = false;
  while (true) {
    let m = k;
    while (m < n && isDomainChar(s.charCodeAt(m))) m++;
    if (m === k) break;
    ok = true;
    k = m;
    if (s.charCodeAt(k) === 46) { k++; continue; }
    break;
  }
  if (!ok) return -1;
  while (k < n && !isSpaceCode(s.charCodeAt(k)) && s.charCodeAt(k) !== 60) k++;
  return k;
}

function isBackpedalPunct(c) {
  return c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 ||
    c === 42 || c === 95 || c === 39 || c === 34 || c === 126 || c === 41;
}

// Trim a URL the way marked's _backpedal does: the longest prefix made of
// runs of ordinary characters, balanced (....) groups, & not starting an
// entity-like suffix, and punctuation runs that are not at the very end.
function backpedal(u) {
  const n = u.length;
  let i = 0;
  while (i < n) {
    const c = u.charCodeAt(i);
    if (c === 40) { // '('
      const j = u.indexOf(')', i + 1);
      if (j === -1) break;
      i = j + 1;
      continue;
    }
    if (c === 38) { // '&'
      let k = i + 1;
      while (k < n && isWordChar(u.charCodeAt(k))) k++;
      if (k > i + 1 && k < n && u.charCodeAt(k) === 59 && k === n - 1) break;
      i++;
      continue;
    }
    if (isBackpedalPunct(c)) {
      let j = i;
      while (j < n && isBackpedalPunct(u.charCodeAt(j))) j++;
      if (j === n) break;
      i = j;
      continue;
    }
    i++;
  }
  return i;
}

// Try an extended (GFM) autolink at s[i]: mailto:/xmpp:, a scheme:// URL,
// www., or a bare email address. Returns {end, href, text} or null.
function tryUrl(s, i) {
  const n = s.length;
  if (s.startsWith('mailto:', i) || s.startsWith('xmpp:', i)) {
    const proto = s.startsWith('mailto:', i) ? 'mailto:' : 'xmpp:';
    const em = matchEmail(s, i + proto.length);
    if (em === -1) return null;
    let end = em;
    if (proto === 'xmpp:' && s.charCodeAt(end) === 47) {
      let j = end + 1;
      while (j < n) {
        const c = s.charCodeAt(j);
        if (isAlphaNumCode(c) || c === 64 || c === 46) { j++; continue; }
        break;
      }
      if (j > end + 1) end = j;
    }
    return { end, href: s.slice(i, end), text: s.slice(i, end) };
  }
  let tail = -1;
  let isWww = false;
  if (s.startsWith('www.', i)) {
    isWww = true;
    tail = matchUrlTail(s, i + 4);
  } else {
    const sc = matchScheme(s, i);
    if (sc !== -1) tail = matchUrlTail(s, sc);
  }
  if (tail !== -1) {
    const len = backpedal(s.slice(i, tail));
    if (len === 0) return null;
    const text = s.slice(i, i + len);
    return { end: i + len, href: isWww ? 'http://' + text : text, text };
  }
  const em = matchEmail(s, i);
  if (em !== -1) {
    return { end: em, href: 'mailto:' + s.slice(i, em), text: s.slice(i, em) };
  }
  return null;
}

// Try a <...> autolink at s[i] === '<'. Returns {end, href, text} or null.
function tryAutolink(s, i) {
  const n = s.length;
  let j = i + 1;
  // scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31} :
  if (j < n && isAlphaTagStart(s.charCodeAt(j))) {
    let k = j + 1;
    while (k < n) {
      const c = s.charCodeAt(k);
      if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) ||
          c === 43 || c === 45 || c === 46) { k++; continue; }
      break;
    }
    if (k - j >= 2 && k - j <= 32 && s.charCodeAt(k) === 58) {
      let m = k + 1;
      while (m < n) {
        const c = s.charCodeAt(m);
        if (isSpaceCode(c) || c < 32 || c === 60 || c === 62) break;
        m++;
      }
      if (m < n && s.charCodeAt(m) === 62) {
        const inner = s.slice(i + 1, m);
        return { end: m + 1, href: inner, text: inner };
      }
    }
  }
  const em = matchEmail(s, j);
  if (em !== -1 && s.charCodeAt(em) === 62) {
    const inner = s.slice(i + 1, em);
    return { end: em + 1, href: 'mailto:' + inner, text: inner };
  }
  return null;
}

function runLength(s, i, ch) {
  let j = i;
  while (j < s.length && s.charCodeAt(j) === ch) j++;
  return j - i;
}

// Find a closing backtick run of exactly `len` backticks at or after s[i].
// Returns the index of the run, or -1.
function findBacktickRun(s, i, len) {
  const n = s.length;
  let j = i;
  while (j < n) {
    if (s.charCodeAt(j) === 96) {
      const m = runLength(s, j, 96);
      if (m === len) return j;
      j += m;
    } else j++;
  }
  return -1;
}

// Scan a link label starting at s[i] === '['. Returns {label, end} with
// end just past the matching ']', or null. Nested [...] groups are allowed
// one level deep (their contents hold no unescaped brackets), as in marked.
function scanLabel(s, i, allowNested) {
  const n = s.length;
  let j = i + 1;
  let depth = 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 96) {
      const m = runLength(s, j, 96);
      // marked's label regex: a code span is closed by ANY later backtick
      // run (`` `+(?!`)[^`]*?`+(?!`) ``), and a run immediately before ']'
      // is part of the label (`` ``+(?=\]) ``) — but a SINGLE backtick
      // opener right before ']' is NOT: it starts a code span that
      // swallows the ']' (cm-525 [foo`](/uri)` is not a link), while a
      // run of 2+ before ']' does close the label (cm-537's double
      // variant is a link). So the ']' shortcut applies only for m >= 2.
      if (m >= 2 && s.charCodeAt(j + m) === 93) { j = j + m; continue; }
      let k = j + m;
      while (k < n && s.charCodeAt(k) !== 96) k++;
      if (k < n) { j = k + runLength(s, k, 96); continue; }
      return null;
    }
    if (c === 91) {
      if (!allowNested) return null;
      depth++;
      j++;
      continue;
    }
    if (c === 93) {
      depth--;
      if (depth === 0) return { label: s.slice(i + 1, j), end: j + 1 };
      j++;
      continue;
    }
    j++;
  }
  return null;
}

// Scan a reference label (the second [...] of a reference link) at s[i].
// No nested brackets; the label may not be only whitespace. Returns
// {label, end} or null.
function scanRefLabel(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 91) return null;
    if (c === 93) {
      const label = s.slice(i + 1, j);
      if (label.trim() === '') return null;
      return { label, end: j + 1 };
    }
    j++;
  }
  return null;
}

// marked's Be check: a link label that contains a '<' starting an HTML tag
// or autolink that runs past the label's closing ']' is not a link.
function labelHasUnclosedTag(s, labelStart, labelEnd) {
  const n = s.length;
  let j = labelStart + 1;
  while (j < labelEnd) {
    const c = s.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 96) {
      const m = runLength(s, j, 96);
      const close = findBacktickRun(s, j + m, m);
      if (close === -1) return false;
      j = close + m;
      continue;
    }
    if (c === 60) {
      const al = tryAutolink(s, j);
      if (al && al.end > labelEnd) return true;
      const tg = scanTag(s, j);
      if (tg !== -1 && tg > labelEnd) return true;
    }
    j++;
  }
  return false;
}

// Parse a link destination and optional title after '(', at s[i].
// Returns {href, title, end} with end just past ')', or null.
function parseLinkDest(s, i) {
  const n = s.length;
  let j = i;
  while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
  let href = '';
  if (j < n && s.charCodeAt(j) === 60) { // '<' angle destination
    let k = j + 1;
    let ok = false;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 92) { k += 2; continue; }
      if (c === 62) { ok = true; break; }
      if (c === 10 || c === 60) break;
      k++;
    }
    if (!ok) return null;
    let bs = 0;
    for (let p = k - 1; p > j && s.charCodeAt(p) === 92; p--) bs++;
    if (bs % 2 === 1) return null;
    href = s.slice(j + 1, k);
    j = k + 1;
  } else if (j < n && s.charCodeAt(j) === 41) { // ')' empty destination
    href = '';
  } else {
    let k = j;
    let depth = 0;
    let closed = false;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 92) { k += 2; continue; }
      if (c === 32 || c === 9 || c === 10 || c < 32) break;
      if (c === 40) { depth++; k++; continue; }
      if (c === 41) {
        if (depth === 0) { closed = true; break; }
        depth--;
        k++;
        continue;
      }
      k++;
    }
    if (k === j) return null;
    if (!closed && k >= n) return null;
    if (!closed) {
      // stopped at whitespace: a title may follow; remember where the
      // destination ended and let the title logic decide
      href = s.slice(j, k);
      j = k;
    } else {
      href = s.slice(j, k);
      j = k;
    }
    // if we stopped at whitespace, fall through to title parsing; the
    // caller expects j to point at the ')' or at the title start
    if (!closed) {
      // j is at whitespace; continue below
    } else {
      // j is at ')' — no title; skip to the final check
      return finishLinkDest(s, href, '', j, i);
    }
  }
  // Optional title: one whitespace run (spaces/tabs, at most one newline),
  // then a quoted or parenthesised title.
  let title = '';
  let k = j;
  let seenNl = false;
  while (k < n) {
    const c = s.charCodeAt(k);
    if (c === 32 || c === 9) { k++; continue; }
    if (c === 10 && !seenNl) { seenNl = true; k++; continue; }
    break;
  }
  if (k < n && (s.charCodeAt(k) === 34 || s.charCodeAt(k) === 39 || s.charCodeAt(k) === 40)) {
    const q = s.charCodeAt(k);
    const closeCh = q === 40 ? 41 : q;
    let m = k + 1;
    let ok = false;
    while (m < n) {
      const c = s.charCodeAt(m);
      if (c === 92) { m += 2; continue; }
      if (c === closeCh) { ok = true; break; }
      m++;
    }
    if (!ok) return null;
    title = s.slice(k + 1, m);
    k = m + 1;
  } else if (k < n && s.charCodeAt(k) === 41) {
    // no title: already at the closing paren
  } else if (k !== j) {
    // whitespace but no title: the next thing must be ')'
  } else {
    return null; // no whitespace and no title: not a link
  }
  // Skip trailing whitespace/newlines, expect ')'.
  while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
  if (k >= n || s.charCodeAt(k) !== 41) return null;
  return finishLinkDest(s, href, title, k, i);
}

function finishLinkDest(s, href, title, closeParen, openParen) {
  // The closing ')' must not be escaped: an odd number of backslashes
  // immediately before it invalidates the link.
  let bs = 0;
  for (let p = closeParen - 1; p >= 0 && s.charCodeAt(p) === 92; p--) bs++;
  if (bs % 2 === 1) return null;
  return { href: unescapePunct(href), title: title ? unescapePunct(title) : '', end: closeParen + 1 };
}

// ---------------------------------------------------------------------------
// Inline scanner
// ---------------------------------------------------------------------------

const ASCII_PUNCT_SET = new Uint8Array(128);
for (let i = 0; i < ASCII_PUNCT.length; i++) ASCII_PUNCT_SET[ASCII_PUNCT.charCodeAt(i)] = 1;

// Punctuation as marked's GFM `*` rules see it: `~` is a word character,
// not punctuation, so a `*` run next to a `~` is left/right-flanking.
function isPunctStarCode(c) {
  return c !== 126 && isPunctCode(c);
}

function flanking(s, i, len, punctFn) {
  const n = s.length;
  const prev = i > 0 ? s[i - 1] : '\n';
  const next = i + len < n ? s[i + len] : '\n';
  const prevSpace = isSpaceCode(prev.charCodeAt(0));
  const nextSpace = isSpaceCode(next.charCodeAt(0));
  const punct = punctFn || isPunctCode;
  const prevPunct = punct(prev.charCodeAt(0));
  const nextPunct = punct(next.charCodeAt(0));
  const left = !nextSpace && (!nextPunct || prevSpace || prevPunct);
  const right = !prevSpace && (!prevPunct || nextSpace || nextPunct);
  return { prev, next, prevSpace, nextSpace, prevPunct, nextPunct, left, right };
}

// Open/close flags for a delimiter run of `ch` at s[i] with length `len`.
// Mirrors marked's left/right-flanking rules per character: `*` uses the
// GFM punctuation set (`~` excluded), `_` the plain set (`~` is punct),
// `~` the del gate (next char not space/`~`, and when it is punctuation
// the previous char must be absent or punctuation).
function delimFlags(s, i, len, ch) {
  if (ch === '~') {
    const f = flanking(s, i, len);
    // The del left-delimiter only needs the next char to be a non-space,
    // non-`~` char; the opening gate (punctuation after the run, previous
    // token's last char) is checked in tryDel, not here.
    const open = !f.nextSpace && f.next !== '~';
    return { open, close: f.right, fopen: open };
  }
  const f = flanking(s, i, len, ch === '*' ? isPunctStarCode : isPunctCode);
  // `open` is the LDelim condition only (next char is a non-space):
  // marked's emStrong is attempted whenever the LDelim regex matches,
  // and the exact gate (punctuation after the run, previous token's last
  // char) is decided inside tryEmStrong with the token-stream `r`. The
  // raw previous char is not `r`: after a structural token (e.g. an
  // email autolink) `r` is "", so the gate can pass even when the raw
  // previous char is alphanumeric (foo@bar.com*!a* -> <em>!a</em>).
  // `fopen` keeps the raw flanking open, which the email fallback needs.
  const open = !f.nextSpace;
  if (ch === '*') return { open, close: f.right, fopen: f.left };
  return {
    open,
    close: f.right && (!f.left || f.nextPunct),
    fopen: f.left && (!f.right || f.prevPunct),
  };
}

// ---------------------------------------------------------------------------
// marked's emStrong masking and right-delimiter scan (GFM)
// ---------------------------------------------------------------------------
// Before scanning for emphasis, marked hides spans that must not be
// scanned: resolved reference links, code spans, escaped punctuation, and
// whole inline links / raw HTML. The mask keeps the source length, so
// delimiter positions stay aligned. The regexes below are the exact GFM
// rules (marked 18.1.3), re-typed here as literals from the vendor's
// construction; the matching logic in processDelims follows marked's
// emStrong / del tokenizers step by step.

const MASK_OT_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_BLOCKSKIP_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\()\\]|\((?:\\[\s\S]|[^\()\\])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const MASK_REFLINK_SEARCH_RE = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const MASK_LINK_RE = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/;

// Right-delimiter scans (marked ht / kt / Rt, GFM). Groups 1-2 are
// closer-type, 3-4 opener-type, 5-6 ambiguous (rule of 3). The `_` scan
// has no group 6: a `_` run flanked by alphanumerics on both sides is
// never a closer candidate.
const RDELIM_AST_RE = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const RDELIM_UND_RE = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const RDELIM_DEL_RE = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;

// Whether a character (one code point, possibly astral) is punctuation or
// whitespace in marked's `punctuation` rule (space/punct, but never `*`/`_`).
function isPunctOrSpaceStr(ch) {
  if (!ch) return false;
  if (ch === '*' || ch === '_') return false;
  const c = ch.charCodeAt(0);
  if (ch.length === 1) return isSpaceCode(c) || isPunctCode(c);
  return isSpaceCode(c) || PUNCT_RE.test(ch);
}

// marked's linkInText: does the label text contain a link (inline or
// resolved reference) that is not an image?
function maskLinkInText(e, refs) {
  if (e.indexOf('[') === -1) return false;
  for (const n of e.matchAll(MASK_BLOCKSKIP_RE)) {
    if (MASK_LINK_RE.test(n[0]) && e.charAt(n.index - 1) !== '!') return true;
  }
  for (const n of e.matchAll(MASK_REFLINK_SEARCH_RE)) {
    const s = n[0], r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' ||
        !Object.prototype.hasOwnProperty.call(refs, normalizeLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && maskLinkInText(s.slice(1, r - 1), refs))) return true;
  }
  return false;
}

// marked's emStrong mask (#n): hide resolved reflinks, then escaped
// punctuation / code spans, then whole links / code spans / raw HTML.
function maskEmphasis(src, refs) {
  let t = src;
  if (refs && Object.keys(refs).length > 0 && src.includes('[')) {
    const replaceReflink = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.prototype.hasOwnProperty.call(refs, normalizeLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const i = r.slice(1, o - 1);
        if (maskLinkInText(i, refs)) {
          return '[' + i.replace(MASK_REFLINK_SEARCH_RE, replaceReflink) + '][' +
            'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(MASK_REFLINK_SEARCH_RE, replaceReflink);
  }
  t = t.replace(MASK_OT_RE, (n, s, r) =>
    r ? '+'.repeat(n.length)
      : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s
      : n);
  t = t.replace(MASK_BLOCKSKIP_RE, (n) => '[' + 'a'.repeat(n.length - 2) + ']');
  return t;
}

// marked's findClosingDelimiter (fe): for each delimiter char, the start
// index of the last run whose preceding char is not space/tab/newline/
// carriage-return/form-feed; for `~` a single shared index.
function lastPossibleCloser(mask) {
  const res = { '*': -1, '_': -1, '~': -1 };
  const n = mask.length;
  for (let s = 0; s < n; s++) {
    const r = mask[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const o = s === 0 ? '\n' : mask[s - 1];
    let i = s + 1;
    while (i < n && mask[i] === r) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') {
      if (r === '~') res['~'] = s;
      else res[r] = s;
    }
    s = i - 1;
  }
  return res;
}

// Scan inline markdown into a node list (delimiters resolved afterwards).
function scanInline(s, refs, ctx) {
  const n = s.length;
  const nodes = [];
  const delims = [];
  // The emphasis mask (marked's #n): only needed when the string holds a
  // delimiter char; otherwise every delimiter is visible.
  const hasDelim = s.indexOf('*') !== -1 || s.indexOf('_') !== -1 || s.indexOf('~') !== -1;
  const mask = hasDelim ? maskEmphasis(s, refs) : s;
  const lastCloser = hasDelim ? lastPossibleCloser(mask) : null;

  // One code point (astral-aware) at UTF-16 index idx of str, or ''
  // when idx is out of range.
  function oneCodePoint(str, idx) {
    if (idx < 0 || idx >= str.length) return '';
    const cp = str.codePointAt(idx);
    return cp > 0xffff ? str.slice(idx, idx + 2) : str[idx];
  }

  // marked's `r` for the opener D, read off the nodes scanned so far:
  // "" after a structural token, the last raw char of a text run
  // (trailing `_`s skipped — a text token ending in `_` never updates
  // `r`), or the delimiter char itself after another delimiter.
  function prevTokenChar(D) {
    const at = nodes.indexOf(D);
    for (let j = at - 1; j >= 0; j--) {
      const nd = nodes[j];
      if (nd.t === 0) {
        if (nd.esc) return '';
        let e = nd.end;
        while (e > nd.pos && s[e - 1] === '_') e--;
        if (e > nd.pos) return oneCodePoint(s, e - 1);
        continue;
      }
      if (nd.t === 9) {
        if (nd.ch === '_') continue;
        return nd.ch;
      }
      return '';
    }
    return '';
  }

  // Opener context exactly as emStrong computes it: walk back over a
  // run of the same delimiter char in the mask, then read the char
  // before it. `o` uses the token-stream previous char `r`, not the
  // adjusted `n`.
  function openerContext(D, r) {
    const ch = '_';
    let l = D.pos;
    while (l > 0 && mask[l - 1] === ch) l--;
    const p = [...mask.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
    const h = p === '*' || p === '_' || isPunctOrSpaceStr(p);
    let n, u;
    if (l < D.pos) { n = p; u = h; }
    else { n = r; u = isPunctOrSpaceStr(n); }
    return { l, p, h, n, u, o: r === ch };
  }

  // Would marked's emStrong succeed for the `_` opener D, using the
  // nodes built so far? Returns the closer run's start position, or -1.
  // The url tokenizer is tried at a position only after emStrong fails
  // there, so an email's local part can include a `_` run only when
  // emStrong fails for it (no closer, rule of 3, gate, or m-count).
  // The closer may sit after the `@` (not scanned yet), so it is
  // verified from the mask and its flanking instead of from the
  // delimiter list.
  function underscoreWouldMatch(D) {
    // The mask hides closers only: an opener is tried whenever the
    // lexer reaches it as a delimiter, even if the mask hides it (the
    // mask's HTML branch is laxer than the tag tokenizer, e.g.
    // `<foo@...` is no tag but blockSkip hides it).
    if (!D.open) return -1;
    // No `_` run after the opener at all: emStrong cannot match.
    if (lastCloser['_'] < D.pos + D.n) return -1;
    const r = prevTokenChar(D);
    const cx = openerContext(D, r);
    // Gate checks (mirror tryEmStrong).
    const after = oneCodePoint(s, D.pos + D.n);
    if (after && !isSpaceCode(after.codePointAt(0)) && isAlnumChar(cx.n)) return -1;
    const punct = (after && after !== '~' && isPunctCode(after.codePointAt(0))) ? after : '';
    if (punct && cx.n && !cx.u) return -1;
    const need = D.n;
    const span = D.pos - cx.l + need;
    const strongR = cx.p.trim() !== '' && punct !== '';
    const scanFrom = D.pos + need;
    const tail = mask.slice(scanFrom);
    const lastIdx = lastCloser['_'] - scanFrom;
    const re = RDELIM_UND_RE;
    let m = need, f = 0;
    re.lastIndex = 0;
    let hit;
    while ((hit = re.exec(tail)) !== null && !(hit.index > lastIdx)) {
      const g = hit[1] || hit[2] || hit[3] || hit[4] || hit[5] || hit[6];
      if (!g) continue;
      const b = [...g].length;
      const start = scanFrom + hit.index + [...hit[0]][0].length;
      // The closer run must be a real, visible `_` delimiter node:
      // present in the mask, maximal, and not dead by flanking.
      if (start + b > mask.length ||
          mask.slice(start, start + b) !== '_'.repeat(b) ||
          (start + b < mask.length && mask[start + b] === '_')) continue;
      const fl = delimFlags(s, start, b, '_');
      if (!fl.open && !fl.close) continue;
      if (hit[3] || hit[4]) { m += b; continue; }
      if (hit[5] || hit[6] || strongR) {
        if (cx.o && (hit[5] || hit[6])) return -1;
        if (span % 3 !== 0 && (span + b) % 3 === 0) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      return start;
    }
    return -1;
  }

  let i = 0;
  let textStart = 0;
  // End position of the last structural token (link, code span, HTML,
  // autolink, escape, hard break). An email's local part may run back
  // over plain text and delimiter runs, but never past this point:
  // marked's url tokenizer is tried at the current lexer position,
  // after the previous token, so it cannot reclaim source text that
  // already belongs to an earlier email or URL.
  let structEnd = 0;
  // Record that a structural token ends at `end`: the next text run
  // starts there, and no email local part rewinds past it.
  function advancePast(end) {
    textStart = end;
    structEnd = end;
  }
  let buf = null; // pending text pieces (decoded entities) before the run
  let bufStart = 0; // source position where the first pending piece starts

  function flushText(upto) {
    if (buf === null) {
      if (upto > textStart) {
        const t = s.slice(textStart, upto);
        const last = nodes[nodes.length - 1];
        if (last && last.t === 0 && last.raw === ctx.inRawBlock) { last.s += t; last.end = upto; }
        else nodes.push({ t: 0, s: t, raw: ctx.inRawBlock, pos: textStart, end: upto });
      }
    } else {
      if (upto > textStart) buf.push(s.slice(textStart, upto));
      const t = buf.join('');
      const start = bufStart;
      buf = null;
      if (t) {
        const last = nodes[nodes.length - 1];
        if (last && last.t === 0 && last.raw === ctx.inRawBlock) { last.s += t; last.end = upto; }
        else nodes.push({ t: 0, s: t, raw: ctx.inRawBlock, pos: start, end: upto });
      }
    }
    textStart = upto;
  }

  function pushTextPiece(str) {
    flushText(i);
    if (buf === null) { buf = []; bufStart = i; }
    buf.push(str);
    textStart = i;
  }

  // Remove (or truncate) the nodes whose source span falls inside the
  // email [L, em): delimiter runs and text that the address reclaims,
  // because marked's url tokenizer matches the address from its first
  // character, before any emphasis is resolved. Only text and delimiter
  // nodes can sit inside an address; a structural token ends the walk.
  function rewindForEmail(L, em) {
    while (nodes.length > 0) {
      const nd = nodes[nodes.length - 1];
      if (nd.t === 9) {
        if (nd.pos >= L) {
          nodes.pop();
          const k = delims.indexOf(nd);
          if (k !== -1) delims.splice(k, 1);
          continue;
        }
        break; // a delimiter run cannot straddle L
      }
      if (nd.t === 0 && !nd.esc) {
        if (nd.pos >= L) { nodes.pop(); continue; }
        if (nd.end > L) {
          // Truncate to the part before L; the tail inside the address
          // is plain source text, so its length matches the source span.
          nd.s = nd.s.slice(0, nd.s.length - (nd.end - L));
          nd.end = L;
          if (!nd.s) nodes.pop();
        }
        break;
      }
      break;
    }
  }

  // Attempt a link or image at s[i] === '[' (or after '!'). Returns the
  // index just past the construct, or -1.
  function tryLinkAt(pos, isImage) {
    const lab = scanLabel(s, pos, true);
    if (!lab) return -1;
    if (labelHasUnclosedTag(s, pos, lab.end)) return -1;
    const after = lab.end;
    const ac = s.charCodeAt(after);
    if (ac === 40) { // '(' inline link
      const dest = parseLinkDest(s, after + 1);
      if (dest) return finishLink(lab.label, dest.href, dest.title, dest.end, isImage);
      // Inline link failed: fall through to the shortcut reference check.
    }
    if (ac === 91) { // '[' reference link
      const ref = scanRefLabel(s, after);
      if (ref) {
        const key = normalizeLabel(ref.label === '' ? lab.label : ref.label);
        const def = refs[key];
        if (!def) return -1;
        return finishLink(lab.label, def.href, def.title, ref.end, isImage);
      }
      // Collapsed reference [foo][]: the empty second pair is consumed.
      if (s.charCodeAt(after + 1) === 93) {
        const key = normalizeLabel(lab.label);
        const def = refs[key];
        if (!def) return -1;
        return finishLink(lab.label, def.href, def.title, after + 2, isImage);
      }
      // unclosed second bracket: fall through to the shortcut check
    }
    const key = normalizeLabel(lab.label);
    const def = refs[key];
    if (!def) return -1;
    return finishLink(lab.label, def.href, def.title, lab.end, isImage);
  }

  function finishLink(label, href, title, end, isImage) {
    const labelText = label.indexOf('\\') === -1 ? label : label.replace(/\\([\[\]])/g, '$1');
    const savedInLink = ctx.inLink;
    const savedEmitted = ctx.linkEmitted;
    const savedRaw = ctx.inRawBlock;
    ctx.inLink = true;
    ctx.linkEmitted = false;
    const kids = scanInline(labelText, refs, ctx);
    const innerEmitted = ctx.linkEmitted;
    ctx.inLink = savedInLink;
    if (!isImage && innerEmitted) {
      // A link inside a link: the outer link is dropped, its '[' stays text.
      ctx.linkEmitted = savedEmitted;
      ctx.inRawBlock = savedRaw;
      return -1;
    }
    if (isImage) ctx.linkEmitted = savedEmitted;
    else ctx.linkEmitted = true;
    if (isImage) {
      nodes.push({ t: 5, href, title, alt: renderInlineNodes(kids, true) });
    } else {
      nodes.push({ t: 4, href, title, kids });
    }
    return end;
  }

  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash
      const nc = s.charCodeAt(i + 1);
      if (nc === 10) { // backslash + newline: hard break (unless at the end)
        let k = i + 2;
        while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
        let allWs = true;
        for (let m = k; m < n; m++) {
          if (!isSpaceCode(s.charCodeAt(m))) { allWs = false; break; }
        }
        if (!allWs) {
          flushText(i);
          nodes.push({ t: 2 });
          i = k;
          advancePast(k);
          continue;
        }
        i += 2;
        continue;
      }
      if (nc < 128 && ASCII_PUNCT_SET[nc]) {
        flushText(i);
        // An escape is a structural token in marked (not text), so it is
        // marked as such: the emphasis `r` after it is empty, and an
        // email address never starts inside its escaped character.
        nodes.push({ t: 0, s: s[i + 1], esc: true, pos: i, end: i + 2 });
        i += 2;
        advancePast(i);
        continue;
      }
      i++;
      continue;
    }
    if (c === 96) { // backtick: code span
      const m = runLength(s, i, 96);
      const close = findBacktickRun(s, i + m, m);
      if (close !== -1) {
        let content = s.slice(i + m, close);
        if (content.indexOf('\n') !== -1) content = content.replace(/\n/g, ' ');
        if (content.length > 0 && content.charCodeAt(0) === 32 &&
            content.charCodeAt(content.length - 1) === 32 &&
            /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        flushText(i);
        nodes.push({ t: 1, s: content });
        i = close + m;
        advancePast(i);
        continue;
      }
      i += m;
      continue;
    }
    if (c === 42 || c === 95) { // '*' or '_': emphasis delimiter
      const m = runLength(s, i, c);
      const ch = c === 42 ? '*' : '_';
      const { open, close, fopen } = delimFlags(s, i, m, ch);
      if (!open && !close) { i += m; continue; } // dead delimiter: literal text
      flushText(i);
      const d = {
        t: 9, ch, n: m, open, close, fopen,
        pos: i, visible: mask.slice(i, i + m) === ch.repeat(m),
        inLink: ctx.inLink, inRaw: ctx.inRawBlock,
      };
      nodes.push(d);
      delims.push(d);
      i += m;
      textStart = i;
      continue;
    }
    if (c === 126) { // '~': strikethrough delimiter (runs of 1-2 only)
      const m = runLength(s, i, 126);
      if (m > 2) { i += m; continue; }
      const { open, close, fopen } = delimFlags(s, i, m, '~');
      if (!open && !close) { i += m; continue; } // dead delimiter: literal text
      flushText(i);
      const d = {
        t: 9, ch: '~', n: m, open, close, fopen,
        pos: i, visible: mask.slice(i, i + m) === '~'.repeat(m),
        inLink: ctx.inLink, inRaw: ctx.inRawBlock,
      };
      nodes.push(d);
      delims.push(d);
      i += m;
      textStart = i;
      continue;
    }
    if (c === 91 || (c === 33 && s.charCodeAt(i + 1) === 91)) { // '[' or '!['
      const isImage = c === 33;
      const pos = isImage ? i + 1 : i;
      flushText(i);
      const end = tryLinkAt(pos, isImage);
      if (end !== -1) {
        i = end;
        advancePast(i);
        continue;
      }
      i++;
      continue;
    }
    if (c === 60) { // '<': autolink or raw HTML
      const al = tryAutolink(s, i);
      if (al) {
        flushText(i);
        nodes.push({ t: 4, href: al.href, title: '', kids: null, autolink: true, text: al.text });
        i = al.end;
        advancePast(i);
        continue;
      }
      const tg = scanTag(s, i);
      if (tg !== -1) {
        flushText(i);
        const raw = s.slice(i, tg);
        const name = tagNameOf(raw);
        const lower = raw.toLowerCase();
        const afterName = raw.charCodeAt((raw.charCodeAt(1) === 47 ? 2 : 1) + name.length);
        if (!ctx.inLink && lower.startsWith('<a ')) ctx.inLink = true;
        else if (ctx.inLink && lower === '</a>') ctx.inLink = false;
        const isPre = name === 'pre' || name === 'code' || name === 'kbd' || name === 'script';
        if (isPre && raw.charCodeAt(1) !== 47 && (afterName === 32 || afterName === 9 ||
            afterName === 10 || afterName === 62)) ctx.inRawBlock = true;
        else if (isPre && raw.charCodeAt(1) === 47) ctx.inRawBlock = false;
        nodes.push({ t: 3, s: raw });
        i = tg;
        advancePast(i);
        continue;
      }
      i++;
      continue;
    }
    if (c === 38) { // '&': numeric character reference (not inside raw blocks)
      const ref = ctx.inRawBlock ? null : numericRef(s, i);
      if (ref) {
        pushTextPiece(ref.text);
        i = ref.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 10) { // newline: hard break if two spaces precede it
      let k = i - 1;
      let spaces = 0;
      while (k >= textStart && s.charCodeAt(k) === 32) { spaces++; k--; }
      if (spaces >= 2) {
        let m = i + 1;
        while (m < n && (s.charCodeAt(m) === 32 || s.charCodeAt(m) === 9)) m++;
        let allWs = true;
        for (let p = m; p < n; p++) {
          if (!isSpaceCode(s.charCodeAt(p))) { allWs = false; break; }
        }
        if (!allWs) {
          flushText(i - spaces);
          nodes.push({ t: 2 });
          i = m;
          advancePast(m);
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === 119 || c === 104 || c === 72 || c === 102 || c === 70 || c === 109 || c === 120) {
      // w, h, f, m, x: possible extended autolink start
      const prevOk = i === 0 || isSpaceCode(s.charCodeAt(i - 1)) ||
        s.charCodeAt(i - 1) === 42 || s.charCodeAt(i - 1) === 95 ||
        s.charCodeAt(i - 1) === 126 || s.charCodeAt(i - 1) === 40;
      const isWww = c === 119 && s.startsWith('www.', i);
      const isScheme = (c === 104 || c === 72 || c === 102 || c === 70) && matchScheme(s, i) !== -1;
      const isProto = (c === 109 || c === 120) &&
        (s.startsWith('mailto:', i) || s.startsWith('xmpp:', i)) &&
        (i === 0 || !isAlphaNumCode(s.charCodeAt(i - 1)));
      if (!ctx.inLink && ((isWww && prevOk) || isScheme || isProto)) {
        const u = tryUrl(s, i);
        if (u) {
          flushText(i);
          nodes.push({ t: 4, href: u.href, title: '', kids: null, autolink: true, text: u.text });
          i = u.end;
          advancePast(i);
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === 64) { // '@': possible email autolink ending here
      if (!ctx.inLink) {
        // The local part may run back over text and delimiter runs
        // (rewindForEmail removes them), but never over a structural
        // token, and never over a `_` opener that emphasis would
        // consume: the rightmost such opener bounds the address.
        let bound = structEnd;
        for (let d = delims.length - 1; d >= 0; d--) {
          const cand = delims[d];
          if (cand.ch !== '_' || cand.pos >= i) continue;
          if (underscoreWouldMatch(cand) !== -1) { bound = Math.max(bound, cand.pos + cand.n); break; }
        }
        let L = i - 1;
        while (L >= bound && isEmailLocalChar(s.charCodeAt(L))) {
          const ck = s.charCodeAt(L);
          if ((ck === 46 || ck === 95 || ck === 43 || ck === 45) && L > 0 &&
              s.charCodeAt(L - 1) === 92) {
            // A backslash run of odd length before this char escapes it,
            // so the char is not part of the address.
            let b = L - 1, cnt = 0;
            while (b >= 0 && s.charCodeAt(b) === 92) { cnt++; b--; }
            if (cnt % 2 === 1) break;
          }
          L--;
        }
        L++;
        if (L < i) {
          let em = matchEmail(s, L);
          if (em === -1) {
            // The address may be followed by an '_' emphasis closer
            // (e.g. __foo bar@baz.com__): allow it only when an '_'
            // opener is pending whose closer is exactly this '_' run,
            // and the '_' run ends at a non-word char.
            const pre = matchEmailPrefix(s, L);
            if (pre !== -1 && s.charCodeAt(pre) === 95) {
              let m = pre;
              while (m < n && s.charCodeAt(m) === 95) m++;
              const afterRunOk = m >= n || !isWordChar(s.charCodeAt(m));
              const hasUndOpener = delims.some((d) => d.ch === '_' && d.fopen && underscoreWouldMatch(d) === pre);
              if (afterRunOk && hasUndOpener) em = pre;
            }
          }
          if (em !== -1) {
            flushText(L);
            rewindForEmail(L, em);
            nodes.push({ t: 4, href: 'mailto:' + s.slice(L, em), title: '', kids: null, autolink: true, text: s.slice(L, em) });
            i = em;
            advancePast(em);
            continue;
          }
        }
      }
      i++;
      continue;
    }
    i++;
  }
  flushText(n);
  return processDelims(nodes, delims, s, refs, ctx, mask, lastCloser);
}

// Resolve emphasis / strong emphasis / strikethrough delimiters, following
// marked's emStrong / del tokenizers: openers are tried in document order;
// a closer is found by scanning the masked string with the GFM
// right-delimiter regexes, counting opener-type runs up and closer-type
// runs down (rule of 3 for ambiguous runs). On a match the inner text is
// re-lexed from scratch, so a delimiter inside the span is re-evaluated
// in its own context. Delimiters hidden by the mask stay literal.
function processDelims(nodes, delims, s, refs, ctx, mask, lastCloser) {
  if (delims.length === 0) return nodes;
  const byPos = new Map();
  for (const d of delims) byPos.set(d.pos, d);

  // The code-point string starting at UTF-16 index i ('' past the end).
  function codePointAt(str, i) {
    if (i < 0 || i >= str.length) return '';
    const cp = str.codePointAt(i);
    return cp > 0xffff ? str.slice(i, i + 2) : str[i];
  }
  // Whether one code point is alphanumeric in marked's sense (\p{L}\p{N}).
  // A single ASCII code unit takes the fast table path; anything wider
  // (Cyrillic, CJK, astral) needs the Unicode regex — the ASCII table
  // would wrongly reject it.
  function isAlnumStr(ch) {
    if (!ch) return false;
    const unit = ch.charCodeAt(0);
    if (unit < 128) return isAlphaNumCode(unit);
    return ALNUM_RE.test(ch);
  }
  function isSpaceStr(ch) {
    if (!ch) return false;
    return isSpaceCode(ch.charCodeAt(0));
  }
  // marked's GFM punctuation after a delimiter run (`~` excluded).
  function isPunctAfter(ch) {
    if (!ch || ch === '~') return false;
    if (ch.length === 1) return isPunctCode(ch.charCodeAt(0));
    return PUNCT_RE.test(ch);
  }

  // marked's `r`: the last char of the previous token in its lexer stream.
  // It is "" after any structural token (link, code, HTML, emphasis, ...),
  // the last raw char of a preceding text run, or the delimiter char
  // itself after a failed delimiter that was consumed as text. An escape
  // is structural, so `r` is "" after one. A text token ending in `_` is
  // always a lone `_` (the text regex stops before every `_`), and such a
  // token does NOT update `r`: it keeps the value from before it. So a
  // trailing run of `_`s in a text node's raw span is skipped, and a `_`
  // delimiter consumed as text is skipped too.
  function prevChar(D) {
    const idx = nodes.indexOf(D);
    for (let j = idx - 1; j >= 0; j--) {
      const nd = nodes[j];
      if (nd.t === 0) {
        if (nd.esc) return '';
        let e = nd.end;
        while (e > nd.pos && s[e - 1] === '_') e--;
        if (e > nd.pos) return codePointAt(s, e - 1);
        continue; // the node is all `_`s: keep walking back
      }
      if (nd.t === 9) {
        if (nd.ch === '_') continue;
        return nd.ch;
      }
      return ''; // structural token
    }
    return '';
  }

  // Opener context exactly as emStrong computes it: walk back over a run
  // of the same delimiter char in the mask (a literal run or the tail of
  // an earlier wrapper), then read the char before it. `o` uses the
  // token-stream previous char `r`, not the adjusted `n`.
  function openerCtx(D, r) {
    const ch = D.ch;
    let l = D.pos;
    while (l > 0 && mask[l - 1] === ch) l--;
    const p = [...mask.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
    const h = p === '*' || p === '_' || isPunctOrSpaceStr(p);
    let n, u;
    if (l < D.pos) { n = p; u = h; }
    else { n = r; u = isPunctOrSpaceStr(n); }
    return { l, p, h, n, u, o: r === ch };
  }

  // marked's emStrong for one opener D (ch '*' or '_'). Returns
  // { closer, b, use, kind } or null.
  function tryEmStrong(D, cx) {
    const r = D.ch;
    const afterCh = codePointAt(s, D.pos + D.n);
    // A `_` opener is dead when an alphanumeric follows it and the
    // previous char (after the walk-back) is alphanumeric.
    if (r === '_' && afterCh && !isSpaceStr(afterCh) && isAlnumStr(cx.n)) return null;
    const d = isPunctAfter(afterCh) ? afterCh : '';
    if (d && cx.n && !cx.u) return null; // LDelim gate
    const k = D.n;
    const y = D.pos - cx.l + k;
    const R = pTrimmed(cx.p) && (d !== '' || (r === '*' && !cx.h));
    const v = lastCloser[r];
    const Q = D.pos + k;
    if (v < Q) return null;
    const t = mask.slice(Q);
    const ee = v - Q;
    const A = r === '*' ? RDELIM_AST_RE : RDELIM_UND_RE;
    let m = k, f = 0;
    A.lastIndex = 0;
    let s2;
    while ((s2 = A.exec(t)) !== null && !(s2.index > ee)) {
      const g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
      if (!g) continue;
      const b = [...g].length;
      const runStart = Q + s2.index + [...s2[0]][0].length;
      const C = byPos.get(runStart);
      if (!C || C.ch !== r || C.n !== b || !C.visible) continue;
      if (s2[3] || s2[4]) { m += b; continue; }
      if (s2[5] || s2[6] || R) {
        if (cx.o && (s2[5] || s2[6])) return null;
        if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      const bb = Math.min(b, b + m + f);
      const use = Math.min(k, bb) % 2 === 1 ? 1 : 2;
      return { closer: C, b: bb, use, kind: use === 1 ? 6 : 7 };
    }
    return null;
  }

  // marked's del for one `~` opener D. Returns { closer, b, use, kind }
  // or null; `b` is the closer length actually consumed. The opening
  // gate uses the token-stream previous char `r`: it passes when there
  // is no punctuation after the run, no previous char, or the previous
  // char is punctuation-or-space (never `*`/`_`).
  function tryDel(D, r) {
    const o = D.n;
    const afterCh = codePointAt(s, D.pos + o);
    if (!afterCh || isSpaceStr(afterCh) || afterCh === '~') return null;
    const s1 = isPunctAfter(afterCh) ? afterCh : '';
    if (s1 && r && !isPunctOrSpaceStr(r)) return null;
    const v = lastCloser['~'];
    const Q = D.pos + o;
    if (v < Q) return null;
    const t = mask.slice(Q);
    const ee = v - Q;
    const A = RDELIM_DEL_RE;
    let p = o;
    A.lastIndex = 0;
    let s2;
    while ((s2 = A.exec(t)) !== null && !(s2.index > ee)) {
      const g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
      if (!g) continue;
      const l = [...g].length;
      if (l !== o) continue;
      const runStart = Q + s2.index + [...s2[0]][0].length;
      const C = byPos.get(runStart);
      if (!C || C.ch !== '~' || C.n !== l || !C.visible) continue;
      if (s2[3] || s2[4]) { p += l; continue; }
      p -= l;
      if (p > 0) continue;
      return { closer: C, b: Math.min(l, l + p), use: o, kind: 8 };
    }
    return null;
  }

  let di = 0;
  while (di < delims.length) {
    const D = delims[di];
    // An opener is attempted whenever the lexer reaches it as a
    // delimiter — it is in `delims`, so it is not inside a consumed
    // code span, link or tag — even when the mask hides it (the mask's
    // HTML branch is laxer than the tag tokenizer, so a hidden opener
    // may still be real). Only closers are hidden by the mask, and
    // closer visibility is still checked inside tryEmStrong.
    if (!D.open) { di++; continue; }
    const r = prevChar(D);
    const res = D.ch === '~' ? tryDel(D, r) : tryEmStrong(D, openerCtx(D, r));
    if (!res) {
      if (D.n > 1 && D.ch !== '~') {
        // marked peels one delimiter char as literal text and retries the
        // rest of the run as a fresh opener (its text token consumes one
        // char, then emStrong is tried again at the next position). A `~`
        // run is consumed whole by its text token, so it is never peeled.
        const diPos = nodes.indexOf(D);
        const prev = nodes[diPos - 1];
        if (prev && prev.t === 0 && prev.raw === D.inRaw) {
          prev.s += D.ch;
          prev.end = D.pos + 1;
        } else {
          nodes.splice(diPos, 0, { t: 0, s: D.ch, raw: D.inRaw, pos: D.pos, end: D.pos + 1 });
        }
        byPos.delete(D.pos);
        D.pos += 1;
        D.n -= 1;
        const flags = delimFlags(s, D.pos, D.n, D.ch);
        D.open = flags.open;
        D.close = flags.close;
        D.fopen = flags.fopen;
        byPos.set(D.pos, D);
        continue; // retry the shrunk run (di stays)
      }
      // Dead opener: drop it from the delimiter list; it stays literal.
      byPos.delete(D.pos);
      delims.splice(di, 1);
      continue;
    }
    const { closer: C, b, use, kind } = res;
    // Re-lex the inner text from scratch, with the lexer's link/raw state
    // as it was at the opener (marked lexes the em/strong text anew).
    const innerStart = kind === 8 ? D.pos + D.n : D.pos + use;
    const innerEnd = kind === 8 ? C.pos + b - D.n : C.pos + b - use;
    const savedInLink = ctx.inLink, savedInRaw = ctx.inRawBlock;
    ctx.inLink = D.inLink;
    ctx.inRawBlock = D.inRaw;
    const kids = scanInline(s.slice(innerStart, innerEnd), refs, ctx);
    const afterInLink = ctx.inLink, afterInRaw = ctx.inRawBlock;
    ctx.inLink = savedInLink;
    ctx.inRawBlock = savedInRaw;
    const wrap = { t: kind, kids };
    // Delimiters between D and C are superseded by the re-scan.
    const cIdx = delims.indexOf(C);
    for (let j = cIdx - 1; j > di; j--) {
      byPos.delete(delims[j].pos);
      delims.splice(j, 1);
    }
    byPos.delete(D.pos);
    byPos.delete(C.pos);
    delims.splice(di, 2); // D and C are adjacent now
    const repl = [wrap];
    const leftoverLen = C.n - b;
    if (leftoverLen > 0) {
      // The unused tail of the closer run stays after the wrapper, as a
      // fresh delimiter with its own flanking.
      const flags = delimFlags(s, C.pos + b, leftoverLen, C.ch);
      const leftover = {
        t: 9, ch: C.ch, n: leftoverLen, open: flags.open, close: flags.close, fopen: flags.fopen,
        pos: C.pos + b, visible: true,
        inLink: afterInLink, inRaw: afterInRaw,
      };
      repl.push(leftover);
      delims.splice(di, 0, leftover);
      byPos.set(leftover.pos, leftover);
    }
    const diPos = nodes.indexOf(D);
    const ciPos = nodes.indexOf(C);
    nodes.splice(diPos, ciPos - diPos + 1, ...repl);
    // di stays: it now points at the leftover closer, or the next opener.
  }
  // Any delimiter left over (including ones nested inside a wrapper or a
  // link label) becomes literal text.
  const stack = [nodes];
  while (stack.length > 0) {
    const list = stack.pop();
    for (let i = 0; i < list.length; i++) {
      const nd = list[i];
      if (nd.t === 9) list[i] = { t: 0, s: nd.ch.repeat(nd.n) };
      else if (nd.kids) stack.push(nd.kids);
    }
  }
  return nodes;
}

// Whether a one-code-point string is non-whitespace (marked's `p.trim()`).
function pTrimmed(p) {
  return p !== '' && p.trim() !== '';
}

// Render inline nodes to a string. One recursive walker serves both
// modes: plain=false renders HTML (tags, links, images, emphasis);
// plain=true renders plain text (for image alt text: tags are dropped,
// links and emphasis keep their text, hard breaks vanish).
// HTML element names for the emphasis node types: 6 em, 7 strong, 8 del.
// Plain mode renders all three as their inner text, so only the HTML
// path below consults this table.
const EMPHASIS_TAG = { 6: 'em', 7: 'strong', 8: 'del' };

function renderInlineNodes(nodes, plain) {
  let out = '';
  for (const nd of nodes) {
    if (plain) {
      switch (nd.t) {
        case 0: case 1: case 3: out += nd.s; break;
        case 2: break;
        case 4: out += nd.kids ? renderInlineNodes(nd.kids, true) : nd.text; break;
        case 5: out += nd.alt; break;
        case 6: case 7: case 8: out += renderInlineNodes(nd.kids, true); break;
      }
      continue;
    }
    const tag = EMPHASIS_TAG[nd.t];
    if (tag !== undefined) {
      out += '<' + tag + '>' + renderInlineNodes(nd.kids, false) + '</' + tag + '>';
      continue;
    }
    switch (nd.t) {
      case 0: out += nd.raw ? nd.s : escText(nd.s); break;
      case 1: out += '<code>' + escFull(nd.s) + '</code>'; break;
      case 2: out += '<br>'; break;
      case 3: out += nd.s; break;
      case 4: {
        if (nd.autolink) {
          const clean = cleanUrl(nd.href);
          if (clean === null) { out += escFull(nd.text); break; }
          out += '<a href="' + escFull(clean) + '">' + escFull(nd.text) + '</a>';
          break;
        }
        const clean = cleanUrl(nd.href);
        if (clean === null) { out += renderInlineNodes(nd.kids, false); break; }
        out += '<a href="' + escText(clean) + '"';
        if (nd.title) out += ' title="' + escText(nd.title) + '"';
        out += '>' + renderInlineNodes(nd.kids, false) + '</a>';
        break;
      }
      case 5: {
        const clean = cleanUrl(nd.href);
        if (clean === null) { out += escText(nd.alt); break; }
        out += '<img src="' + escText(clean) + '" alt="' + escText(nd.alt) + '"';
        if (nd.title) out += ' title="' + escText(nd.title) + '"';
        out += '>';
        break;
      }
    }
  }
  return out;
}

// Parse inline markdown to an HTML string. `ctx` is the shared inline
// lexer state for the whole document (marked keeps inLink / inRawBlock
// across blocks: an unclosed <a> suppresses autolinks in later paragraphs).
function renderInlineHtml(s, refs, ctx) {
  const c = ctx || { inLink: false, inRawBlock: false, linkEmitted: false };
  return renderInlineNodes(scanInline(s, refs, c), false);
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------
// Node type codes: 0 document, 1 blockquote, 2 list, 3 list item,
// 4 paragraph, 5 heading, 6 code block, 7 HTML block, 8 thematic break,
// 9 table.

const HTML_BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));
const HTML_TYPE1_TAGS = new Set(['script', 'pre', 'style', 'textarea']);

function isBlankText(t) {
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Expand tabs in the leading whitespace run of `text` (which starts at
// absolute column `col`) to spaces, preserving column alignment.
function expandLeadingTabs(text, col) {
  let i = 0, c = col, out = '';
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch === 32) { out += ' '; c++; i++; }
    else if (ch === 9) { const w = 4 - (c % 4); out += ' '.repeat(w); c += w; i++; }
    else break;
  }
  return out + text.slice(i);
}

// Absolute column of the first non-space/tab char in `text`, which starts
// at absolute column `col` (tab stops are multiples of 4 from the line start).
function firstNonSpaceCol(text, col) {
  let c = col, i = 0;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch === 32) { c++; i++; }
    else if (ch === 9) { c += 4 - (c % 4); i++; }
    else break;
  }
  return c;
}

function firstNonSpaceIdx(text) {
  let i = 0;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch === 32 || ch === 9) i++; else break;
  }
  return i;
}

// Strip leading whitespace until absolute column `target` is reached; a tab
// straddling the target becomes spaces. Stops at a non-space character.
function stripTo(text, col, target) {
  let i = 0;
  while (i < text.length && col < target) {
    const ch = text.charCodeAt(i);
    if (ch === 32) { col++; i++; }
    else if (ch === 9) {
      const next = col + 4 - (col % 4);
      if (next > target) return { text: ' '.repeat(next - target) + text.slice(i + 1), col: target };
      col = next; i++;
    } else break;
  }
  return { text: text.slice(i), col };
}

// Strip leading whitespace until absolute column `target` is reached, as
// stripTo, but a tab straddling the target is DROPPED entirely (no spaces).
// This is the fenced-code rule: stripping the fence indent removes a tab
// that starts before the target column (`` ``` `` + `\tfoo` -> `foo`,
// `  ``` ` + ` \tfoo` -> `foo`); a tab starting at/after the target is kept.
function stripToDropTab(text, col, target) {
  let i = 0;
  while (i < text.length && col < target) {
    const ch = text.charCodeAt(i);
    if (ch === 32) { col++; i++; }
    else if (ch === 9) {
      const next = col + 4 - (col % 4);
      if (next > target) return { text: text.slice(i + 1), col: target };
      col = next; i++;
    } else break;
  }
  return { text: text.slice(i), col };
}

// Advance over any characters until absolute column `target` is reached; a
// tab straddling the target becomes spaces.
function cutTo(text, col, target) {
  let i = 0;
  while (i < text.length && col < target) {
    const ch = text.charCodeAt(i);
    if (ch === 9) {
      const next = col + 4 - (col % 4);
      if (next > target) return { text: ' '.repeat(next - target) + text.slice(i + 1), col: target };
      col = next; i++;
    } else { col++; i++; }
  }
  return { text: text.slice(i), col };
}

// ATX heading starting at the first char of `t`. Returns {level, text}.
function matchAtx(t) {
  let i = 0;
  while (i < t.length && t.charCodeAt(i) === 35) i++; // '#'
  if (i === 0 || i > 6) return null;
  if (i < t.length) {
    const c = t.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
  }
  const s = t.slice(i);
  let end = s.length;
  while (end > 0 && (s.charCodeAt(end - 1) === 32 || s.charCodeAt(end - 1) === 9)) end--;
  let j = end;
  while (j > 0 && s.charCodeAt(j - 1) === 35) j--;
  if (j < end && j > 0 && (s.charCodeAt(j - 1) === 32 || s.charCodeAt(j - 1) === 9)) end = j;
  let start = 0;
  while (start < end && (s.charCodeAt(start) === 32 || s.charCodeAt(start) === 9)) start++;
  while (end > start && (s.charCodeAt(end - 1) === 32 || s.charCodeAt(end - 1) === 9)) end--;
  return { level: i, text: s.slice(start, end) };
}

// Fenced code starting at the first char of `t`. Returns {ch, len, info}.
function matchFence(t) {
  const ch = t.charCodeAt(0);
  if (ch !== 96 && ch !== 126) return null; // '`' or '~'
  let i = 0;
  while (i < t.length && t.charCodeAt(i) === ch) i++;
  if (i < 3) return null;
  const info = t.slice(i).trim();
  if (ch === 96 && info.indexOf('`') !== -1) return null;
  return { ch, len: i, info };
}

// Thematic break: 3+ of the same -, * or _ char, spaces allowed between.
function isThematicBreak(t) {
  let i = 0, ch = 0, count = 0;
  while (i < t.length) {
    const c = t.charCodeAt(i);
    if (c === 32 || c === 9) { i++; continue; }
    if (c === 45 || c === 42 || c === 95) {
      if (ch === 0) ch = c;
      else if (c !== ch) return false;
      count++; i++; continue;
    }
    return false;
  }
  return count >= 3;
}

// Setext underline level (1 for '=', 2 for '-'), 0 when not an underline.
// No spaces are allowed inside the run.
function setextLevel(t) {
  let a = 0, b = t.length;
  while (a < b && (t.charCodeAt(a) === 32 || t.charCodeAt(a) === 9)) a++;
  while (b > a && (t.charCodeAt(b - 1) === 32 || t.charCodeAt(b - 1) === 9)) b--;
  if (b - a < 1) return 0;
  const ch = t.charCodeAt(a);
  if (ch !== 61 && ch !== 45) return 0;
  for (let i = a + 1; i < b; i++) if (t.charCodeAt(i) !== ch) return 0;
  return ch === 61 ? 1 : 2;
}

// Parse a table delimiter row. Returns the alignment array or null.
function parseDelimRow(text, col) {
  if (firstNonSpaceCol(text, col) - col > 3) return null;
  const cells = splitCells(text.slice(firstNonSpaceIdx(text)));
  if (cells.length === 0) return null;
  const align = [];
  for (const cell of cells) {
    let k = 0, j = cell.length;
    let left = false, right = false;
    if (cell.charCodeAt(0) === 58) { left = true; k = 1; }
    if (j > k && cell.charCodeAt(j - 1) === 58) { right = true; j--; }
    let ok = j - k >= 1;
    for (let m = k; m < j; m++) if (cell.charCodeAt(m) !== 45) { ok = false; break; }
    if (!ok) return null;
    align.push(left && right ? 'center' : left ? 'left' : right ? 'right' : '');
  }
  return align;
}

// Is the char at `i` a valid end for a type 1 / type 6 tag name?
function htmlTagEnd(t, i) {
  if (i >= t.length) return true;
  const c = t.charCodeAt(i);
  return c === 32 || c === 9 || c === 62 || (c === 47 && t.charCodeAt(i + 1) === 62);
}

// Match an HTML block start on the stripped line `t`. Returns
// {type, tag} or null. Types 1-6 can interrupt a paragraph, type 7 cannot.
function matchHtmlStart(t) {
  if (t.charCodeAt(0) !== 60) return null; // '<'
  const lower = t.toLowerCase();
  for (const tag of HTML_TYPE1_TAGS) {
    if (lower.startsWith('<' + tag) && htmlTagEnd(t, tag.length + 1)) {
      return { type: 1, tag };
    }
  }
  if (t.startsWith('<!--')) return { type: 2, tag: '' };
  if (t.startsWith('<?')) return { type: 3, tag: '' };
  if (t.startsWith('<![CDATA[')) return { type: 5, tag: '' };
  if (t.charCodeAt(1) === 33) {
    const c = t.charCodeAt(2);
    if (c >= 65 && c <= 90) return { type: 4, tag: '' }; // <! + uppercase letter
  }
  // type 6: < or </ + block tag name
  let i = 1;
  if (t.charCodeAt(1) === 47) i = 2; // '/'
  const start = i;
  while (i < t.length) {
    const c = t.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45) { i++; continue; }
    break;
  }
  const name = t.slice(start, i).toLowerCase();
  if (name && HTML_BLOCK_TAGS.has(name) && htmlTagEnd(t, i)) return { type: 6, tag: name };
  // type 7: a complete open or closing tag alone on the line
  const end = scanTag(t, 0);
  if (end !== -1 && isBlankText(t.slice(end))) {
    const nm = tagNameOf(t.slice(0, end));
    if (nm && !HTML_TYPE1_TAGS.has(nm)) return { type: 7, tag: nm };
  }
  return null;
}

// Does `text` contain the end condition of HTML block `b` (types 1-5)?
function htmlEndInLine(b, text) {
  switch (b.htmlType) {
    case 1: return text.toLowerCase().indexOf('</' + b.tag + '>') !== -1;
    case 2: return text.indexOf('-->') !== -1;
    case 3: return text.indexOf('?>') !== -1;
    case 4: return text.indexOf('>') !== -1;
    case 5: return text.indexOf(']]>') !== -1;
  }
  return false;
}

// Match a list marker at the start of `t` (absolute column `col`).
// Returns null or {ordered, start, delim, markerLen, contentIndent,
// content}; contentIndent is the absolute column of the item content.
function matchListMarker(t, col) {
  const c0 = t.charCodeAt(0);
  let ordered = false, start = 0, delim = '', markerLen = 0;
  if (c0 === 45 || c0 === 43 || c0 === 42) { // - + *
    markerLen = 1;
  } else if (c0 >= 48 && c0 <= 57) {
    let i = 0;
    while (i < t.length && i < 9 && t.charCodeAt(i) >= 48 && t.charCodeAt(i) <= 57) i++;
    if (i === 0) return null;
    const d = t.charCodeAt(i);
    if (d !== 46 && d !== 41) return null; // '.' or ')'
    ordered = true;
    start = parseInt(t.slice(0, i), 10);
    delim = t.charAt(i);
    markerLen = i + 1;
  } else return null;
  const after = markerLen < t.length ? t.charCodeAt(markerLen) : -1;
  if (after !== -1 && after !== 32 && after !== 9) return null;
  const afterCol = col + markerLen;
  let idx = markerLen, c = afterCol;
  while (idx < t.length) {
    const ch = t.charCodeAt(idx);
    if (ch === 32) { c++; idx++; }
    else if (ch === 9) { c += 4 - (c % 4); idx++; }
    else break;
  }
  let contentIndent, content;
  if (idx >= t.length) {
    contentIndent = col + markerLen + 1;
    content = { text: '', col: contentIndent };
  } else {
    const spacesAfter = c - afterCol;
    contentIndent = spacesAfter <= 4 ? c : col + markerLen + 1;
    content = cutTo(t, col, contentIndent);
  }
  return { ordered, start, delim, markerLen, contentIndent, content };
}

// Try to parse a link reference definition starting at the start of
// `line0`. `peek(k)` returns logical line k (1 or 2) as a string, or null.
// Returns {href, title, consumed} (consumed = number of lines) or null.
function tryParseDef(line0, peek) {
  const MAXL = 10;
  const L = [line0, null, null, null, null, null, null, null, null, null];
  let l = 0, i = 0;
  // The label may span lines. A definition label may not contain an
  // unescaped '[' and may not be empty or only whitespace.
  let lab = scanLabel(L[0], 0, false);
  if (!lab) {
    const parts = [L[0]];
    let combined = L[0];
    let foundLab = null;
    for (let extra = 1; extra < MAXL; extra++) {
      const nx = peek(extra);
      if (nx === null) break;
      let jj = 0;
      while (jj < nx.length && (nx.charCodeAt(jj) === 32 || nx.charCodeAt(jj) === 9)) jj++;
      if (jj >= nx.length) break; // blank line: label cannot continue
      parts.push(nx);
      combined += '\n' + nx;
      const cand = scanLabel(combined, 0, false);
      if (cand) { foundLab = cand; break; }
    }
    if (!foundLab) return null;
    let remaining = foundLab.end;
    let lineIdx = 0;
    for (let k = 0; k < parts.length; k++) {
      if (remaining <= parts[k].length) { lineIdx = k; break; }
      remaining -= parts[k].length + 1;
      lineIdx = k + 1;
    }
    for (let k = 1; k < parts.length; k++) L[k] = parts[k];
    l = lineIdx;
    i = remaining;
    lab = foundLab;
  } else {
    i = lab.end;
  }
  if (normalizeLabel(lab.label) === '') return null; // empty label
  if (L[l].charCodeAt(i) !== 58) return null; // ':'
  i++;
  function nextLine() {
    if (l + 1 >= MAXL) return false;
    if (L[l + 1] === null) {
      const p = peek(l + 1);
      if (p === null) return false;
      L[l + 1] = p;
    }
    const nx = L[l + 1];
    let j = 0;
    while (j < nx.length && (nx.charCodeAt(j) === 32 || nx.charCodeAt(j) === 9)) j++;
    if (j >= nx.length) return false; // blank line: cannot continue
    l++;
    i = j;
    return true;
  }
  function skipWs(allowNewline) {
    while (true) {
      const t = L[l];
      while (i < t.length && (t.charCodeAt(i) === 32 || t.charCodeAt(i) === 9)) i++;
      if (i < t.length) return true;
      if (!allowNewline) return false;
      if (!nextLine()) return false;
    }
  }
  if (!skipWs(true)) return null;
  let href;
  let t = L[l];
  if (t.charCodeAt(i) === 60) { // '<' angle destination
    let j = i + 1, ok = false;
    while (j < t.length) {
      const c = t.charCodeAt(j);
      if (c === 92) { j += 2; continue; }
      if (c === 62) { ok = true; break; }
      if (c === 60) break;
      j++;
    }
    if (!ok) return null;
    href = t.slice(i + 1, j);
    i = j + 1;
  } else {
    let j = i, depth = 0;
    while (j < t.length) {
      const c = t.charCodeAt(j);
      if (c === 92) { j += 2; continue; }
      if (c === 32 || c === 9 || c < 32) break;
      if (c === 40) { depth++; j++; continue; }
      if (c === 41) { if (depth === 0) break; depth--; j++; continue; }
      j++;
    }
    if (j === i) return null;
    href = t.slice(i, j);
    i = j;
  }
  // After the destination only whitespace (or end of line) may follow.
  t = L[l];
  if (i < t.length && t.charCodeAt(i) !== 32 && t.charCodeAt(i) !== 9) return null;
  let title = '';
  const saveL = l, saveI = i;
  if (skipWs(true)) {
    const t2 = L[l];
    const q = t2.charCodeAt(i);
    if (q === 34 || q === 39 || q === 40) { // " ' (
      const closeCh = q === 40 ? 41 : q;
      // The title may span lines: scan for the closing quote across lines.
      let content = '';
      let curL = l, curI = i + 1, found = false, endL = l, endI = -1;
      while (true) {
        const line = L[curL];
        let j = curI, okLine = false;
        while (j < line.length) {
          const c = line.charCodeAt(j);
          if (c === 92) { j += 2; continue; }
          if (c === closeCh) { okLine = true; break; }
          j++;
        }
        if (okLine) {
          content += line.slice(curI, j);
          let k = j + 1;
          while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
          if (k >= line.length) { found = true; endL = curL; endI = j + 1; }
          break;
        }
        content += line.slice(curI) + '\n';
        if (curL + 1 >= MAXL) break;
        const nx = peek(curL + 1);
        if (nx === null) break;
        let jj = 0;
        while (jj < nx.length && (nx.charCodeAt(jj) === 32 || nx.charCodeAt(jj) === 9)) jj++;
        if (jj >= nx.length) break; // blank line: title cannot continue
        if (L[curL + 1] === null) L[curL + 1] = nx;
        curL++;
        curI = 0;
      }
      if (found) {
        title = content;
        l = endL;
        i = endI;
      } else {
        l = saveL; i = saveI;
      }
    } else { l = saveL; i = saveI; }
  }
  t = L[l];
  let k = i;
  while (k < t.length && (t.charCodeAt(k) === 32 || t.charCodeAt(k) === 9)) k++;
  if (k < t.length) return null;
  return { label: lab.label, href: unescapePunct(href), title: title ? unescapePunct(title) : '', consumed: l + 1 };
}

// ---------------------------------------------------------------------------
// Block parsing: the container walk
// ---------------------------------------------------------------------------

// Render a block list to HTML strings appended to `out`.
function renderTable(b, refs, out, ctx) {
  out.push('<table>\n<thead>\n<tr>\n');
  for (let i = 0; i < b.header.length; i++) {
    out.push('<th' + (b.align[i] ? ' align="' + b.align[i] + '"' : '') + '>' +
      renderInlineHtml(b.header[i], refs, ctx) + '</th>\n');
  }
  out.push('</tr>\n</thead>\n');
  if (b.rows.length > 0) {
    out.push('<tbody>');
    for (const row of b.rows) {
      out.push('<tr>\n');
      for (let i = 0; i < row.length; i++) {
        out.push('<td' + (b.align[i] ? ' align="' + b.align[i] + '"' : '') + '>' +
          renderInlineHtml(row[i], refs, ctx) + '</td>\n');
      }
      out.push('</tr>\n');
    }
    out.push('</tbody>');
  }
  out.push('</table>\n');
}

// Parse markdown to the HTML marked 18.1.3 renders with its defaults.
export function parse(markdown) {
  const src = markdown.indexOf('\r') === -1 ? markdown : markdown.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const endsNL = lines.length > 0 && lines[lines.length - 1] === '';
  if (endsNL) lines.pop();
  const nLines = lines.length;
  const refs = Object.create(null);
  // Shared inline lexer state for the whole document (see renderInlineHtml).
  const inlineCtx = { inLink: false, inRawBlock: false, linkEmitted: false };
  const root = { t: 0, children: [] };
  const stack = [root];
  let lastLineBlank = false;
  let blankDepth = -1; // stack index of the innermost container a blank line matched
  let extraLines = 0;
  let defConsumed = false;

  function lineNL(i) { return i < nLines - 1 || endsNL; }

  // Match the line against the open containers. Returns the remainder
  // (text, absolute column) and `fail`, the stack index of the first
  // container that did not match, or -1 when all containers matched.
  function matchContainers(line) {
    let text = line, col = 0;
    for (let i = 1; i < stack.length; i++) {
      const b = stack[i];
      if (b.t === 1) { // blockquote
        const r = stripTo(text, col, col + 3);
        if (r.text.charCodeAt(0) === 62) { // '>'
          let t2 = r.text.slice(1), c2 = r.col + 1;
          // Expand tabs in the whitespace after '>' relative to the '>'
          // itself (as marked's J(m, b.length) does), NOT at the absolute
          // column: a tab after a nested '> >' expands from col 1 (3
          // spaces, one consumed below -> 2), not from the absolute col.
          const relCol = (r.col - col) + 1;
          const expanded = expandLeadingTabs(t2, relCol);
          let rest = expanded, newCol = c2;
          if (rest.charCodeAt(0) === 32) { rest = rest.slice(1); newCol = c2 + 1; }
          text = rest; col = newCol;
          continue;
        }
        return { text, col, fail: i };
      }
      if (b.t === 3) { // list item
        if (isBlankText(text)) continue;
        const target = col + b.contentIndent;
        const r = stripTo(text, col, target);
        if (r.col >= target) {
          // A tab at the start of the item content expands to spaces.
          text = expandLeadingTabs(r.text, r.col); col = r.col;
          continue;
        }
        return { text, col, fail: i };
      }
      if (b.t === 2) continue; // list: always matches
      return { text, col, fail: -1 }; // leaf block
    }
    return { text, col, fail: -1 };
  }

  // The remainder of line `idx` after matching the open containers, or
  // null when it does not match them (used for link definition lookahead).
  function logicalLine(idx) {
    if (idx >= nLines) return null;
    const m = matchContainers(lines[idx]);
    if (m.fail !== -1) return null;
    return m.text;
  }

  // Is the line at `idx` blank at the current block level?
  function peekNextBlank(idx) {
    if (idx >= nLines) return false;
    const m = matchContainers(lines[idx]);
    return isBlankText(m.text);
  }

  // Is the line at `idx` EMPTY (not merely whitespace-only) at the current
  // block level? HTML blocks of types 1-5 strip one trailing '\n' only
  // when followed by a truly empty line; a whitespace-only line (space or
  // tab) does not strip it (marked keeps the '\n' then).
  function peekNextEmpty(idx) {
    if (idx >= nLines) return false;
    const m = matchContainers(lines[idx]);
    return m.text === '';
  }

  // Close blocks from the top down to (but not including) stack[toDepth].
  // `stripNext` marks HTML blocks whose following line is blank.
  function closeBlocks(toDepth, stripNext) {
    while (stack.length > toDepth) {
      const b = stack.pop();
      if (b.t === 3) finalizeItem(b);
      else if (b.t === 7) b.stripNext = stripNext;
    }
  }

  // A list item's first paragraph may start with a task checkbox.
  function finalizeItem(b) {
    if (!b.markerLineContent) return;
    const first = b.children[0];
    if (!first || first.t !== 4) return;
    const line0 = first.lines[0];
    if (line0 === undefined) return;
    const m = /^\[( |x|X)\][ \t]+/.exec(line0);
    if (!m || m[0].length >= line0.length) return;
    b.task = line0.charCodeAt(1) === 32 ? 1 : 2;
    first.lines[0] = line0.slice(m[0].length);
  }

  // Append a block as a child of the innermost open container, marking
  // looseness when a blank line at (or above) this level preceded it.
  // A blank line inside a nested block (e.g. a quote inside an item)
  // does not loosen the outer list.
  function addChild(b) {
    const parent = stack[stack.length - 1];
    if (lastLineBlank) {
      if (parent.t === 3 && parent.children.length > 0 && blankDepth <= stack.length - 1) parent.loose = true;
      if (b.t === 3 && parent.t === 2 && parent.children.length > 0 && blankDepth <= stack.length) parent.loose = true;
    }
    parent.children.push(b);
  }

  function popDanglingList() {
    if (stack[stack.length - 1].t === 2) stack.pop();
  }

  // Does the line start a block that can interrupt a paragraph?
  // `anyList` is true when the line is outside the paragraph's container
  // (a lazy continuation candidate): there any list marker interrupts,
  // because it starts a new item or a new list at an outer level.
  function startsInterrupting(text, col, anyList) {
    const f = firstNonSpaceCol(text, col);
    if (f - col > 3) return false;
    const base = stripTo(text, col, f).text;
    if (base.charCodeAt(0) === 62) return true; // '>' blockquote
    if (matchAtx(base)) return true;
    if (matchFence(base)) return true;
    const h = matchHtmlStart(base);
    if (h && h.type <= 6) return true;
    if (isThematicBreak(base)) return true;
    const lm = matchListMarker(base, f);
    if (lm) {
      if (anyList) return true;
      if (!lm.ordered) return lm.content.text !== '';
      return lm.start === 1 && lm.content.text !== '';
    }
    return false;
  }

  function isClosingFence(base, top) {
    if (base.charCodeAt(0) !== top.fenceCh) return false;
    let i = 0;
    while (i < base.length && base.charCodeAt(i) === top.fenceCh) i++;
    if (i < top.fenceLen) return false;
    return isBlankText(base.slice(i));
  }

  // Try to start a block from the remainder. Returns {done} when the line
  // is consumed, or {done:false, text, col} when a container was pushed and
  // the remainder still needs processing.
  function tryStartBlock(text, col, li) {
    const ind = firstNonSpaceCol(text, col) - col;
    const top0 = stack[stack.length - 1];
    if (top0.t === 2) {
      // A list with no open item ends here unless this line starts a new
      // item in it.
      let keep = false;
      if (ind <= 3) {
        const b0 = stripTo(text, col, col + ind).text;
        const lm0 = matchListMarker(b0, col + ind);
        keep = !!lm0 && !isThematicBreak(b0) && lm0.ordered === top0.ordered &&
          (lm0.ordered ? lm0.delim === top0.delim : b0.charAt(0) === top0.marker);
      }
      if (!keep) stack.pop();
    }
    if (ind >= 4) {
      const r = stripTo(text, col, col + 4);
      const b = { t: 6, fenced: false, info: '', raw: '', pendingBlanks: 0 };
      addChild(b);
      stack.push(b);
      b.raw += r.text + (lineNL(li) ? '\n' : '');
      return { done: true };
    }
    const base = stripTo(text, col, col + ind).text;
    const baseCol = col + ind;
    if (base.charCodeAt(0) === 62) { // '>' blockquote
      let t2 = base.slice(1), c2 = baseCol + 1;
      // Expand tabs in the whitespace after '>', then consume the
      // one optional space, as marked does.
      const expanded = expandLeadingTabs(t2, c2);
      if (expanded.charCodeAt(0) === 32) { t2 = expanded.slice(1); c2++; }
      else t2 = expanded;
      const q = { t: 1, children: [] };
      addChild(q);
      stack.push(q);
      if (isBlankText(t2)) return { done: true };
      return { done: false, text: t2, col: c2 };
    }
    const atx = matchAtx(base);
    if (atx) {
      addChild({ t: 5, level: atx.level, text: atx.text });
      return { done: true };
    }
    const fen = matchFence(base);
    if (fen) {
      // marked strips the fence indent from content lines only for
      // backtick fences; tilde fences keep the content indentation as-is
      // (``   ~~~ `` + `   foo` -> `   foo`, not `foo`). fen.ch is a char
      // code: 126 is '~'.
      const b = { t: 6, fenced: true, info: fen.info, raw: '', fenceCh: fen.ch, fenceLen: fen.len, fenceIndent: fen.ch === 126 ? 0 : ind, pendingBlanks: 0 };
      addChild(b);
      stack.push(b);
      return { done: true };
    }
    const h = matchHtmlStart(base);
    if (h) {
      const b = { t: 7, htmlType: h.type, tag: h.tag, raw: '', stripNext: false };
      addChild(b);
      b.raw += text + (lineNL(li) ? '\n' : '');
      if (h.type <= 5 && htmlEndInLine(b, text)) {
        b.stripNext = peekNextEmpty(li + 1);
        return { done: true };
      }
      stack.push(b);
      return { done: true };
    }
    if (isThematicBreak(base)) {
      addChild({ t: 8 });
      return { done: true };
    }
    const def = tryParseDef(base, (k) => logicalLine(li + k));
    if (def) {
      const key = normalizeLabel(def.label);
      if (!(key in refs)) refs[key] = { href: def.href, title: def.title };
      extraLines = def.consumed - 1;
      defConsumed = true;
      return { done: true };
    }
    const lm = matchListMarker(base, baseCol);
    if (lm) {
      const parent = stack[stack.length - 1];
      let list = null;
      if (parent.t === 2 && parent.ordered === lm.ordered &&
          (lm.ordered ? parent.delim === lm.delim : base.charAt(0) === parent.marker)) {
        list = parent;
      } else {
        list = { t: 2, ordered: lm.ordered, start: lm.start, delim: lm.delim, marker: base.charAt(0), children: [], loose: false };
        addChild(list);
        stack.push(list);
      }
      // Store the content indent relative to the remainder's start
      // column, so it stays valid when the enclosing containers sit at
      // different columns on later lines (e.g. quote markers shifted).
      const item = { t: 3, children: [], contentIndent: lm.contentIndent - col, task: 0, markerLineContent: lm.content.text !== '', loose: false };
      if (lastLineBlank && blankDepth <= stack.length && list.children.length > 0) list.loose = true;
      list.children.push(item);
      stack.push(item);
      if (lm.content.text === '') return { done: true };
      return { done: false, text: lm.content.text, col: lm.content.col };
    }
    const p = { t: 4, lines: [text], lazyDedent: false };
    addChild(p);
    stack.push(p);
    return { done: true };
  }

  // Process one (non-blank) line's remainder: continue the open leaf block
  // or start new blocks.
  function processRemainder(text, col, li) {
    while (true) {
      const top = stack[stack.length - 1];
      if (top.t === 4) { // paragraph
        const f = firstNonSpaceCol(text, col);
        if (f - col <= 3) {
          const base = stripTo(text, col, f).text;
          const st = setextLevel(base);
          if (st) {
            const parent = stack[stack.length - 2];
            const headingText = top.lines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
            parent.children[parent.children.indexOf(top)] = { t: 5, level: st, text: headingText };
            stack.pop();
            return;
          }
          const delim = parseDelimRow(text, col);
          if (delim) {
            const headerCells = splitCells(top.lines[top.lines.length - 1]);
            if (headerCells.length === delim.length) {
              top.lines.pop();
              stack.pop();
              const parent = stack[stack.length - 1];
              if (top.lines.length === 0) parent.children.splice(parent.children.indexOf(top), 1);
              const tbl = { t: 9, header: headerCells, align: delim, rows: [] };
              addChild(tbl);
              stack.push(tbl);
              return;
            }
          }
          if (startsInterrupting(text, col, stack[stack.length - 2] && stack[stack.length - 2].t === 3)) {
            stack.pop();
            continue;
          }
        }
        top.lazyDedent = false;
        const parent = stack[stack.length - 2];
        if (parent && parent.t === 3) {
          const r = stripTo(text, col, col + 4);
          if (r.col >= col + 4) text = r.text;
        }
        top.lines.push(text);
        return;
      }
      if (top.t === 6) { // code block
        if (top.fenced) {
          const f = firstNonSpaceCol(text, col);
          if (f - col <= 3 && isClosingFence(stripTo(text, col, f).text, top)) {
            stack.pop();
            return;
          }
          const r = stripToDropTab(text, col, col + top.fenceIndent);
          top.raw += r.text + (lineNL(li) ? '\n' : '');
          return;
        }
        const f = firstNonSpaceCol(text, col);
        if (f - col >= 4) {
          const r = stripTo(text, col, col + 4);
          if (top.pendingBlanks > 0) { top.raw += '\n'.repeat(top.pendingBlanks); top.pendingBlanks = 0; }
          top.raw += r.text + (lineNL(li) ? '\n' : '');
          return;
        }
        stack.pop(); // close the code block, reprocess the line
        continue;
      }
      if (top.t === 7) { // HTML block
        top.raw += text + (lineNL(li) ? '\n' : '');
        if (top.htmlType <= 5 && htmlEndInLine(top, text)) {
          stack.pop();
          top.stripNext = peekNextEmpty(li + 1);
        }
        return;
      }
      if (top.t === 9) { // table
        if (startsInterrupting(text, col)) {
          stack.pop();
          continue;
        }
        top.rows.push(splitCells(text, top.header.length));
        return;
      }
      const r = tryStartBlock(text, col, li);
      if (r.done) return;
      text = r.text; col = r.col;
    }
  }

  function renderItem(it, loose, out) {
    const kids = it.children;
    const taskHtml = it.task === 2 ? '<input checked="" disabled="" type="checkbox"> '
      : it.task === 1 ? '<input disabled="" type="checkbox"> ' : '';
    out.push('<li>');
    for (let k = 0; k < kids.length; k++) {
      const c = kids[k];
      if (c.t === 4) {
        // In a tight list every paragraph renders bare (no <p> tags);
        // in a loose list every paragraph is wrapped.
        const html = renderInlineHtml(c.lines.join('\n'), refs, inlineCtx);
        if (loose) out.push('<p>' + (k === 0 ? taskHtml : '') + html + '</p>\n');
        else out.push((k === 0 ? taskHtml : '') + html);
      } else {
        renderBlocks([c], out);
      }
    }
    out.push('</li>\n');
  }

  function renderBlocks(blocks, out) {
    for (const b of blocks) {
      if (b.t === 1) {
        out.push('<blockquote>\n');
        renderBlocks(b.children, out);
        out.push('</blockquote>\n');
      } else if (b.t === 2) {
        if (b.ordered) out.push(b.start !== 1 ? '<ol start="' + b.start + '">\n' : '<ol>\n');
        else out.push('<ul>\n');
        const loose = b.loose || b.children.some((it) => it.loose);
        for (const it of b.children) renderItem(it, loose, out);
        out.push(b.ordered ? '</ol>\n' : '</ul>\n');
      } else if (b.t === 4) {
        out.push('<p>' + renderInlineHtml(b.lines.join('\n'), refs, inlineCtx) + '</p>\n');
      } else if (b.t === 5) {
        out.push('<h' + b.level + '>' + renderInlineHtml(b.text, refs, inlineCtx) + '</h' + b.level + '>\n');
      } else if (b.t === 6) {
        let raw = b.raw;
        if (raw.charCodeAt(raw.length - 1) === 10) raw = raw.slice(0, -1);
        if (raw !== '' && raw.charCodeAt(raw.length - 1) !== 10) raw += '\n';
        out.push('<pre><code');
        if (b.fenced && b.info) {
          const lang = unescapePunct(b.info).match(/^\S*/)[0];
          if (lang) out.push(' class="language-' + escText(lang) + '"');
        }
        out.push('>' + escFull(raw) + '</code></pre>\n');
      } else if (b.t === 7) {
        let raw = b.raw;
        if (b.stripNext && raw.charCodeAt(raw.length - 1) === 10) raw = raw.slice(0, -1);
        out.push(raw);
      } else if (b.t === 8) {
        out.push('<hr>\n');
      } else if (b.t === 9) {
        renderTable(b, refs, out, inlineCtx);
      }
    }
  }

  let li = 0;
  while (li < nLines) {
    const line = lines[li];
    const m = matchContainers(line);
    const text = m.text, col = m.col;
    // A whitespace-only line that contains a tab is a table row, not a
    // blank line, when a table is open (marked treats it as a row of empty
    // cells); a spaces-only line does end the table.
    const tabRow = stack[stack.length - 1].t === 9 && text.includes('\t');
    if (isBlankText(text) && !tabRow) {
      // The innermost container this blank line matched: its level decides
      // which looseness it can cause. A line of only whitespace is blank
      // at every level (depth 0); a line holding only container markers
      // (e.g. "  >") is blank only at the innermost marker's level.
      blankDepth = isBlankText(line) ? 0 : (m.fail !== -1 ? m.fail - 1
        : (stack[stack.length - 1].t === 2 ? stack.length - 1 : stack.length - 2));
      if (m.fail !== -1) {
        closeBlocks(m.fail, true);
      } else {
        const top = stack[stack.length - 1];
        if (top.t === 6 && top.fenced) {
          const r = stripToDropTab(text, col, col + top.fenceIndent);
          top.raw += r.text + (lineNL(li) ? '\n' : '');
        } else if (top.t === 6) {
          // A blank line with 4+ columns of indent is code content, not blank.
          const r = stripTo(text, col, col + 4);
          if (r.col >= col + 4) {
            if (top.pendingBlanks > 0) { top.raw += '\n'.repeat(top.pendingBlanks); top.pendingBlanks = 0; }
            top.raw += r.text + (lineNL(li) ? '\n' : '');
            lastLineBlank = false;
            li++;
            continue;
          }
          top.pendingBlanks++;
        } else if (top.t === 7 && top.htmlType <= 5) {
          top.raw += '\n';
        } else if (top.t === 4 && text.length > 0) {
          // A line of only spaces/tabs is paragraph text when it is the
          // last line of the paragraph's container chunk (blockquote) or
          // of the source itself (top level); otherwise it is a blank line.
          const parent = stack[stack.length - 2];
          let appended = false;
          if (parent && parent.t === 1) {
            const pIdx = stack.length - 2;
            let lastOfChunk = li + 1 >= nLines;
            if (!lastOfChunk) {
              const nm = matchContainers(lines[li + 1]);
              lastOfChunk = nm.fail !== -1 && nm.fail <= pIdx;
            }
            if (lastOfChunk) {
              top.lines.push(text);
              stack.pop(); // close the paragraph so the next line is not lazy
              appended = true;
            }
          } else if (!parent || parent.t === 0) {
            if (!lineNL(li)) {
              top.lines.push(text);
              appended = true;
            }
          }
          if (appended) {
            lastLineBlank = false;
            li++;
            continue;
          }
          closeBlocks(stack.length - 1, true);
        } else if (top.t === 4 || top.t === 9 || top.t === 7) {
          closeBlocks(stack.length - 1, true);
        }
        // An empty list item followed by a blank line is closed; later
        // lines are not part of it.
        const nt = stack[stack.length - 1];
        if (nt && nt.t === 3 && nt.children.length === 0 && !nt.markerLineContent) stack.pop();
      }
      lastLineBlank = true;
      li++;
      continue;
    }
    if (m.fail !== -1) {
      const top = stack[stack.length - 1];
      if (top.t === 4 && !startsInterrupting(text, col, true)) {
        let line = text;
        const failed = stack[m.fail];
        if (failed.t === 1) { // blockquote
          if (/^ {0,3}(=+|-+)[ \t]*$/.test(text)) {
            // A setext-looking lazy line is indented so it stays text.
            line = '    ' + text.replace(/^ +/, '');
          } else if (top.lazyDedent) {
            line = stripTo(text, col, col + 4).text;
          } else {
            const lead = firstNonSpaceCol(text, col) - col;
            if (lead >= 4) {
              top.lazyDedent = true;
              line = stripTo(text, col, col + 4).text;
            }
          }
        } else if (failed.t === 3) { // list item: strip 4 columns when present
          const r = stripTo(text, col, col + 4);
          if (r.col >= col + 4) line = r.text;
        }
        top.lines.push(line);
        lastLineBlank = false;
        li++;
        continue;
      } else if (top.t === 6 && top.fenced && stack[m.fail].t === 3 && top.raw !== '' &&
          !stack.slice(m.fail + 1, -1).some((b) => b.t === 1)) {
        // A fenced code block DIRECTLY inside a list item swallows lines
        // even when they fail the item's indent — but ONLY once the block
        // already has content: an empty fence does not swallow the first
        // content line (marked leaves it empty and the line becomes a
        // paragraph outside the list, e.g. `+ item` + `` ```sh `` +
        // `print("hi")` at col 0). And only when no blockquote sits
        // between the item and the fence: a line without '>' is outside
        // the quote and closes it and the fence (cm-237). Fall through to
        // processRemainder, which handles the closing-fence check and
        // appends the raw line; do NOT close the code block here.
      } else {
        closeBlocks(m.fail, true);
      }
    }
    processRemainder(text, col, li);
    if (!defConsumed) lastLineBlank = false;
    defConsumed = false;
    li += 1 + extraLines;
    extraLines = 0;
  }
  closeBlocks(1, false);

  const out = [];
  renderBlocks(root.children, out);
  return out.join('');
}

