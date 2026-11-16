// parse.js — a fast Markdown renderer that returns exactly the HTML marked
// 18.1.3 renders with its default options (GFM on, breaks off). Written from
// scratch in this session from the CommonMark 0.31.2 and GFM 0.29 specifications
// and from observing marked's behaviour on the spec examples. It is a
// dependency-free ES module exporting parse(markdown).
//
// Layout: small helpers, then the inline lexer (an InlineLexer class with
// one handler method per construct, plus the delimiter resolver for
// emphasis / strong emphasis / strikethrough), then the block parser (a
// Cursor for column math, a lazy LineProbe for line classification, a
// DefParser for link reference definitions, and a BlockBuilder that owns
// the container-stack walk), then an HtmlRenderer that turns the block
// tree into HTML by method dispatch on the frame kind.

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
// The inline lexer is a class: one instance per (re)scan, with a handler
// method per construct and a compact dispatch loop. Node shapes are
// unchanged (processDelims and renderInlineNodes consume them as before),
// so only this scanner's internal structure differs from the old one.
class InlineLexer {
  constructor(s, refs, ctx) {
    this.s = s;
    this.n = s.length;
    this.refs = refs;
    this.ctx = ctx;
    this.nodes = [];
    this.delims = [];
    // The emphasis mask (marked's #n): only needed when the string holds a
    // delimiter char; otherwise every delimiter is visible.
    const hasDelim = s.indexOf('*') !== -1 || s.indexOf('_') !== -1 || s.indexOf('~') !== -1;
    this.mask = hasDelim ? maskEmphasis(s, refs) : s;
    this.lastCloser = hasDelim ? lastPossibleCloser(this.mask) : null;
    this.i = 0;
    this.textStart = 0;
    // End position of the last structural token (link, code span, HTML,
    // autolink, escape, hard break). An email's local part may run back
    // over plain text and delimiter runs, but never past this point:
    // marked's url tokenizer is tried at the current lexer position,
    // after the previous token, so it cannot reclaim source text that
    // already belongs to an earlier email or URL.
    this.structEnd = 0;
    this.buf = null; // pending text pieces (decoded entities) before the run
    this.bufStart = 0; // source position where the first pending piece starts
  }

  // One code point (astral-aware) at UTF-16 index idx of str, or ''
  // when idx is out of range.
  cpAt(str, idx) {
    if (idx < 0 || idx >= str.length) return '';
    const cp = str.codePointAt(idx);
    return cp > 0xffff ? str.slice(idx, idx + 2) : str[idx];
  }

  // marked's `r` for the opener D, read off the nodes scanned so far:
  // "" after a structural token, the last raw char of a text run
  // (trailing `_`s skipped — a text token ending in `_` never updates
  // `r`), or the delimiter char itself after another delimiter.
  prevTokChar(D) {
    const at = this.nodes.indexOf(D);
    for (let j = at - 1; j >= 0; j--) {
      const nd = this.nodes[j];
      if (nd.t === 0) {
        if (nd.esc) return '';
        let e = nd.end;
        while (e > nd.pos && this.s[e - 1] === '_') e--;
        if (e > nd.pos) return this.cpAt(this.s, e - 1);
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
  openerCtx(D, r) {
    const ch = '_';
    let l = D.pos;
    while (l > 0 && this.mask[l - 1] === ch) l--;
    const p = [...this.mask.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
    const h = p === '*' || p === '_' || isPunctOrSpaceStr(p);
    let nn, u;
    if (l < D.pos) { nn = p; u = h; }
    else { nn = r; u = isPunctOrSpaceStr(nn); }
    return { l, p, h, n: nn, u, o: r === ch };
  }

  // Would marked's emStrong succeed for the `_` opener D, using the
  // nodes built so far? Returns the closer run's start position, or -1.
  // The url tokenizer is tried at a position only after emStrong fails
  // there, so an email's local part can include a `_` run only when
  // emStrong fails for it (no closer, rule of 3, gate, or m-count).
  // The closer may sit after the `@` (not scanned yet), so it is
  // verified from the mask and its flanking instead of from the
  // delimiter list.
  underscoreMatches(D) {
    // The mask hides closers only: an opener is tried whenever the
    // lexer reaches it as a delimiter, even if the mask hides it (the
    // mask's HTML branch is laxer than the tag tokenizer, e.g.
    // `<foo@...` is no tag but blockSkip hides it).
    if (!D.open) return -1;
    // No `_` run after the opener at all: emStrong cannot match.
    if (this.lastCloser['_'] < D.pos + D.n) return -1;
    const r = this.prevTokChar(D);
    const cx = this.openerCtx(D, r);
    // Gate checks (mirror tryEmStrong).
    const after = this.cpAt(this.s, D.pos + D.n);
    if (after && !isSpaceCode(after.codePointAt(0)) && isAlnumChar(cx.n)) return -1;
    const punct = (after && after !== '~' && isPunctCode(after.codePointAt(0))) ? after : '';
    if (punct && cx.n && !cx.u) return -1;
    const need = D.n;
    const span = D.pos - cx.l + need;
    const strongGate = cx.p.trim() !== '' && punct !== '';
    const from = D.pos + need;
    const tail = this.mask.slice(from);
    const lastIdx = this.lastCloser['_'] - from;
    const re = RDELIM_UND_RE;
    let left = need, extra = 0;
    re.lastIndex = 0;
    let hit;
    while ((hit = re.exec(tail)) !== null && !(hit.index > lastIdx)) {
      const grp = hit[1] || hit[2] || hit[3] || hit[4] || hit[5] || hit[6];
      if (!grp) continue;
      const blen = [...grp].length;
      const runAt = from + hit.index + [...hit[0]][0].length;
      // The closer run must be a real, visible `_` delimiter node:
      // present in the mask, maximal, and not dead by flanking.
      if (runAt + blen > this.mask.length ||
          this.mask.slice(runAt, runAt + blen) !== '_'.repeat(blen) ||
          (runAt + blen < this.mask.length && this.mask[runAt + blen] === '_')) continue;
      const flags = delimFlags(this.s, runAt, blen, '_');
      if (!flags.open && !flags.close) continue;
      if (hit[3] || hit[4]) { left += blen; continue; }
      if (hit[5] || hit[6] || strongGate) {
        if (cx.o && (hit[5] || hit[6])) return -1;
        if (span % 3 !== 0 && (span + blen) % 3 === 0) { extra += blen; continue; }
      }
      left -= blen;
      if (left > 0) continue;
      return runAt;
    }
    return -1;
  }

  // Record that a structural token ends at `end`: the next text run
  // starts there, and no email local part rewinds past it.
  markStructural(end) {
    this.textStart = end;
    this.structEnd = end;
  }

  // Append one text node (merging into the previous text node when it
  // has the same raw-block flag); empty text appends nothing.
  pushTextNode(t, start, upto) {
    if (!t) return;
    const last = this.nodes[this.nodes.length - 1];
    if (last && last.t === 0 && last.raw === this.ctx.inRawBlock) { last.s += t; last.end = upto; }
    else this.nodes.push({ t: 0, s: t, raw: this.ctx.inRawBlock, pos: start, end: upto });
  }

  flushText(upto) {
    if (this.buf === null) {
      if (upto > this.textStart) this.pushTextNode(this.s.slice(this.textStart, upto), this.textStart, upto);
    } else {
      if (upto > this.textStart) this.buf.push(this.s.slice(this.textStart, upto));
      const t = this.buf.join('');
      const start = this.bufStart;
      this.buf = null;
      this.pushTextNode(t, start, upto);
    }
    this.textStart = upto;
  }

  emitDecoded(str) {
    this.flushText(this.i);
    if (this.buf === null) { this.buf = []; this.bufStart = this.i; }
    this.buf.push(str);
    this.textStart = this.i;
  }

  // True when s[from..] holds only whitespace.
  restIsWs(from) {
    for (let m = from; m < this.n; m++) {
      if (!isSpaceCode(this.s.charCodeAt(m))) return false;
    }
    return true;
  }

  // Remove (or truncate) the nodes whose source span falls inside the
  // email [L, em): delimiter runs and text that the address reclaims,
  // because marked's url tokenizer matches the address from its first
  // character, before any emphasis is resolved. Only text and delimiter
  // nodes can sit inside an address; a structural token ends the walk.
  rewindEmail(L, em) {
    while (this.nodes.length > 0) {
      const nd = this.nodes[this.nodes.length - 1];
      if (nd.t === 9) {
        if (nd.pos >= L) {
          this.nodes.pop();
          const k = this.delims.indexOf(nd);
          if (k !== -1) this.delims.splice(k, 1);
          continue;
        }
        break; // a delimiter run cannot straddle L
      }
      if (nd.t === 0 && !nd.esc) {
        if (nd.pos >= L) { this.nodes.pop(); continue; }
        if (nd.end > L) {
          // Truncate to the part before L; the tail inside the address
          // is plain source text, so its length matches the source span.
          nd.s = nd.s.slice(0, nd.s.length - (nd.end - L));
          nd.end = L;
          if (!nd.s) this.nodes.pop();
        }
        break;
      }
      break;
    }
  }

  // Attempt a link or image at s[pos] === '[' (or after '!'). Returns
  // the index just past the construct, or -1.
  tryLink(pos, isImage) {
    const lab = scanLabel(this.s, pos, true);
    if (!lab) return -1;
    if (labelHasUnclosedTag(this.s, pos, lab.end)) return -1;
    const after = lab.end;
    const ac = this.s.charCodeAt(after);
    if (ac === 40) { // '(' inline link
      const dest = parseLinkDest(this.s, after + 1);
      if (dest) return this.completeLink(lab.label, dest.href, dest.title, dest.end, isImage);
      // Inline link failed: fall through to the shortcut reference check.
    }
    if (ac === 91) { // '[' reference link
      const ref = scanRefLabel(this.s, after);
      if (ref) {
        const key = normalizeLabel(ref.label === '' ? lab.label : ref.label);
        const def = this.refs[key];
        if (!def) return -1;
        return this.completeLink(lab.label, def.href, def.title, ref.end, isImage);
      }
      // Collapsed reference [foo][]: the empty second pair is consumed.
      if (this.s.charCodeAt(after + 1) === 93) {
        const key = normalizeLabel(lab.label);
        const def = this.refs[key];
        if (!def) return -1;
        return this.completeLink(lab.label, def.href, def.title, after + 2, isImage);
      }
      // unclosed second bracket: fall through to the shortcut check
    }
    const key = normalizeLabel(lab.label);
    const def = this.refs[key];
    if (!def) return -1;
    return this.completeLink(lab.label, def.href, def.title, lab.end, isImage);
  }

  completeLink(label, href, title, end, isImage) {
    const labelText = label.indexOf('\\') === -1 ? label : label.replace(/\\([\[\]])/g, '$1');
    const savedInLink = this.ctx.inLink;
    const savedEmitted = this.ctx.linkEmitted;
    const savedRaw = this.ctx.inRawBlock;
    this.ctx.inLink = true;
    this.ctx.linkEmitted = false;
    const kids = scanInline(labelText, this.refs, this.ctx);
    const innerEmitted = this.ctx.linkEmitted;
    this.ctx.inLink = savedInLink;
    if (!isImage && innerEmitted) {
      // A link inside a link: the outer link is dropped, its '[' stays text.
      this.ctx.linkEmitted = savedEmitted;
      this.ctx.inRawBlock = savedRaw;
      return -1;
    }
    if (isImage) this.ctx.linkEmitted = savedEmitted;
    else this.ctx.linkEmitted = true;
    if (isImage) {
      this.nodes.push({ t: 5, href, title, alt: renderInlineNodes(kids, true) });
    } else {
      this.nodes.push({ t: 4, href, title, kids });
    }
    return end;
  }

  // --- construct handlers (each advances this.i) ---

  onBackslash() {
    const s = this.s, n = this.n, i = this.i;
    const nc = s.charCodeAt(i + 1);
    if (nc === 10) { // backslash + newline: hard break (unless at the end)
      let k = i + 2;
      while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
      if (!this.restIsWs(k)) {
        this.flushText(i);
        this.nodes.push({ t: 2 });
        this.i = k;
        this.markStructural(k);
        return;
      }
      this.i += 2;
      return;
    }
    if (nc < 128 && ASCII_PUNCT_SET[nc]) {
      this.flushText(i);
      // An escape is a structural token in marked (not text), so it is
      // marked as such: the emphasis `r` after it is empty, and an
      // email address never starts inside its escaped character.
      this.nodes.push({ t: 0, s: s[i + 1], esc: true, pos: i, end: i + 2 });
      this.i += 2;
      this.markStructural(this.i);
      return;
    }
    this.i++;
  }

  // Code span content: newlines become spaces, and one leading plus one
  // trailing space are stripped when both are present and something
  // non-space sits between them.
  codeSpanContent(raw) {
    let content = raw;
    if (content.indexOf('\n') !== -1) content = content.replace(/\n/g, ' ');
    if (content.length > 1 && content.charCodeAt(0) === 32 &&
        content.charCodeAt(content.length - 1) === 32) {
      let hasNonSpace = false;
      for (let k = 1; k < content.length - 1; k++) {
        if (content.charCodeAt(k) !== 32) { hasNonSpace = true; break; }
      }
      if (hasNonSpace) content = content.slice(1, -1);
    }
    return content;
  }

  onBacktick() {
    const s = this.s, i = this.i;
    const m = runLength(s, i, 96);
    const close = findBacktickRun(s, i + m, m);
    if (close !== -1) {
      const content = this.codeSpanContent(s.slice(i + m, close));
      this.flushText(i);
      this.nodes.push({ t: 1, s: content });
      this.i = close + m;
      this.markStructural(this.i);
      return;
    }
    this.i += m;
  }

  pushDelim(ch, m, flags) {
    this.flushText(this.i);
    const d = {
      t: 9, ch, n: m, open: flags.open, close: flags.close, fopen: flags.fopen,
      pos: this.i, visible: this.mask.slice(this.i, this.i + m) === ch.repeat(m),
      inLink: this.ctx.inLink, inRaw: this.ctx.inRawBlock,
    };
    this.nodes.push(d);
    this.delims.push(d);
    this.i += m;
    this.textStart = this.i;
  }

  onEmphRun(c) {
    const s = this.s, i = this.i;
    const m = runLength(s, i, c);
    const ch = c === 42 ? '*' : '_';
    const flags = delimFlags(s, i, m, ch);
    if (!flags.open && !flags.close) { this.i += m; return; } // dead delimiter: literal text
    this.pushDelim(ch, m, flags);
  }

  onTildeRun() {
    const s = this.s, i = this.i;
    const m = runLength(s, i, 126);
    if (m > 2) { this.i += m; return; }
    const flags = delimFlags(s, i, m, '~');
    if (!flags.open && !flags.close) { this.i += m; return; } // dead delimiter: literal text
    this.pushDelim('~', m, flags);
  }

  onBracket(c) {
    const isImage = c === 33;
    const pos = isImage ? this.i + 1 : this.i;
    this.flushText(this.i);
    const end = this.tryLink(pos, isImage);
    if (end !== -1) {
      this.i = end;
      this.markStructural(this.i);
      return;
    }
    this.i++;
  }

  onAngle() {
    const s = this.s, i = this.i;
    const al = tryAutolink(s, i);
    if (al) {
      this.flushText(i);
      this.nodes.push({ t: 4, href: al.href, title: '', kids: null, autolink: true, text: al.text });
      this.i = al.end;
      this.markStructural(this.i);
      return;
    }
    const tg = scanTag(s, i);
    if (tg !== -1) {
      this.flushText(i);
      const raw = s.slice(i, tg);
      const name = tagNameOf(raw);
      const lower = raw.toLowerCase();
      const afterName = raw.charCodeAt((raw.charCodeAt(1) === 47 ? 2 : 1) + name.length);
      if (!this.ctx.inLink && lower.startsWith('<a ')) this.ctx.inLink = true;
      else if (this.ctx.inLink && lower === '</a>') this.ctx.inLink = false;
      const isPre = name === 'pre' || name === 'code' || name === 'kbd' || name === 'script';
      if (isPre && raw.charCodeAt(1) !== 47 && (afterName === 32 || afterName === 9 ||
          afterName === 10 || afterName === 62)) this.ctx.inRawBlock = true;
      else if (isPre && raw.charCodeAt(1) === 47) this.ctx.inRawBlock = false;
      this.nodes.push({ t: 3, s: raw });
      this.i = tg;
      this.markStructural(this.i);
      return;
    }
    this.i++;
  }

  onAmp() {
    const ref = this.ctx.inRawBlock ? null : numericRef(this.s, this.i);
    if (ref) {
      this.emitDecoded(ref.text);
      this.i = ref.end;
      this.textStart = this.i;
      return;
    }
    this.i++;
  }

  onNewline() {
    const s = this.s, i = this.i;
    let k = i - 1;
    let spaces = 0;
    while (k >= this.textStart && s.charCodeAt(k) === 32) { spaces++; k--; }
    if (spaces >= 2) {
      let m = i + 1;
      while (m < this.n && (s.charCodeAt(m) === 32 || s.charCodeAt(m) === 9)) m++;
      if (!this.restIsWs(m)) {
        this.flushText(i - spaces);
        this.nodes.push({ t: 2 });
        this.i = m;
        this.markStructural(m);
        return;
      }
    }
    this.i++;
  }

  onUrlStart(c) {
    const s = this.s, i = this.i;
    const prevOk = i === 0 || isSpaceCode(s.charCodeAt(i - 1)) ||
      s.charCodeAt(i - 1) === 42 || s.charCodeAt(i - 1) === 95 ||
      s.charCodeAt(i - 1) === 126 || s.charCodeAt(i - 1) === 40;
    const isWww = c === 119 && s.startsWith('www.', i);
    const isScheme = (c === 104 || c === 72 || c === 102 || c === 70) && matchScheme(s, i) !== -1;
    const isProto = (c === 109 || c === 120) &&
      (s.startsWith('mailto:', i) || s.startsWith('xmpp:', i)) &&
      (i === 0 || !isAlphaNumCode(s.charCodeAt(i - 1)));
    if (!this.ctx.inLink && ((isWww && prevOk) || isScheme || isProto)) {
      const u = tryUrl(s, i);
      if (u) {
        this.flushText(i);
        this.nodes.push({ t: 4, href: u.href, title: '', kids: null, autolink: true, text: u.text });
        this.i = u.end;
        this.markStructural(this.i);
        return;
      }
    }
    this.i++;
  }

  onAt() {
    const s = this.s, n = this.n, i = this.i;
    if (!this.ctx.inLink) {
      // The local part may run back over text and delimiter runs
      // (rewindEmail removes them), but never over a structural
      // token, and never over a `_` opener that emphasis would
      // consume: the rightmost such opener bounds the address.
      let bound = this.structEnd;
      for (let d = this.delims.length - 1; d >= 0; d--) {
        const cand = this.delims[d];
        if (cand.ch !== '_' || cand.pos >= i) continue;
        if (this.underscoreMatches(cand) !== -1) { bound = Math.max(bound, cand.pos + cand.n); break; }
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
            const hasUndOpener = this.delims.some((d) => d.ch === '_' && d.fopen && this.underscoreMatches(d) === pre);
            if (afterRunOk && hasUndOpener) em = pre;
          }
        }
        if (em !== -1) {
          this.flushText(L);
          this.rewindEmail(L, em);
          this.nodes.push({ t: 4, href: 'mailto:' + s.slice(L, em), title: '', kids: null, autolink: true, text: s.slice(L, em) });
          this.i = em;
          this.markStructural(em);
          return;
        }
      }
    }
    this.i++;
  }

  run() {
    const s = this.s, n = this.n;
    while (this.i < n) {
      const c = s.charCodeAt(this.i);
      switch (c) {
        case 92: this.onBackslash(); break; // backslash
        case 96: this.onBacktick(); break; // backtick: code span
        case 42: case 95: this.onEmphRun(c); break; // '*' or '_': emphasis delimiter
        case 126: this.onTildeRun(); break; // '~': strikethrough delimiter
        case 91: this.onBracket(c); break; // '['
        case 33: // '!': image only when followed by '['
          if (s.charCodeAt(this.i + 1) === 91) this.onBracket(c);
          else this.i++;
          break;
        case 60: this.onAngle(); break; // '<': autolink or raw HTML
        case 38: this.onAmp(); break; // '&': numeric character reference
        case 10: this.onNewline(); break; // newline: hard break if two spaces precede it
        case 119: case 104: case 72: case 102: case 70: case 109: case 120:
          this.onUrlStart(c); break; // w, h, f, m, x: possible extended autolink start
        case 64: this.onAt(); break; // '@': possible email autolink ending here
        default: this.i++; break;
      }
    }
    this.flushText(n);
    return processDelims(this.nodes, this.delims, s, this.refs, this.ctx, this.mask, this.lastCloser);
  }
}

function scanInline(s, refs, ctx) {
  return new InlineLexer(s, refs, ctx).run();
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
// Blocks are frames on an explicit stack. A frame's `kind` is a string
// ('doc', 'quote', 'list', 'item', 'para', 'head', 'code', 'html', 'hr',
// 'table') and `kids` holds its children; per-kind payload lives in
// fields on the frame itself. A BlockBuilder owns the whole line walk;
// an HtmlRenderer turns the finished tree into HTML.

// A remainder of a source line together with its absolute column. Tabs
// count to the next multiple of 4 from the line start. The cursor is
// mutated in place by the skip methods, which return it for chaining.
class Cursor {
  constructor(s, col) {
    this.s = s;
    this.col = col;
  }

  copy() {
    return new Cursor(this.s, this.col);
  }

  // Width of a tab starting at absolute column c.
  static tabW(c) {
    return 4 - (c % 4);
  }

  // Absolute column of the first non-space/tab character.
  contentCol() {
    let c = this.col, i = 0;
    const t = this.s;
    while (i < t.length) {
      const ch = t.charCodeAt(i);
      if (ch === 32) { c++; i++; }
      else if (ch === 9) { c += Cursor.tabW(c); i++; }
      else break;
    }
    return c;
  }

  // Index of the first non-space/tab character.
  contentIdx() {
    let i = 0;
    const t = this.s;
    while (i < t.length) {
      const ch = t.charCodeAt(i);
      if (ch === 32 || ch === 9) i++;
      else break;
    }
    return i;
  }

  // Leading indent in columns.
  indent() {
    return this.contentCol() - this.col;
  }

  // True when the rest is only spaces and tabs.
  blank() {
    const t = this.s;
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }

  // Skip whitespace until absolute column `target`. A tab straddling the
  // target is replaced by spaces ('pad', the usual rule) or dropped
  // entirely ('drop', the fenced-code rule). Stops at a non-space char.
  skipWs(target, mode) {
    let i = 0, c = this.col;
    const t = this.s;
    while (i < t.length && c < target) {
      const ch = t.charCodeAt(i);
      if (ch === 32) { c++; i++; }
      else if (ch === 9) {
        const nx = c + Cursor.tabW(c);
        if (nx > target) {
          this.s = (mode === 'drop' ? '' : ' '.repeat(nx - target)) + t.slice(i + 1);
          this.col = target;
          return this;
        }
        c = nx; i++;
      } else break;
    }
    this.s = t.slice(i);
    this.col = c;
    return this;
  }

  // Skip any characters until absolute column `target`; a tab straddling
  // the target is replaced by spaces. Used for list-item content.
  skipAny(target) {
    let i = 0, c = this.col;
    const t = this.s;
    while (i < t.length && c < target) {
      const ch = t.charCodeAt(i);
      if (ch === 9) {
        const nx = c + Cursor.tabW(c);
        if (nx > target) {
          this.s = ' '.repeat(nx - target) + t.slice(i + 1);
          this.col = target;
          return this;
        }
        c = nx; i++;
      } else { c++; i++; }
    }
    this.s = t.slice(i);
    this.col = c;
    return this;
  }

  // The remainder with leading tabs expanded to spaces, as if the
  // remainder started at its own absolute column.
  tabExpanded() {
    let i = 0, c = this.col, out = '';
    const t = this.s;
    while (i < t.length) {
      const ch = t.charCodeAt(i);
      if (ch === 32) { out += ' '; c++; i++; }
      else if (ch === 9) { const w = Cursor.tabW(c); out += ' '.repeat(w); c += w; i++; }
      else break;
    }
    return out + t.slice(i);
  }
}

// Length of the run of `code` starting at `i` in `text`.
function runLen(text, i, code) {
  let j = i;
  while (j < text.length && text.charCodeAt(j) === code) j++;
  return j - i;
}

// True when `s` holds only spaces and tabs.
function restBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

const HTML_BLOCK_TAGS = new Set(['address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'section', 'source', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul']);
const HTML_TYPE1_TAGS = ['script', 'pre', 'style', 'textarea'];

// Is the char at `i` a valid end for a type 1 / type 6 tag name?
function tagNameBoundary(t, i) {
  if (i >= t.length) return true;
  const c = t.charCodeAt(i);
  if (c === 32 || c === 9 || c === 62) return true;
  return c === 47 && t.charCodeAt(i + 1) === 62;
}

// ATX heading on `base` (already stripped). Returns {level, text} or null.
function atxHead(base) {
  const h = runLen(base, 0, 35); // '#'
  if (h === 0 || h > 6) return null;
  if (h < base.length) {
    const c = base.charCodeAt(h);
    if (c !== 32 && c !== 9) return null;
  }
  let end = base.length;
  while (end > h && (base.charCodeAt(end - 1) === 32 || base.charCodeAt(end - 1) === 9)) end--;
  let j = end;
  while (j > h && base.charCodeAt(j - 1) === 35) j--;
  if (j < end && j > h && (base.charCodeAt(j - 1) === 32 || base.charCodeAt(j - 1) === 9)) end = j;
  let start = h;
  while (start < end && (base.charCodeAt(start) === 32 || base.charCodeAt(start) === 9)) start++;
  while (end > start && (base.charCodeAt(end - 1) === 32 || base.charCodeAt(end - 1) === 9)) end--;
  return { level: h, text: base.slice(start, end) };
}

// Fenced code on `base`. Returns {ch, len, info} or null.
function fenceHead(base) {
  const ch = base.charCodeAt(0);
  if (ch !== 96 && ch !== 126) return null; // '`' or '~'
  const len = runLen(base, 0, ch);
  if (len < 3) return null;
  const info = base.slice(len).trim();
  if (ch === 96 && info.indexOf('`') !== -1) return null;
  return { ch, len, info };
}

// Thematic break: 3+ of the same -, * or _ char, spaces allowed between.
function thematicBreak(base) {
  let mark = 0, count = 0;
  for (let i = 0; i < base.length; i++) {
    const c = base.charCodeAt(i);
    if (c === 32 || c === 9) continue;
    if (c !== 45 && c !== 42 && c !== 95) return false;
    if (mark === 0) mark = c;
    else if (c !== mark) return false;
    count++;
  }
  return count >= 3;
}

// Setext underline level (1 for '=', 2 for '-'), 0 when not an underline.
function setextHead(base) {
  let a = 0, b = base.length;
  while (a < b && (base.charCodeAt(a) === 32 || base.charCodeAt(a) === 9)) a++;
  while (b > a && (base.charCodeAt(b - 1) === 32 || base.charCodeAt(b - 1) === 9)) b--;
  if (b - a < 1) return 0;
  const ch = base.charCodeAt(a);
  if (ch !== 61 && ch !== 45) return 0;
  if (a + runLen(base, a, ch) !== b) return 0;
  return ch === 61 ? 1 : 2;
}

// True when the dashes-only stretch cell[k..j) holds at least one dash.
function dashesOnly(cell, k, j) {
  if (j - k < 1) return false;
  for (let m = k; m < j; m++) if (cell.charCodeAt(m) !== 45) return false;
  return true;
}

// Parse a table delimiter row at `cur`. Returns the alignment array or null.
function delimHead(cur) {
  if (cur.indent() > 3) return null;
  const cells = splitCells(cur.s.slice(cur.contentIdx()));
  if (cells.length === 0) return null;
  const align = [];
  for (const cell of cells) {
    let k = 0, j = cell.length;
    const left = cell.charCodeAt(0) === 58; // ':'
    if (left) k = 1;
    const right = j > k && cell.charCodeAt(j - 1) === 58;
    if (right) j--;
    if (!dashesOnly(cell, k, j)) return null;
    align.push(left && right ? 'center' : left ? 'left' : right ? 'right' : '');
  }
  return align;
}

// Match an HTML block start on the stripped line `base`. Returns
// {type, tag} or null. Types 1-6 can interrupt a paragraph, type 7 cannot.
function htmlHead(base) {
  if (base.charCodeAt(0) !== 60) return null; // '<'
  const lower = base.toLowerCase();
  for (const tag of HTML_TYPE1_TAGS) {
    if (lower.startsWith('<' + tag) && tagNameBoundary(base, tag.length + 1)) {
      return { type: 1, tag };
    }
  }
  if (base.startsWith('<!--')) return { type: 2, tag: '' };
  if (base.startsWith('<?')) return { type: 3, tag: '' };
  if (base.startsWith('<![CDATA[')) return { type: 5, tag: '' };
  if (base.charCodeAt(1) === 33) { // '!'
    const c = base.charCodeAt(2);
    if (c >= 65 && c <= 90) return { type: 4, tag: '' }; // <! + uppercase letter
  }
  // type 6: < or </ + block tag name
  let i = 1;
  if (base.charCodeAt(1) === 47) i = 2; // '/'
  const start = i;
  while (i < base.length) {
    const c = base.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45) { i++; continue; }
    break;
  }
  const name = base.slice(start, i).toLowerCase();
  if (name && HTML_BLOCK_TAGS.has(name) && tagNameBoundary(base, i)) return { type: 6, tag: name };
  // type 7: a complete open or closing tag alone on the line
  const end = scanTag(base, 0);
  if (end !== -1 && restBlank(base.slice(end))) {
    const nm = tagNameOf(base.slice(0, end));
    if (nm && !HTML_TYPE1_TAGS.includes(nm)) return { type: 7, tag: nm };
  }
  return null;
}

// Match a list marker at the start of `base` (absolute column `baseCol`).
// Returns null or {ordered, start, delim, markerLen, contentIndent,
// content} where content is a Cursor at the item content; contentIndent
// is the absolute column of the item content.
function listMark(base, baseCol) {
  const c0 = base.charCodeAt(0);
  let ordered = false, start = 0, delim = '', markerLen = 0;
  if (c0 === 45 || c0 === 43 || c0 === 42) { // - + *
    markerLen = 1;
  } else if (c0 >= 48 && c0 <= 57) {
    let i = 0;
    while (i < base.length && i < 9 && base.charCodeAt(i) >= 48 && base.charCodeAt(i) <= 57) i++;
    if (i === 0) return null;
    const d = base.charCodeAt(i);
    if (d !== 46 && d !== 41) return null; // '.' or ')'
    ordered = true;
    start = parseInt(base.slice(0, i), 10);
    delim = base.charAt(i);
    markerLen = i + 1;
  } else return null;
  const after = markerLen < base.length ? base.charCodeAt(markerLen) : -1;
  if (after !== -1 && after !== 32 && after !== 9) return null;
  const afterCol = baseCol + markerLen;
  let idx = markerLen, c = afterCol;
  while (idx < base.length) {
    const ch = base.charCodeAt(idx);
    if (ch === 32) { c++; idx++; }
    else if (ch === 9) { c += Cursor.tabW(c); idx++; }
    else break;
  }
  let contentIndent, content;
  if (idx >= base.length) {
    contentIndent = baseCol + markerLen + 1;
    content = new Cursor('', contentIndent);
  } else {
    const spacesAfter = c - afterCol;
    contentIndent = spacesAfter <= 4 ? c : baseCol + markerLen + 1;
    content = new Cursor(base, baseCol).skipAny(contentIndent);
  }
  return { ordered, start, delim, markerLen, contentIndent, content };
}

// Lazy classification of one stripped line: each feature is scanned at
// most once, only when some caller asks for it.
class LineProbe {
  constructor(cur) {
    this.cur = cur;
    this._indent = undefined;
    this._base = undefined;
    this._atx = undefined;
    this._fence = undefined;
    this._html = undefined;
    this._tbreak = undefined;
    this._marker = undefined;
    this._setext = undefined;
    this._delim = undefined;
  }

  get indent() {
    if (this._indent === undefined) this._indent = this.cur.indent();
    return this._indent;
  }

  get base() {
    if (this._base === undefined) this._base = this.cur.s.slice(this.cur.contentIdx());
    return this._base;
  }

  get baseCol() {
    return this.cur.col + this.indent;
  }

  get atx() {
    if (this._atx === undefined) this._atx = atxHead(this.base);
    return this._atx;
  }

  get fence() {
    if (this._fence === undefined) this._fence = fenceHead(this.base);
    return this._fence;
  }

  get html() {
    if (this._html === undefined) this._html = htmlHead(this.base);
    return this._html;
  }

  get tbreak() {
    if (this._tbreak === undefined) this._tbreak = thematicBreak(this.base);
    return this._tbreak;
  }

  get marker() {
    if (this._marker === undefined) this._marker = listMark(this.base, this.baseCol);
    return this._marker;
  }

  get setext() {
    if (this._setext === undefined) this._setext = setextHead(this.base);
    return this._setext;
  }

  get delim() {
    if (this._delim === undefined) this._delim = delimHead(this.cur);
    return this._delim;
  }
}

// Parse a link reference definition starting at the first line. `peek(k)`
// returns logical line k (1 or 2, ...) as a string, or null. Returns
// {label, href, title, consumed} (consumed = number of lines) or null.
class DefParser {
  constructor(line0, peek) {
    this.peek = peek;
    this.win = [line0]; // logical lines, filled lazily
    this.li = 0; // index of the current line in the window
    this.pos = 0; // offset in the current line
    this.MAXL = 10;
  }

  // Window line k, fetching it with peek() when not cached yet.
  lineAt(k) {
    if (this.win[k] === undefined) {
      const p = this.peek(k);
      if (p === null) return null;
      this.win[k] = p;
    }
    return this.win[k];
  }

  curLine() {
    return this.win[this.li];
  }

  // Move to the next non-blank logical line; false when there is none.
  advanceLine() {
    if (this.li + 1 >= this.MAXL) return false;
    const nx = this.lineAt(this.li + 1);
    if (nx === null) return false;
    let j = 0;
    while (j < nx.length && (nx.charCodeAt(j) === 32 || nx.charCodeAt(j) === 9)) j++;
    if (j >= nx.length) return false; // blank line: cannot continue
    this.li++;
    this.pos = j;
    return true;
  }

  // Skip spaces/tabs on this line, crossing to further lines when
  // allowNL. True when a non-space character is reached.
  skipWs(allowNL) {
    for (;;) {
      const t = this.curLine();
      while (this.pos < t.length && (t.charCodeAt(this.pos) === 32 || t.charCodeAt(this.pos) === 9)) this.pos++;
      if (this.pos < t.length) return true;
      if (!allowNL) return false;
      if (!this.advanceLine()) return false;
    }
  }

  // Read the label (it may span lines). Returns the scanLabel result or
  // null, with li/pos placed just past the label.
  readLabel() {
    const first = scanLabel(this.win[0], 0, false);
    if (first) {
      this.pos = first.end;
      return first;
    }
    const parts = [this.win[0]];
    let combined = this.win[0];
    let found = null;
    for (let extra = 1; extra < this.MAXL; extra++) {
      const nx = this.peek(extra);
      if (nx === null) break;
      let jj = 0;
      while (jj < nx.length && (nx.charCodeAt(jj) === 32 || nx.charCodeAt(jj) === 9)) jj++;
      if (jj >= nx.length) break; // blank line: label cannot continue
      parts.push(nx);
      combined += '\n' + nx;
      const cand = scanLabel(combined, 0, false);
      if (cand) { found = cand; break; }
    }
    if (!found) return null;
    let remaining = found.end;
    let lineIdx = 0;
    for (let k = 0; k < parts.length; k++) {
      if (remaining <= parts[k].length) { lineIdx = k; break; }
      remaining -= parts[k].length + 1;
      lineIdx = k + 1;
    }
    for (let k = 1; k < parts.length; k++) this.win[k] = parts[k];
    this.li = lineIdx;
    this.pos = remaining;
    return found;
  }

  // Read the destination after the ':'; returns the raw href or null.
  readDest() {
    const t = this.curLine();
    const i = this.pos;
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
      this.pos = j + 1;
      return t.slice(i + 1, j);
    }
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
    this.pos = j;
    return t.slice(i, j);
  }

  // Read an optional title after the destination; may span lines.
  // Returns the raw title ('' when there is none). Restores the
  // position when no valid title follows.
  readTitle() {
    const saveL = this.li, saveI = this.pos;
    if (!this.skipWs(true)) return '';
    const t2 = this.curLine();
    const q = t2.charCodeAt(this.pos);
    if (q !== 34 && q !== 39 && q !== 40) { // " ' (
      this.li = saveL; this.pos = saveI;
      return '';
    }
    const closeCh = q === 40 ? 41 : q;
    let content = '';
    let curL = this.li, curI = this.pos + 1, found = false, endL = this.li, endI = -1;
    for (;;) {
      const line = this.win[curL];
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
      if (curL + 1 >= this.MAXL) break;
      const nx = this.peek(curL + 1);
      if (nx === null) break;
      let jj = 0;
      while (jj < nx.length && (nx.charCodeAt(jj) === 32 || nx.charCodeAt(jj) === 9)) jj++;
      if (jj >= nx.length) break; // blank line: title cannot continue
      if (this.win[curL + 1] === undefined) this.win[curL + 1] = nx;
      curL++;
      curI = 0;
    }
    if (found) {
      this.li = endL;
      this.pos = endI;
      return content;
    }
    this.li = saveL;
    this.pos = saveI;
    return '';
  }

  parse() {
    const lab = this.readLabel();
    if (!lab) return null;
    if (normalizeLabel(lab.label) === '') return null; // empty label
    if (this.curLine().charCodeAt(this.pos) !== 58) return null; // ':'
    this.pos++;
    if (!this.skipWs(true)) return null;
    const href = this.readDest();
    if (href === null) return null;
    // After the destination only whitespace (or end of line) may follow.
    const t = this.curLine();
    if (this.pos < t.length && t.charCodeAt(this.pos) !== 32 && t.charCodeAt(this.pos) !== 9) return null;
    const title = this.readTitle();
    const t2 = this.curLine();
    let k = this.pos;
    while (k < t2.length && (t2.charCodeAt(k) === 32 || t2.charCodeAt(k) === 9)) k++;
    if (k < t2.length) return null;
    return { label: lab.label, href: unescapePunct(href), title: title ? unescapePunct(title) : '', consumed: this.li + 1 };
  }
}

// ---------------------------------------------------------------------------
// Block parsing: the container walk
// ---------------------------------------------------------------------------

// Does `text` contain the end condition of HTML block `frame` (types 1-5)?
function htmlEndsIn(frame, text) {
  switch (frame.htmlKind) {
    case 1: return text.toLowerCase().indexOf('</' + frame.tag + '>') !== -1;
    case 2: return text.indexOf('-->') !== -1;
    case 3: return text.indexOf('?>') !== -1;
    case 4: return text.indexOf('>') !== -1;
    case 5: return text.indexOf(']]>') !== -1;
  }
  return false;
}

// A paragraph's lines joined, with leading/trailing spaces and tabs cut.
function joinedTrimmed(textLines) {
  const joined = textLines.join('\n');
  let a = 0, b = joined.length - 1;
  while (a <= b && (joined.charCodeAt(a) === 32 || joined.charCodeAt(a) === 9)) a++;
  while (b >= a && (joined.charCodeAt(b) === 32 || joined.charCodeAt(b) === 9)) b--;
  return a > b ? '' : joined.slice(a, b + 1);
}

// Length of a task-checkbox prefix "[ ] "/"[x] "/"[X] " on `line`, or 0.
function taskPrefixLen(line) {
  if (line.charCodeAt(0) !== 91) return 0; // '['
  const m = line.charCodeAt(1);
  if (m !== 32 && m !== 120 && m !== 88) return 0; // ' ', 'x', 'X'
  if (line.charCodeAt(2) !== 93) return 0; // ']'
  let i = 3;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i > 3 ? i : 0;
}

// True when `text` looks like a setext underline line (for lazy lines):
// up to 3 spaces, then a run of '=' or '-', then only spaces/tabs.
function setextLazyLine(text) {
  let i = 0;
  while (i < 3 && text.charCodeAt(i) === 32) i++;
  const ch = text.charCodeAt(i);
  if (ch !== 61 && ch !== 45) return false;
  i += runLen(text, i, ch);
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
    i++;
  }
  return true;
}

// Walks the source lines, maintaining the open-container stack and the
// block tree under `root`. All state lives on the instance; the methods
// below are the walk's phases.
class BlockBuilder {
  constructor(lines, endsNL) {
    this.lines = lines;
    this.n = lines.length;
    this.endsNL = endsNL;
    this.refs = Object.create(null);
    // Shared inline lexer state for the whole document.
    this.inlineCtx = { inLink: false, inRawBlock: false, linkEmitted: false };
    this.root = { kind: 'doc', kids: [] };
    this.stack = [this.root];
    this.prevBlank = false;
    this.blankLevel = -1; // stack index of the innermost container a blank line matched
    this.skipAhead = 0;
    this.defSeen = false;
  }

  // Does source line i end with a newline in the original input?
  hasNL(i) {
    return i < this.n - 1 || this.endsNL;
  }

  // Match the line against the open containers. Returns the remainder
  // cursor and `fail`, the stack index of the first container that did
  // not match, or -1 when all containers matched.
  matchContainers(line) {
    const cur = new Cursor(line, 0);
    for (let i = 1; i < this.stack.length; i++) {
      const frame = this.stack[i];
      if (frame.kind === 'quote') {
        const probe = cur.copy().skipWs(cur.col + 3, 'pad');
        if (probe.s.charCodeAt(0) === 62) { // '>'
          const c2 = probe.col + 1;
          // Expand tabs in the whitespace after '>' relative to the '>'
          // itself (as marked's J(m, b.length) does), NOT at the absolute
          // column: a tab after a nested '> >' expands from col 1 (3
          // spaces, one consumed below -> 2), not from the absolute col.
          const relCol = (probe.col - cur.col) + 1;
          const expanded = new Cursor(probe.s.slice(1), relCol).tabExpanded();
          cur.s = expanded;
          cur.col = c2;
          if (cur.s.charCodeAt(0) === 32) { cur.s = cur.s.slice(1); cur.col = c2 + 1; }
          continue;
        }
        return { cur, fail: i };
      }
      if (frame.kind === 'item') {
        if (cur.blank()) continue;
        const target = cur.col + frame.indent;
        const probe = cur.copy().skipWs(target, 'pad');
        if (probe.col >= target) {
          // A tab at the start of the item content expands to spaces.
          cur.s = new Cursor(probe.s, probe.col).tabExpanded();
          cur.col = probe.col;
          continue;
        }
        return { cur, fail: i };
      }
      if (frame.kind === 'list') continue; // list: always matches
      return { cur, fail: -1 }; // leaf block
    }
    return { cur, fail: -1 };
  }

  // The remainder of line `idx` after matching the open containers, or
  // null when it does not match them (used for link definition lookahead).
  logicalLine(idx) {
    if (idx >= this.n) return null;
    const m = this.matchContainers(this.lines[idx]);
    if (m.fail !== -1) return null;
    return m.cur.s;
  }

  // Is the line at `idx` blank at the current block level?
  nextBlank(idx) {
    if (idx >= this.n) return false;
    const m = this.matchContainers(this.lines[idx]);
    return m.cur.blank();
  }

  // Is the line at `idx` EMPTY (not merely whitespace-only) at the current
  // block level? HTML blocks of types 1-5 strip one trailing '\n' only
  // when followed by a truly empty line; a whitespace-only line (space or
  // tab) does not strip it (marked keeps the '\n' then).
  nextEmpty(idx) {
    if (idx >= this.n) return false;
    const m = this.matchContainers(this.lines[idx]);
    return m.cur.s === '';
  }

  // Close frames from the top down to (but not including) stack[toDepth].
  // `strip` marks HTML blocks whose following line is blank.
  closeTo(toDepth, strip) {
    while (this.stack.length > toDepth) {
      const frame = this.stack.pop();
      if (frame.kind === 'item') this.finalizeItem(frame);
      else if (frame.kind === 'html') frame.trimNext = strip;
    }
  }

  // A list item's first paragraph may start with a task checkbox.
  finalizeItem(frame) {
    if (!frame.hasMarker) return;
    const first = frame.kids[0];
    if (!first || first.kind !== 'para') return;
    const line0 = first.textLines[0];
    if (line0 === undefined) return;
    const mLen = taskPrefixLen(line0);
    if (mLen === 0 || mLen >= line0.length) return;
    frame.task = line0.charCodeAt(1) === 32 ? 1 : 2;
    first.textLines[0] = line0.slice(mLen);
  }

  // Append a frame as a child of the innermost open container, marking
  // looseness when a blank line at (or above) this level preceded it.
  // A blank line inside a nested block (e.g. a quote inside an item)
  // does not loosen the outer list.
  attach(frame) {
    const parent = this.stack[this.stack.length - 1];
    if (this.prevBlank) {
      if (parent.kind === 'item' && parent.kids.length > 0 && this.blankLevel <= this.stack.length - 1) parent.loose = true;
      if (frame.kind === 'item' && parent.kind === 'list' && parent.kids.length > 0 && this.blankLevel <= this.stack.length) parent.loose = true;
    }
    parent.kids.push(frame);
  }

  popDanglingList() {
    if (this.stack[this.stack.length - 1].kind === 'list') this.stack.pop();
  }

  // Does the line start a block that can interrupt a paragraph?
  // `anyList` is true when the line is outside the paragraph's container
  // (a lazy continuation candidate): there any list marker interrupts,
  // because it starts a new item or a new list at an outer level.
  interrupts(cur, anyList) {
    const probe = new LineProbe(cur);
    if (probe.indent > 3) return false;
    const base = probe.base;
    if (base.charCodeAt(0) === 62) return true; // '>' blockquote
    if (probe.atx) return true;
    if (probe.fence) return true;
    const h = probe.html;
    if (h && h.type <= 6) return true;
    if (probe.tbreak) return true;
    const lm = probe.marker;
    if (lm) {
      if (anyList) return true;
      if (!lm.ordered) return lm.content.s !== '';
      return lm.start === 1 && lm.content.s !== '';
    }
    return false;
  }

  closingFence(text, top) {
    if (text.charCodeAt(0) !== top.fenceChar) return false;
    const run = runLen(text, 0, top.fenceChar);
    if (run < top.fenceLen) return false;
    return restBlank(text.slice(run));
  }

  // Try to start a block from the remainder cursor. Returns {done} when
  // the line is consumed, or {done:false, cur} when a container was
  // pushed and the remainder still needs processing.
  openBlock(cur, li) {
    const probe = new LineProbe(cur);
    const ind = probe.indent;
    const top0 = this.stack[this.stack.length - 1];
    if (top0.kind === 'list') {
      // A list with no open item ends here unless this line starts a new
      // item in it.
      let keep = false;
      if (ind <= 3) {
        const lm0 = probe.marker;
        keep = !!lm0 && !probe.tbreak && lm0.ordered === top0.ordered &&
          (lm0.ordered ? lm0.delim === top0.delim : probe.base.charAt(0) === top0.marker);
      }
      if (!keep) this.stack.pop();
    }
    if (ind >= 4) {
      const r = cur.copy().skipWs(cur.col + 4, 'pad');
      const code = { kind: 'code', fenced: false, info: '', raw: '', blankRun: 0 };
      this.attach(code);
      this.stack.push(code);
      code.raw += r.s + (this.hasNL(li) ? '\n' : '');
      return { done: true };
    }
    const base = probe.base;
    const baseCol = probe.baseCol;
    if (base.charCodeAt(0) === 62) { // '>' blockquote
      let t2 = base.slice(1), c2 = baseCol + 1;
      // Expand tabs in the whitespace after '>', then consume the
      // one optional space, as marked does.
      const expanded = new Cursor(t2, c2).tabExpanded();
      if (expanded.charCodeAt(0) === 32) { t2 = expanded.slice(1); c2++; }
      else t2 = expanded;
      const q = { kind: 'quote', kids: [] };
      this.attach(q);
      this.stack.push(q);
      if (restBlank(t2)) return { done: true };
      return { done: false, cur: new Cursor(t2, c2) };
    }
    const atx = probe.atx;
    if (atx) {
      this.attach({ kind: 'head', level: atx.level, text: atx.text });
      return { done: true };
    }
    const fen = probe.fence;
    if (fen) {
      // marked strips the fence indent from content lines only for
      // backtick fences; tilde fences keep the content indentation as-is
      // (``   ~~~ `` + `   foo` -> `   foo`, not `foo`). fen.ch is a char
      // code: 126 is '~'.
      const code = { kind: 'code', fenced: true, info: fen.info, raw: '', fenceChar: fen.ch, fenceLen: fen.len, fenceIndent: fen.ch === 126 ? 0 : ind, blankRun: 0 };
      this.attach(code);
      this.stack.push(code);
      return { done: true };
    }
    const h = probe.html;
    if (h) {
      const html = { kind: 'html', htmlKind: h.type, tag: h.tag, raw: '', trimNext: false };
      this.attach(html);
      html.raw += cur.s + (this.hasNL(li) ? '\n' : '');
      if (h.type <= 5 && htmlEndsIn(html, cur.s)) {
        html.trimNext = this.nextEmpty(li + 1);
        return { done: true };
      }
      this.stack.push(html);
      return { done: true };
    }
    if (probe.tbreak) {
      this.attach({ kind: 'hr' });
      return { done: true };
    }
    const def = new DefParser(base, (k) => this.logicalLine(li + k)).parse();
    if (def) {
      const key = normalizeLabel(def.label);
      if (!(key in this.refs)) this.refs[key] = { href: def.href, title: def.title };
      this.skipAhead = def.consumed - 1;
      this.defSeen = true;
      return { done: true };
    }
    const lm = probe.marker;
    if (lm) {
      const parent = this.stack[this.stack.length - 1];
      let list = null;
      if (parent.kind === 'list' && parent.ordered === lm.ordered &&
          (lm.ordered ? parent.delim === lm.delim : base.charAt(0) === parent.marker)) {
        list = parent;
      } else {
        list = { kind: 'list', ordered: lm.ordered, start: lm.start, delim: lm.delim, marker: base.charAt(0), kids: [], loose: false };
        this.attach(list);
        this.stack.push(list);
      }
      // Store the content indent relative to the remainder's start
      // column, so it stays valid when the enclosing containers sit at
      // different columns on later lines (e.g. quote markers shifted).
      const item = { kind: 'item', kids: [], indent: lm.contentIndent - cur.col, task: 0, hasMarker: lm.content.s !== '', loose: false };
      if (this.prevBlank && this.blankLevel <= this.stack.length && list.kids.length > 0) list.loose = true;
      list.kids.push(item);
      this.stack.push(item);
      if (lm.content.s === '') return { done: true };
      return { done: false, cur: lm.content };
    }
    const p = { kind: 'para', textLines: [cur.s], dedented: false };
    this.attach(p);
    this.stack.push(p);
    return { done: true };
  }

  // Process one (non-blank) line's remainder: continue the open leaf
  // block or start new blocks.
  feedRemainder(cur, li) {
    for (;;) {
      const top = this.stack[this.stack.length - 1];
      if (top.kind === 'para') {
        const probe = new LineProbe(cur);
        if (probe.indent <= 3) {
          const st = probe.setext;
          if (st) {
            const parent = this.stack[this.stack.length - 2];
            const headingText = joinedTrimmed(top.textLines);
            parent.kids[parent.kids.indexOf(top)] = { kind: 'head', level: st, text: headingText };
            this.stack.pop();
            return;
          }
          const delim = probe.delim;
          if (delim) {
            const headerCells = splitCells(top.textLines[top.textLines.length - 1]);
            if (headerCells.length === delim.length) {
              top.textLines.pop();
              this.stack.pop();
              const parent = this.stack[this.stack.length - 1];
              if (top.textLines.length === 0) parent.kids.splice(parent.kids.indexOf(top), 1);
              const tbl = { kind: 'table', header: headerCells, align: delim, rows: [] };
              this.attach(tbl);
              this.stack.push(tbl);
              return;
            }
          }
          const under = this.stack[this.stack.length - 2];
          if (this.interrupts(cur, under && under.kind === 'item')) {
            this.stack.pop();
            continue;
          }
        }
        top.dedented = false;
        const parent = this.stack[this.stack.length - 2];
        if (parent && parent.kind === 'item') {
          const r = cur.copy().skipWs(cur.col + 4, 'pad');
          if (r.col >= cur.col + 4) cur = r;
        }
        top.textLines.push(cur.s);
        return;
      }
      if (top.kind === 'code') {
        if (top.fenced) {
          const probe = new LineProbe(cur);
          if (probe.indent <= 3 && this.closingFence(probe.base, top)) {
            this.stack.pop();
            return;
          }
          const r = cur.copy().skipWs(cur.col + top.fenceIndent, 'drop');
          top.raw += r.s + (this.hasNL(li) ? '\n' : '');
          return;
        }
        const probe = new LineProbe(cur);
        if (probe.indent >= 4) {
          const r = cur.copy().skipWs(cur.col + 4, 'pad');
          if (top.blankRun > 0) { top.raw += '\n'.repeat(top.blankRun); top.blankRun = 0; }
          top.raw += r.s + (this.hasNL(li) ? '\n' : '');
          return;
        }
        this.stack.pop(); // close the code block, reprocess the line
        continue;
      }
      if (top.kind === 'html') {
        top.raw += cur.s + (this.hasNL(li) ? '\n' : '');
        if (top.htmlKind <= 5 && htmlEndsIn(top, cur.s)) {
          this.stack.pop();
          top.trimNext = this.nextEmpty(li + 1);
        }
        return;
      }
      if (top.kind === 'table') {
        if (this.interrupts(cur)) {
          this.stack.pop();
          continue;
        }
        top.rows.push(splitCells(cur.s, top.header.length));
        return;
      }
      const r = this.openBlock(cur, li);
      if (r.done) return;
      cur = r.cur;
    }
  }

  // Feed one blank line (remainder `cur`, container-match result `fail`).
  // Returns the index of the next source line to process.
  feedBlank(cur, fail, li) {
    if (fail !== -1) {
      this.closeTo(fail, true);
    } else {
      const top = this.stack[this.stack.length - 1];
      if (top.kind === 'code' && top.fenced) {
        const r = cur.copy().skipWs(cur.col + top.fenceIndent, 'drop');
        top.raw += r.s + (this.hasNL(li) ? '\n' : '');
      } else if (top.kind === 'code') {
        // A blank line with 4+ columns of indent is code content, not blank.
        const r = cur.copy().skipWs(cur.col + 4, 'pad');
        if (r.col >= cur.col + 4) {
          if (top.blankRun > 0) { top.raw += '\n'.repeat(top.blankRun); top.blankRun = 0; }
          top.raw += r.s + (this.hasNL(li) ? '\n' : '');
          this.prevBlank = false;
          return li + 1;
        }
        top.blankRun++;
      } else if (top.kind === 'html' && top.htmlKind <= 5) {
        top.raw += '\n';
      } else if (top.kind === 'para' && cur.s.length > 0) {
        // A line of only spaces/tabs is paragraph text when it is the
        // last line of the paragraph's container chunk (blockquote) or
        // of the source itself (top level); otherwise it is a blank line.
        const parent = this.stack[this.stack.length - 2];
        let appended = false;
        if (parent && parent.kind === 'quote') {
          const pIdx = this.stack.length - 2;
          let lastOfChunk = li + 1 >= this.n;
          if (!lastOfChunk) {
            const nm = this.matchContainers(this.lines[li + 1]);
            lastOfChunk = nm.fail !== -1 && nm.fail <= pIdx;
          }
          if (lastOfChunk) {
            top.textLines.push(cur.s);
            this.stack.pop(); // close the paragraph so the next line is not lazy
            appended = true;
          }
        } else if (!parent || parent.kind === 'doc') {
          if (!this.hasNL(li)) {
            top.textLines.push(cur.s);
            appended = true;
          }
        }
        if (appended) {
          this.prevBlank = false;
          return li + 1;
        }
        this.closeTo(this.stack.length - 1, true);
      } else if (top.kind === 'para' || top.kind === 'table' || top.kind === 'html') {
        this.closeTo(this.stack.length - 1, true);
      }
      // An empty list item followed by a blank line is closed; later
      // lines are not part of it.
      const nt = this.stack[this.stack.length - 1];
      if (nt && nt.kind === 'item' && nt.kids.length === 0 && !nt.hasMarker) this.stack.pop();
    }
    this.prevBlank = true;
    return li + 1;
  }

  // Feed one non-blank line whose containers did not all match
  // (`fail` = first unmatched container). Returns the next line index
  // when the line is consumed (lazy paragraph continuation), or null
  // when the caller should run feedRemainder on it.
  feedLazy(cur, fail, li) {
    const top = this.stack[this.stack.length - 1];
    if (top.kind === 'para' && !this.interrupts(cur, true)) {
      let line = cur.s;
      const failed = this.stack[fail];
      if (failed.kind === 'quote') {
        if (setextLazyLine(cur.s)) {
          // A setext-looking lazy line is indented so it stays text.
          let sp = 0;
          while (sp < cur.s.length && cur.s.charCodeAt(sp) === 32) sp++;
          line = '    ' + cur.s.slice(sp);
        } else if (top.dedented) {
          line = cur.copy().skipWs(cur.col + 4, 'pad').s;
        } else {
          const lead = cur.indent();
          if (lead >= 4) {
            top.dedented = true;
            line = cur.copy().skipWs(cur.col + 4, 'pad').s;
          }
        }
      } else if (failed.kind === 'item') { // list item: strip 4 columns when present
        const r = cur.copy().skipWs(cur.col + 4, 'pad');
        if (r.col >= cur.col + 4) line = r.s;
      }
      top.textLines.push(line);
      this.prevBlank = false;
      return li + 1;
    }
    if (top.kind === 'code' && top.fenced && this.stack[fail].kind === 'item' && top.raw !== '' &&
        !this.stack.slice(fail + 1, -1).some((f) => f.kind === 'quote')) {
      // A fenced code block DIRECTLY inside a list item swallows lines
      // even when they fail the item's indent — but ONLY once the block
      // already has content: an empty fence does not swallow the first
      // content line (marked leaves it empty and the line becomes a
      // paragraph outside the list, e.g. `+ item` + `` ```sh `` +
      // `print("hi")` at col 0). And only when no blockquote sits
      // between the item and the fence: a line without '>' is outside
      // the quote and closes it and the fence (cm-237). Fall through to
      // feedRemainder, which handles the closing-fence check and
      // appends the raw line; do NOT close the code block here.
      return null;
    }
    this.closeTo(fail, true);
    return null;
  }

  run() {
    let li = 0;
    while (li < this.n) {
      const line = this.lines[li];
      const m = this.matchContainers(line);
      const cur = m.cur;
      // A whitespace-only line that contains a tab is a table row, not a
      // blank line, when a table is open (marked treats it as a row of empty
      // cells); a spaces-only line does end the table.
      const tabRow = this.stack[this.stack.length - 1].kind === 'table' && cur.s.includes('\t');
      if (cur.blank() && !tabRow) {
        // The innermost container this blank line matched: its level decides
        // which looseness it can cause. A line of only whitespace is blank
        // at every level (depth 0); a line holding only container markers
        // (e.g. "  >") is blank only at the innermost marker's level.
        this.blankLevel = restBlank(line) ? 0 : (m.fail !== -1 ? m.fail - 1
          : (this.stack[this.stack.length - 1].kind === 'list' ? this.stack.length - 1 : this.stack.length - 2));
        li = this.feedBlank(cur, m.fail, li);
        continue;
      }
      if (m.fail !== -1) {
        const next = this.feedLazy(cur, m.fail, li);
        if (next !== null) { li = next; continue; }
      }
      this.feedRemainder(cur, li);
      if (!this.defSeen) this.prevBlank = false;
      this.defSeen = false;
      li += 1 + this.skipAhead;
      this.skipAhead = 0;
    }
    this.closeTo(1, false);
    return this.root;
  }
}

// First whitespace-delimited word of `s` (the fenced-code language).
function firstWord(s) {
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (isSpaceCode(c) || c === 0xfeff) break;
    i++;
  }
  return s.slice(0, i);
}

// Turns a finished block tree into the HTML string. Dispatch is by
// method name: frame_<kind>.
class HtmlRenderer {
  constructor(refs, inlineCtx) {
    this.refs = refs;
    this.ictx = inlineCtx;
    this.out = [];
  }

  render(root) {
    this.renderFrames(root.kids);
    return this.out.join('');
  }

  inline(text) {
    return renderInlineHtml(text, this.refs, this.ictx);
  }

  renderFrames(frames) {
    for (const frame of frames) this['frame_' + frame.kind](frame);
  }

  frame_quote(frame) {
    this.out.push('<blockquote>\n');
    this.renderFrames(frame.kids);
    this.out.push('</blockquote>\n');
  }

  frame_list(frame) {
    if (frame.ordered) this.out.push(frame.start !== 1 ? '<ol start="' + frame.start + '">\n' : '<ol>\n');
    else this.out.push('<ul>\n');
    const loose = frame.loose || frame.kids.some((it) => it.loose);
    for (const it of frame.kids) this.frame_item(it, loose);
    this.out.push(frame.ordered ? '</ol>\n' : '</ul>\n');
  }

  frame_item(it, loose) {
    const kids = it.kids;
    const taskHtml = it.task === 2 ? '<input checked="" disabled="" type="checkbox"> '
      : it.task === 1 ? '<input disabled="" type="checkbox"> ' : '';
    this.out.push('<li>');
    for (let k = 0; k < kids.length; k++) {
      const c = kids[k];
      if (c.kind === 'para') {
        // In a tight list every paragraph renders bare (no <p> tags);
        // in a loose list every paragraph is wrapped.
        const html = this.inline(c.textLines.join('\n'));
        if (loose) this.out.push('<p>' + (k === 0 ? taskHtml : '') + html + '</p>\n');
        else this.out.push((k === 0 ? taskHtml : '') + html);
      } else {
        this.renderFrames([c]);
      }
    }
    this.out.push('</li>\n');
  }

  frame_para(frame) {
    this.out.push('<p>' + this.inline(frame.textLines.join('\n')) + '</p>\n');
  }

  frame_head(frame) {
    this.out.push('<h' + frame.level + '>' + this.inline(frame.text) + '</h' + frame.level + '>\n');
  }

  frame_code(frame) {
    let raw = frame.raw;
    if (raw.charCodeAt(raw.length - 1) === 10) raw = raw.slice(0, -1);
    if (raw !== '' && raw.charCodeAt(raw.length - 1) !== 10) raw += '\n';
    this.out.push('<pre><code');
    if (frame.fenced && frame.info) {
      const lang = firstWord(unescapePunct(frame.info));
      if (lang) this.out.push(' class="language-' + escText(lang) + '"');
    }
    this.out.push('>' + escFull(raw) + '</code></pre>\n');
  }

  frame_html(frame) {
    let raw = frame.raw;
    if (frame.trimNext && raw.charCodeAt(raw.length - 1) === 10) raw = raw.slice(0, -1);
    this.out.push(raw);
  }

  frame_hr(frame) {
    this.out.push('<hr>\n');
  }

  frame_table(frame) {
    this.out.push('<table>\n<thead>\n<tr>\n');
    for (let i = 0; i < frame.header.length; i++) {
      this.out.push('<th' + (frame.align[i] ? ' align="' + frame.align[i] + '"' : '') + '>' +
        this.inline(frame.header[i]) + '</th>\n');
    }
    this.out.push('</tr>\n</thead>\n');
    if (frame.rows.length > 0) {
      this.out.push('<tbody>');
      for (const row of frame.rows) {
        this.out.push('<tr>\n');
        for (let i = 0; i < row.length; i++) {
          this.out.push('<td' + (frame.align[i] ? ' align="' + frame.align[i] + '"' : '') + '>' +
            this.inline(row[i]) + '</td>\n');
        }
        this.out.push('</tr>\n');
      }
      this.out.push('</tbody>');
    }
    this.out.push('</table>\n');
  }
}

// Parse markdown to the HTML marked 18.1.3 renders with its defaults.
export function parse(markdown) {
  const src = markdown.includes('\r') ? markdown.replace(/\r\n?/g, '\n') : markdown;
  const lines = src.split('\n');
  const endsNL = lines.length > 0 && lines[lines.length - 1] === '';
  if (endsNL) lines.pop();
  const builder = new BlockBuilder(lines, endsNL);
  const root = builder.run();
  return new HtmlRenderer(builder.refs, builder.inlineCtx).render(root);
}
