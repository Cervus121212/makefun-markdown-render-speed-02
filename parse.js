// Fast drop-in for marked 18.1.3 (default options: gfm on, breaks off).
// Written from scratch: a line-based block parser plus a flat-atom inline
// parser with a CommonMark delimiter-stack emphasis pass. No dependencies.
// parse(markdown) returns exactly the HTML marked renders, code unit for
// code unit, for every input; parse keeps nothing between calls.

// ---------- text helpers ----------

// CommonMark "punctuation" = ASCII punctuation or Unicode category P
// (punctuation) or S (symbol): '$', '£', '€' count as punctuation.
const PUNCT_RE = /[\p{P}\p{S}]/u;
const SPACE_RE = /\s/;

// Document-level state (reset in parse()): whether the inline scan
// is currently inside an <a>...</a> element. An <a> open tag sets it;
// a </a> close tag clears it. Extended autolinks (www./scheme/email)
// are not recognised while it is set. The state persists across
// blocks: an <a> left unclosed in one paragraph suppresses extended
// autolinks in later paragraphs until a </a> appears. Angle-bracket
// autolinks and bracket links are not affected. (A marked quirk,
// verified by oracle44-49.)
let suppressExtAutolink = false;

// True if tagText is an <a ...> open tag that opens marked's
// in-link state. Empirically (oracle53-57) the tag must start with
// "<a" followed by a literal space: bare "<a>", "<a/>",
// "<a\nhref=...>" and "<a\thref=...>" do NOT set it, while
// "<a href=...>", "<a />" and "<A HREF=...>" do. A tag that becomes
// an HTML block never reaches scanInline, so it never sets the flag.
// True if it is a </a> close tag is reported via isAnchorClose.
function isAnchorOpen(tagText) {
  return /^<a /i.test(tagText);
}
function isAnchorClose(tagText) {
  return /^<\/a\s*>$/i.test(tagText);
}

// Escape & < > " ' for text and attribute values (marked escapes all five).
export function escapeHtml(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) { out += s.slice(last, i) + rep; last = i + 1; }
  }
  return out + s.slice(last);
}

// Escape an attribute value (href, title, fence language) the way marked
// does: & < > " ' are escaped, EXCEPT an & that starts an entity
// reference (&name; or &#...;), which is kept verbatim.
function escapeAttr(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 &&
      s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '&') {
      if (matchNamedEntity(s, i) || matchNumericEntity(s, i)) continue;
      out += s.slice(last, i) + '&amp;';
      last = i + 1;
    } else {
      const c = s.charCodeAt(i);
      let rep = null;
      if (c === 60) rep = '&lt;';
      else if (c === 62) rep = '&gt;';
      else if (c === 34) rep = '&quot;';
      else if (c === 39) rep = '&#39;';
      if (rep !== null) { out += s.slice(last, i) + rep; last = i + 1; }
    }
  }
  return out + s.slice(last);
}

function isSpaceCh(ch) {
  if (ch === undefined) return true;
  const c = ch.charCodeAt(0);
  if (c === 32 || (c >= 9 && c <= 13)) return true;
  if (c < 128) return false;
  return SPACE_RE.test(ch);
}

function isPunctCh(ch) {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) {
    return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
      (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
  }
  return PUNCT_RE.test(ch);
}

function isAsciiPunct(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

// ---------- named entities (HTML5 subset incl. every name the spec
// examples and the generated documents use) ----------

const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', Tab: '\t', NewLine: '\n',
  iexcl: '¡', cent: '¢', pound: '£', curren: '¤', yen: '¥', brvbar: '¦', sect: '§',
  uml: '¨', copy: '©', ordf: 'ª', laquo: '«', not: '¬', shy: '­', reg: '®',
  macr: '¯', deg: '°', plusmn: '±', sup2: '²', sup3: '³', acute: '´', micro: 'µ',
  para: '¶', middot: '·', cedil: '¸', sup1: '¹', ordm: 'º', raquo: '»',
  frac14: '¼', frac12: '½', frac34: '¾', iquest: '¿',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å',
  AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë',
  Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï', ETH: 'Ð', Ntilde: 'Ñ',
  Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', times: '×',
  Oslash: 'Ø', Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý',
  THORN: 'Þ', szlig: 'ß', agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã',
  auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é',
  ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  eth: 'ð', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ',
  ouml: 'ö', divide: '÷', oslash: 'ø', ugrave: 'ù', uacute: 'ú', ucirc: 'û',
  uuml: 'ü', yacute: 'ý', thorn: 'þ', yuml: 'ÿ',
  OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ', fnof: 'ƒ',
  circ: 'ˆ', tilde: '˜', ensp: ' ', emsp: ' ', thinsp: ' ',
  zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚',
  ldquo: '“', rdquo: '”', bdquo: '„', dagger: '†', Dagger: '‡',
  bull: '•', hellip: '…', permil: '‰', prime: '′', Prime: '″',
  lsaquo: '‹', rsaquo: '›', oline: '‾', frasl: '⁄', euro: '€',
  image: 'ℑ', weierp: '℘', real: 'ℝ', trade: '™', alefsym: 'ℵ',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔', crarr: '↵',
  lArr: '⇐', uArr: '⇑', rArr: '⇒', dArr: '⇓', hArr: '⇔',
  forall: '∀', part: '∂', exist: '∃', empty: '∅', nabla: '∇',
  isin: '∈', notin: '∉', ni: '∋', prod: '∏', sum: '∑', minus: '−',
  lowast: '∗', radic: '√', prop: '∝', infin: '∞', ang: '∠',
  and: '∧', or: '∨', cap: '∩', cup: '∪', int: '∫', there4: '∴',
  sim: '∼', cong: '≅', asymp: '≈', ne: '≠', equiv: '≡', le: '≤', ge: '≥',
  sub: '⊂', sup: '⊃', nsub: '⊄', sube: '⊆', supe: '⊇', oplus: '⊕',
  otimes: '⊗', perp: '⊥', sdot: '⋅', lceil: '⌈', rceil: '⌉',
  lfloor: '⌊', rfloor: '⌋', lang: '⟨', rang: '⟩', loz: '◊',
  spades: '♠', clubs: '♣', hearts: '♥', diams: '♦',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε', Zeta: 'Ζ',
  Eta: 'Η', Theta: 'Θ', Iota: 'Ι', Kappa: 'Κ', Lambda: 'Λ', Mu: 'Μ',
  Nu: 'Ν', Xi: 'Ξ', Omicron: 'Ο', Pi: 'Π', Rho: 'Ρ', Sigma: 'Σ',
  Tau: 'Τ', Upsilon: 'Υ', Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ',
  nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ', sigmaf: 'ς',
  sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ',
  omega: 'ω', thetasym: 'ϑ', upsih: 'ϒ', piv: 'ϖ',
  Dcaron: 'Ď', dcaron: 'ď', HilbertSpace: 'ℋ', DifferentialD: 'ⅆ',
  ClockwiseContourIntegral: '∲', ngE: '≧', nge: '≱', nges: '⩾',
  colon: ':', semi: ';', sol: '/', bsol: '\\', equals: '=', commat: '@',
  lpar: '(', rpar: ')', lsqb: '[', rsqb: ']', lcub: '{', rcub: '}',
  verbar: '|', quest: '?', check: '✓', cross: '✗', star: '★',
};

// Length of a named entity reference '&name;' starting at s[i], or 0.
// Any name counts: marked passes the reference through verbatim, valid
// HTML5 entity or not, so no table lookup is needed here.
function matchNamedEntity(s, i) {
  let j = i + 1;
  const c0 = s.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return 0;
  j++;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) j++;
    else break;
  }
  if (s[j] !== ';') return 0;
  return j + 1 - i;
}

// Length of a numeric entity reference '&#...;' starting at s[i], or 0.
// Used by escapeAttr: the reference is kept verbatim whatever its value.
function matchNumericEntity(s, i) {
  if (s.charCodeAt(i + 1) !== 35) return 0;
  let j = i + 2;
  let hex = false;
  if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
  const start = j;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (hex ? (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)
            : (c >= 48 && c <= 57)) j++;
    else break;
  }
  if (j === start || s[j] !== ';') return 0;
  return j + 1 - i;
}

// Try to read a numeric entity reference at s[i] === '&'.
// Returns [decodedChar, nextIndex] when the value is usable, else null.
// 0 and surrogates decode to U+FFFD; values above U+10FFFF are invalid
// (the '&' is then escaped as ordinary text instead).
function readNumericEntity(s, i) {
  if (s.charCodeAt(i + 1) !== 35) return null;
  let j = i + 2;
  let hex = false;
  if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
  const start = j;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (hex ? (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)
            : (c >= 48 && c <= 57)) j++;
    else break;
  }
  if (j === start || s[j] !== ';') return null;
  const cp = parseInt(s.slice(start, j), hex ? 16 : 10);
  if (cp > 0x10FFFF) return null;
  if (!cp || (cp >= 0xD800 && cp <= 0xDFFF)) return ['�', j + 1];
  return [String.fromCodePoint(cp), j + 1];
}

// Decode backslash escapes in a link destination, title or reference
// label. A backslash before ASCII punctuation yields the punctuation;
// otherwise the backslash stays. Entity references are NOT decoded here:
// marked keeps them verbatim in destinations, titles and labels.
function decodeBackslash(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) {
      out += s.slice(last, i) + s[i + 1];
      i++;
      last = i + 1;
    }
  }
  return out + s.slice(last);
}

// ---------- indentation / tab helpers ----------

// Columns of leading whitespace (tab = next multiple of 4) and the index
// of the first non-space/tab character.
function lineIndent(line) {
  let cols = 0;
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { cols++; i++; }
    else if (c === 9) { cols += 4 - (cols % 4); i++; }
    else break;
  }
  return { cols, idx: i };
}

// Remove the first n columns of indentation from a line. A tab straddling
// the cut becomes spaces for the remainder. A line with embedded
// newlines (from a merged lazy/continuation line) is stripped per segment.
function stripCols(line, n) {
  const nl = line.indexOf('\n');
  if (nl !== -1) return line.split('\n').map((seg) => stripCols(seg, n)).join('\n');
  let cols = 0;
  let i = 0;
  while (i < line.length && cols < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { cols++; i++; }
    else if (c === 9) {
      const w = 4 - (cols % 4);
      if (cols + w > n) return ' '.repeat(cols + w - n) + line.slice(i + 1);
      cols += w; i++;
    } else break;
  }
  return line.slice(i);
}

// Remove the first n columns of a line (any characters count one column
// each; a tab advances to the next multiple of four, a straddling tab
// becomes spaces for its remainder), then expand any tabs that remain in
// the leading whitespace to spaces, using their ORIGINAL column positions.
// This is how marked strips list markers and blockquote markers: a tab
// after the marker keeps its original width, so e.g. "-\t\tfoo" leaves a
// content line of six spaces before "foo".
// Strip up to n columns of leading whitespace from one segment, never
// consuming a non-whitespace character (used for the later segments of
// a merged line, which are continuation lines, not marker lines).
function stripColsExpandSeg(seg, n) {
  let col = 0;
  let i = 0;
  let out = '';
  let removed = 0;
  while (i < seg.length && removed < n) {
    const c = seg.charCodeAt(i);
    if (c === 32) { removed++; col++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (removed + w > n) { out += ' '.repeat(removed + w - n); removed = n; col += w; i++; break; }
      removed += w; col += w; i++;
    } else break;
  }
  while (i < seg.length) {
    const c = seg.charCodeAt(i);
    if (c === 32) { out += ' '; col++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w; i++;
    } else break;
  }
  return out + seg.slice(i);
}

function stripColsExpand(line, n) {
  const nl = line.indexOf('\n');
  if (nl !== -1) {
    const parts = line.split('\n');
    return parts.map((seg, k) => k === 0 ? stripColsExpand(seg, n) : stripColsExpandSeg(seg, n)).join('\n');
  }
  let col = 0; // original column of line[i]
  let i = 0;
  let out = '';
  let removed = 0; // columns removed so far
  while (i < line.length && removed < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { removed++; col++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (removed + w > n) { out += ' '.repeat(removed + w - n); removed = n; col += w; i++; break; }
      removed += w; col += w; i++;
    } else { removed++; col++; i++; }
  }
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { out += ' '; col++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w; i++;
    } else break;
  }
  return out + line.slice(i);
}

// Strip one blockquote marker ('>' plus one following space, or one
// column of a following tab) from a line, expanding remaining leading
// tabs to spaces by their original columns. Returns the content line.
function stripQuoteMarker(line) {
  // Only the first segment of a merged line is a quote line; later
  // segments are lazy/continuation lines without a marker.
  const nl = line.indexOf('\n');
  if (nl !== -1) {
    const parts = line.split('\n');
    return stripQuoteMarker(parts[0]) + '\n' + parts.slice(1).join('\n');
  }
  const ind = lineIndent(line);
  let j = ind.idx;
  let col = ind.cols;
  j++; col++; // the '>'
  let out = '';
  if (j < line.length) {
    if (line[j] === ' ') { j++; col++; }
    else if (line[j] === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w - 1);
      col += w; j++;
    }
  }
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c === 32) { out += ' '; col++; j++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w; j++;
    } else break;
  }
  return out + line.slice(j);
}

// Normalize a reference label: collapse whitespace, trim, lowercase.
function normalizeLabel(label) {
  // Backslash escapes are NOT decoded in labels ([foo\!] does not
  // match [foo!]); whitespace runs collapse to one space and the
  // label is trimmed; 'ß'/'ẞ' case-fold to 'ss' ([ẞ] matches [SS]).
  return label.replace(/[ \t\r\n]+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

// True if s contains an unescaped '[' (a label with one is invalid).
function hasUnescapedBracket(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '[') return true;
  }
  return false;
}

// A line is blank, except that a whitespace-only line that contains
// at least one space/tab, is the last line of the fed text, and is not
// newline-terminated is paragraph content (or html-block content), not
// a blank line: "foo\n " renders as <p>foo\n </p>, while "foo\n \n"
// drops the space line. A truly empty line ("") is always blank.
function isBlankLine(lines, idx, lastNL) {
  return lines[idx].trim() === '' && !(lines[idx].length > 0 && idx === lines.length - 1 && !lastNL);
}

// ---------- link destination / title parsing ----------

function skipWS(s, i) {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10) i++;
    else break;
  }
  return i;
}

// Find the ']' matching the '[' at s[start-1] (start is just after '[').
// Counts nested brackets; skips code spans, escaped characters, and
// html tags (a ']' inside a tag's quoted attribute value does not
// close the bracket: [foo <bar attr="](baz)"> is not a link).
// Returns the index of the matching ']' or -1.
function findClosingBracket(s, start) {
  let depth = 0;
  let i = start;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '<') {
      const a = matchAutolink(s, i);
      if (a) { i = a.end; continue; }
      const h = matchHtmlTag(s, i);
      if (h !== -1) { i = h; continue; }
    }
    if (c === '`') {
      let n = 0;
      while (i + n < s.length && s[i + n] === '`') n++;
      let j = i + n;
      let found = -1;
      while (j < s.length) {
        if (s[j] === '`') {
          let m = 0;
          while (j + m < s.length && s[j + m] === '`') m++;
          if (m === n) { found = j; break; }
          j += m;
        } else j++;
      }
      i = found === -1 ? i + n : found + n;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      if (depth === 0) return i;
      depth--;
    }
    i++;
  }
  return -1;
}

// Parse a link title at s[i] ('"' / "'" / '('). Returns [title, next] or null.
function parseTitle(s, i) {
  const q = s[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    while (j < s.length) {
      if (s[j] === '\\') { j += 2; continue; }
      if (s[j] === q) return [s.slice(i + 1, j), j + 1];
      j++;
    }
    return null;
  }
  let depth = 1;
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return [s.slice(i + 1, j), j + 1];
    }
    j++;
  }
  return null;
}

// Parse a link destination at s[i]. Returns [dest, next] or null.
// '<...>' may contain spaces but no line ending or unescaped '<'.
// A bare destination stops at whitespace/control and keeps balanced parens.
function parseDest(s, i) {
  if (s[i] === '<') {
    let j = i + 1;
    while (j < s.length) {
      const c = s[j];
      if (c === '\n') return null;
      if (c === '\\') { j += 2; continue; }
      if (c === '<') return null;
      if (c === '>') return [s.slice(i + 1, j), j + 1];
      j++;
    }
    return null;
  }
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const c = s[j];
    const code = s.charCodeAt(j);
    if (code <= 32 || code === 127) break;
    if (c === '\\') { j += 2; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) break;
      depth--;
    }
    j++;
  }
  if (depth > 0) return null;
  return [s.slice(i, j), j];
}

// Parse "(dest title)" of an inline link. s[i] === '('.
// Returns {href, title, end} or null.
function parseInlineLink(s, i) {
  let p = skipWS(s, i + 1);
  let href = '';
  // The destination is always parsed first: a bare destination may
  // start with a quote or paren ("title" and (title) are destinations,
  // not titles). A title is only parsed after a destination.
  if (p < s.length && s[p] !== ')') {
    const d = parseDest(s, p);
    if (!d) return null;
    href = d[0];
    p = d[1];
    p = skipWS(s, p);
  }
  let title = null;
  if (p < s.length && (s[p] === '"' || s[p] === "'" || s[p] === '(')) {
    const t = parseTitle(s, p);
    if (!t) return null;
    title = t[0];
    p = t[1];
    p = skipWS(s, p);
  }
  if (s[p] !== ')') return null;
  return { href, title, end: p + 1 };
}

// Reject dangerous schemes (javascript:, vbscript:, data: except image
// data: for images) and percent-encode the href like encodeURI does.
function cleanUrl(href, isImage) {
  let prot = href;
  try { prot = decodeURIComponent(prot); } catch { /* keep raw */ }
  prot = prot.replace(/[^a-zA-Z0-9:]/g, '').toLowerCase();
  if (prot.startsWith('javascript:') || prot.startsWith('vbscript:')) return null;
  if (prot.startsWith('data:')) {
    if (!isImage) return null;
    if (!/^data:image\/(png|gif|jpe?g|webp|svg\+xml|bmp|avif)/i.test(href)) return null;
  }
  // marked keeps a bare "%" (and any %XX sequence) verbatim: encodeURI
  // encodes "%" to "%25", so turn those back into "%".
  try { return encodeURI(href).replace(/%25/g, '%'); } catch { return href; }
}

// ---------- autolinks and inline HTML ----------

const EMAIL_FULL = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

// <scheme:...> or <email>. Returns {href, text, end} or null.
function matchAutolink(s, i) {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '>') break;
    if (c === '<' || c === ' ' || c === '\n' || c === '\t' || s.charCodeAt(j) < 32) return null;
    j++;
  }
  if (j >= s.length || s[j] !== '>') return null;
  const inner = s.slice(i + 1, j);
  if (!inner) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(inner)) {
    const href = cleanUrl(inner, false);
    if (href === null) return null;
    return { href, text: inner, end: j + 1 };
  }
  if (EMAIL_FULL.test(inner)) return { href: 'mailto:' + inner, text: inner, end: j + 1 };
  return null;
}

// Match an inline HTML tag at s[i] === '<'. Returns the index just past
// the tag, or -1. Open tag, close tag, comment, processing instruction,
// declaration and CDATA section.
function matchHtmlTag(s, i) {
  // comment
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return i + 5;
    if (s.startsWith('<!--->', i)) return i + 6;
    const j = s.indexOf('-->', i + 4);
    return j === -1 ? -1 : j + 3;
  }
  // processing instruction
  if (s.startsWith('<?', i)) {
    const j = s.indexOf('?>', i + 2);
    return j === -1 ? -1 : j + 2;
  }
  // CDATA
  if (s.startsWith('<![CDATA[', i)) {
    const j = s.indexOf(']]>', i + 9);
    return j === -1 ? -1 : j + 3;
  }
  // declaration <!Letter ...>
  if (s.startsWith('<!', i)) {
    const c = s[i + 2];
    if (c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z') {
      const j = s.indexOf('>', i + 2);
      return j === -1 ? -1 : j + 1;
    }
    return -1;
  }
  // close tag </name ...>
  if (s[i + 1] === '/') {
    let j = i + 2;
    if (j >= s.length || !/[A-Za-z]/.test(s[j])) return -1;
    while (j < s.length && /[A-Za-z0-9-]/.test(s[j])) j++;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    return s[j] === '>' ? j + 1 : -1;
  }
  // open tag <name attrs? /?>
  let j = i + 1;
  if (j >= s.length || !/[A-Za-z]/.test(s[j])) return -1;
  while (j < s.length && /[A-Za-z0-9-]/.test(s[j])) j++;
  // After the tag name (and after an attribute value) there must be
  // whitespace, '>', or '/>'. A ':' or other char right after the
  // tag name (e.g. <m:abc>) is not a valid tag. After a valueless
  // attribute the whitespace was already skipped, so the next
  // attribute name may follow directly.
  let needWS = true;
  for (;;) {
    if (s[j] === '>') return j + 1;
    if (s[j] === '/' && s[j + 1] === '>') return j + 2;
    if (needWS) {
      if (s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n') return -1;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
      if (s[j] === '>') return j + 1;
      if (s[j] === '/' && s[j + 1] === '>') return j + 2;
    }
    if (j >= s.length) return -1;
    // attribute name
    if (!/[A-Za-z_:]/.test(s[j])) return -1;
    while (j < s.length && /[A-Za-z0-9_.:-]/.test(s[j])) j++;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (s[j] === '=') {
      needWS = true;
      j++;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
      if (s[j] === '"') {
        j = s.indexOf('"', j + 1);
        if (j === -1) return -1;
        j++;
      } else if (s[j] === "'") {
        j = s.indexOf("'", j + 1);
        if (j === -1) return -1;
        j++;
      } else {
        if (j >= s.length) return -1;
        while (j < s.length) {
          const c = s[j];
          if (c === ' ' || c === '\t' || c === '\n' || c === '"' || c === "'" ||
              c === '=' || c === '<' || c === '>' || c === '`') break;
          j++;
        }
        if (j >= s.length) return -1;
      }
    } else {
      // Valueless attribute; whitespace (if any) already skipped.
      needWS = false;
    }
  }
}

// Validate a domain: at least two labels, no label empty or starting /
// ending with '-', last label at least two letters.
function validDomain(domain) {
  if (!domain) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  for (let k = 0; k < labels.length; k++) {
    const lab = labels[k];
    if (!lab || !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(lab)) return false;
  }
  return /^[A-Za-z]{2,}$/.test(labels[labels.length - 1]);
}

// Email domains allow single-character labels (foo@bar.b is an email);
// URL domains require a >= 2-letter TLD (see validDomain).
function validEmailDomain(domain) {
  if (!domain) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  for (let k = 0; k < labels.length; k++) {
    const lab = labels[k];
    if (!lab || !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(lab)) return false;
  }
  return true;
}

// Parse a bare email starting at s[i] (local part). Returns the email
// text and end index, or null. A trailing '.' is not part of the email.
function matchEmailAt(s, i) {
  const c0 = s.charCodeAt(i);
  if (!((c0 >= 48 && c0 <= 57) || (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 46)) return null;
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
        '.!#$%&\'*+/=?^_`{|}~-'.indexOf(c) !== -1) j++;
    else break;
  }
  if (j === i || s[j] !== '@') return null;
  let k = j + 1;
  const dStart = k;
  while (k < s.length) {
    const c = s[k];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
        c === '-' || c === '.') k++;
    else break;
  }
  let dom = s.slice(dStart, k);
  while (dom.endsWith('.')) { dom = dom.slice(0, -1); k--; }
  if (!validEmailDomain(dom)) return null;
  // A '_' right after the domain would make this part of a longer
  // word (a.b-c_d@a.b_ is not an autolink); '.' is fine.
  if (s[k] === '_') return null;
  return { text: s.slice(i, k), end: k };
}

// GFM trailing-punctuation trimming for extended autolinks: drop trailing
// punctuation, unbalanced ')', and a ';' that is not part of an entity.
function trimAutolink(u) {
  for (;;) {
    let cut = u.length;
    // GFM trailing punctuation only: "[]{}" are NOT trimmed (a URL
    // ending in "]" keeps it, encoded as %5D; oracle t9/t10). A ")"
    // is trimmed below only when unbalanced.
    while (cut > 0 && '?!. ,:*_~\'"'.includes(u[cut - 1])) cut--;
    let open = 0, close = 0;
    for (let k = 0; k < cut; k++) {
      if (u[k] === '(') open++;
      else if (u[k] === ')') close++;
    }
    while (cut > 0 && u[cut - 1] === ')' && close > open) { cut--; close--; }
    if (cut > 0 && u[cut - 1] === ';') {
      // A trailing "&name;" that is not a valid entity is excluded
      // from the autolink entirely (not just its ';').
      const m = /&([A-Za-z0-9]+);$/.exec(u.slice(0, cut));
      if (m && ENT[m[1]] === undefined) cut = u.lastIndexOf('&', cut - 1);
      else if (!m) cut--;
    }
    if (cut === u.length) return u;
    u = u.slice(0, cut);
    if (!u) return u;
  }
}

// Extended autolink: www. / scheme:// / email at s[i].
// Returns {href, text, end} or null. Suppressed while inside an
// <a>...</a> element (see suppressExtAutolink).
function matchExtended(s, i) {
  if (suppressExtAutolink) return null;
  let isWww = false;
  let start = -1;
  if (s.startsWith('www.', i)) { start = i; isWww = true; }
  else {
    const c0 = s.charCodeAt(i);
    if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
      const head = s.slice(i, i + 40);
      const m = /^(https?|ftp):\/\//i.exec(head);
      if (m) start = i;
    }
  }
  if (start !== -1) {
    let j = start;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || c === 60 || c === 62 || c < 32) break;
      j++;
    }
    let u = trimAutolink(s.slice(start, j));
    if (!u) return null;
    // The domain starts after "://" for a scheme URL, at 0 for www.
    // It ends at the first character that cannot be in a domain
    // ("/", "?", "#", or any punctuation such as ")", "]", "(" --
    // otherwise a following "(https://..." would be swallowed into
    // the domain and validDomain would reject the whole autolink).
    let dStart = 0;
    if (!isWww) dStart = u.indexOf('://') + 3;
    let dEnd = u.length;
    for (let k = dStart; k < u.length; k++) {
      const c = u[k];
      if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c === '-' || c === '.' || c === ':')) {
        dEnd = k; break;
      }
    }
    let domain = u.slice(dStart, dEnd);
    const ci = domain.indexOf(':');
    if (ci !== -1) domain = domain.slice(0, ci);
    if (!validDomain(domain)) return null;
    const href = isWww ? 'http://' + u : u;
    let enc;
    try { enc = encodeURI(href).replace(/%25/g, '%'); } catch { enc = href; }
    return { href: enc, text: u, end: start + u.length };
  }
  // mailto: / xmpp: prefixed email (lowercase only). xmpp: takes one
  // path segment (/txt); mailto: takes none. Other schemes do not
  // prefix an email (foo:bar@baz.qux links only the email part).
  for (const scheme of ['mailto:', 'xmpp:']) {
    if (s.startsWith(scheme, i)) {
      const e = matchEmailAt(s, i + scheme.length);
      if (!e) return null;
      let end = e.end;
      if (scheme === 'xmpp:' && s[end] === '/') {
        let k = end + 1;
        while (k < s.length) {
          const c = s[k];
          if (c === '/' || c === '?' || c === ' ' || c === '\t' || c === '\n' || c === '<' || c === '>') break;
          const code = s.charCodeAt(k);
          if (code < 32) break;
          k++;
        }
        if (k > end + 1) end = k;
      }
      const text = s.slice(i, end);
      return { href: text, text, end };
    }
  }
  // bare email: local part starts at i (alphanumeric or '.')
  const e = matchEmailAt(s, i);
  if (!e) return null;
  return { href: 'mailto:' + e.text, text: e.text, end: e.end };
}

// ---------- inline scanner ----------
// Atoms: 0 text (escaped) | 1 code (escaped) | 2 raw html | 3 delimiter
// | 4 hard break | 5 link open | 6 link close | 7 image | 8 em open
// | 9 em close. Hard breaks are detected at '\n' from the raw
// trailing chars (2+ spaces, or an odd run of backslashes).

const LOCAL_PART_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?^_`{|}~-";

function isLocalPartCh(ch) {
  return ch !== undefined && LOCAL_PART_CHARS.indexOf(ch) !== -1;
}

// Try to parse a link or image starting at the '[' at s[i].
// Returns {end, open, children} for a link, {end, atom} for an image, or null.
function tryLink(s, i, refs, isImage) {
  const close = findClosingBracket(s, i + 1);
  if (close === -1) return null;
  const text = s.slice(i + 1, close);
  const after = close + 1;
  let href = null;
  let title = null;
  let end = -1;
  if (s[after] === '(') {
    const r = parseInlineLink(s, after);
    if (r) {
      href = r.href;
      title = r.title;
      end = r.end;
    } else {
      // Not a valid inline link: fall back to a shortcut reference
      // ([foo](not a link) with [foo]: /url1 links "foo").
      const key = normalizeLabel(text);
      if (!key) return null;
      const ref = refs.get(key);
      if (!ref) return null;
      href = ref.href;
      title = ref.title;
      end = after;
    }
  } else if (s[after] === '[') {
    const close2 = findClosingBracket(s, after + 1);
    if (close2 === -1) return null;
    const labelRaw = s.slice(after + 1, close2);
    const key = normalizeLabel(labelRaw === '' ? text : labelRaw);
    if (!key) return null;
    const ref = refs.get(key);
    if (!ref) return null;
    href = ref.href;
    title = ref.title;
    end = close2 + 1;
  } else {
    const key = normalizeLabel(text);
    if (!key) return null;
    const ref = refs.get(key);
    if (!ref) return null;
    href = ref.href;
    title = ref.title;
    end = after;
  }
  const clean = cleanUrl(decodeBackslash(href), isImage);
  if (clean === null) return null;
  const decTitle = title === null ? null : decodeBackslash(title);
  // Link text may not itself contain a (bracket) link. An image's alt
  // text may contain a link (it is stripped for the alt attribute).
  // An extended autolink (www./scheme/email) inside link text is plain
  // text: it neither rejects the outer link nor renders as a link, so
  // its open/close atoms are dropped and only its text is kept. An
  // angle-bracket autolink keeps its atoms (it renders nested) and does
  // not reject the outer link either.
  const rawChildren = scanInline(text, refs, '[', ']');
  const children = [];
  for (const a of rawChildren) {
    if ((a.t === 5 || a.t === 6) && a.auto === true) continue;
    children.push(a);
  }
  if (!isImage) {
    for (const a of children) if (a.t === 5 && !a.auto) return null;
  }
  if (isImage) return { end, atom: { t: 7, src: clean, altAtoms: children, title: decTitle } };
  return { end, open: { t: 5, href: clean, title: decTitle }, children };
}

function scanInline(s, refs, prevCh, nextCh) {
  const atoms = [];
  let text = '';
  const flush = () => {
    if (text) { atoms.push({ t: 0, s: escapeHtml(text) }); text = ''; }
  };
  const n = s.length;
  let i = 0;
  // After a hard break, the newline and the next line's leading spaces
  // and tabs are consumed by the break.
  let afterBreak = false;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 10) {
      if (afterBreak) { i++; continue; }
      // Hard break? Look back in the raw string at this line's
      // trailing chars: 2+ spaces, or (with no trailing spaces) an
      // odd run of backslashes. The raw count is used because escape
      // processing collapses backslash pairs in the text buffer.
      // But when the text buffer is empty, the chars before the
      // newline belong to a preceding atom (e.g. an autolink whose
      // URL ends in "\"), not to literal text, so they cannot make
      // a hard break.
      if (text === '') { text += '\n'; i++; continue; }
      let j = i - 1, sp = 0;
      while (j >= 0 && s.charCodeAt(j) === 32) { sp++; j--; }
      let hard = sp >= 2;
      if (!hard) {
        let bs = 0;
        while (j >= 0 && s.charCodeAt(j) === 92) { bs++; j--; }
        hard = bs % 2 === 1;
      }
      if (hard) {
        // Strip the hard-break markers from the accumulated text.
        if (sp >= 2) {
          let k = 0;
          while (k < text.length && text.charCodeAt(text.length - 1 - k) === 32) k++;
          text = text.slice(0, text.length - k);
        } else if (text.charCodeAt(text.length - 1) === 92) {
          text = text.slice(0, -1);
        }
        flush(); atoms.push({ t: 4 }); afterBreak = true; i++; continue;
      }
      text += '\n'; i++; continue;
    }
    if (afterBreak && (c === 32 || c === 9)) { i++; continue; }
    afterBreak = false;
    if (c === 92) {
      if (i + 1 < n && isAsciiPunct(s[i + 1])) { text += s[i + 1]; i += 2; continue; }
      text += '\\'; i++; continue;
    }
    if (c === 96) {
      let run = 0;
      while (i + run < n && s.charCodeAt(i + run) === 96) run++;
      let j = i + run;
      let close = -1;
      while (j < n) {
        if (s.charCodeAt(j) === 96) {
          let m = 0;
          while (j + m < n && s.charCodeAt(j + m) === 96) m++;
          if (m === run) { close = j; break; }
          j += m;
        } else j++;
      }
      if (close === -1) { text += s.slice(i, i + run); i += run; continue; }
      let content = s.slice(i + run, close).replace(/\n/g, ' ');
      if (content.length > 1 && content[0] === ' ' && content[content.length - 1] === ' ' &&
          !/^ +$/.test(content)) content = content.slice(1, -1);
      flush();
      atoms.push({ t: 1, s: escapeHtml(content) });
      i = close + run;
      continue;
    }
    if (c === 42 || c === 95 || c === 126) {
      const ch = s[i];
      let run = 0;
      while (i + run < n && s[i + run] === ch) run++;
      // A tilde run of 3+ is never a strikethrough delimiter; a run
      // of 1 or 2 is (a single "~x~" is a <del> in marked's GFM).
      if (ch === '~' && run >= 3) { text += s.slice(i, i + run); i += run; continue; }
      const prev = i === 0 ? prevCh : s[i - 1];
      const next = i + run >= n ? nextCh : s[i + run];
      const prevSpace = isSpaceCh(prev);
      const nextSpace = isSpaceCh(next);
      const prevPunct = isPunctCh(prev);
      const nextPunct = isPunctCh(next);
      const leftFlank = !nextSpace && (!nextPunct || prevSpace || prevPunct);
      const rightFlank = !prevSpace && (!prevPunct || nextSpace || nextPunct);
      let canOpen;
      let canClose;
      if (ch === '_') {
        canOpen = leftFlank && (!rightFlank || prevSpace || prevPunct);
        canClose = rightFlank && (!leftFlank || nextSpace || nextPunct);
      } else {
        canOpen = leftFlank;
        canClose = rightFlank;
      }
      flush();
      atoms.push({ t: 3, ch, len: run, origLen: run, canOpen, canClose });
      i += run;
      continue;
    }
    if (c === 33 && s[i + 1] === '[') {
      const link = tryLink(s, i + 1, refs, true);
      if (link) { flush(); atoms.push(link.atom); i = link.end; continue; }
      text += '!'; i++; continue;
    }
    if (c === 91) {
      const link = tryLink(s, i, refs, false);
      if (link) {
        flush();
        atoms.push(link.open);
        for (const a of link.children) atoms.push(a);
        atoms.push({ t: 6 });
        i = link.end;
        continue;
      }
      text += '['; i++; continue;
    }
    if (c === 60) {
      const a = matchAutolink(s, i);
      if (a) {
        flush();
        // An angle-bracket autolink inside link text still renders as
        // a (nested) link and does not reject the outer link.
        atoms.push({ t: 5, href: a.href, title: null, auto: 'angle' });
        atoms.push({ t: 0, s: escapeHtml(a.text) });
        atoms.push({ t: 6, auto: 'angle' });
        i = a.end;
        continue;
      }
      const h = matchHtmlTag(s, i);
      if (h !== -1) {
        flush();
        const tagText = s.slice(i, h);
        atoms.push({ t: 2, s: tagText });
        if (isAnchorOpen(tagText)) suppressExtAutolink = true;
        else if (isAnchorClose(tagText)) suppressExtAutolink = false;
        i = h;
        continue;
      }
      text += '<'; i++; continue;
    }
    if (c === 38) {
      // Named reference (&name;): kept verbatim as a raw atom.
      const nl = matchNamedEntity(s, i);
      if (nl) { flush(); atoms.push({ t: 10, s: s.slice(i, i + nl) }); i += nl; continue; }
      // Numeric reference: decoded when valid, else '&' is ordinary text.
      const e = readNumericEntity(s, i);
      if (e) { text += e[0]; i = e[1]; continue; }
      text += '&'; i++; continue;
    }
    if (c === 119 && s.startsWith('www.', i)) {
      const a = matchExtended(s, i);
      if (a) {
        flush();
        atoms.push({ t: 5, href: a.href, title: null, auto: true });
        atoms.push({ t: 0, s: escapeHtml(a.text) });
        atoms.push({ t: 6, auto: true });
        i = a.end;
        continue;
      }
    } else if (c === 104 || c === 102) {
      const a = matchExtended(s, i);
      if (a) {
        flush();
        atoms.push({ t: 5, href: a.href, title: null, auto: true });
        atoms.push({ t: 0, s: escapeHtml(a.text) });
        atoms.push({ t: 6, auto: true });
        i = a.end;
        continue;
      }
    }
    if (isLocalPartCh(s[i]) && (i === 0 || !isLocalPartCh(i === 0 ? prevCh : s[i - 1]))) {
      const a = matchExtended(s, i);
      if (a) {
        flush();
        atoms.push({ t: 5, href: a.href, title: null, auto: true });
        atoms.push({ t: 0, s: escapeHtml(a.text) });
        atoms.push({ t: 6, auto: true });
        i = a.end;
        continue;
      }
    }
    text += s[i];
    i++;
  }
  flush();
  return atoms;
}

// ---------- emphasis resolution ----------

// CommonMark delimiter-stack algorithm over the flat atom list. A link
// whose markers would straddle an emphasis boundary is split at the
// boundary, so the emphasis wraps or sits inside the link as the spec does.
function resolveEmphasis(atoms) {
  const delims = [];
  for (let k = 0; k < atoms.length; k++) if (atoms[k].t === 3) delims.push(atoms[k]);
  for (let di = 0; di < delims.length; di++) {
    const c = delims[di];
    if (c.len === 0 || !c.canClose) continue;
    let dj = di - 1;
    while (dj >= 0) {
      const o = delims[dj];
      if (o.len === 0 || !o.canOpen || o.ch !== c.ch) { dj--; continue; }
      // Odd-match rule: if either delimiter can both open and close,
      // the sum of the lengths must not be a multiple of 3 unless
      // both lengths are multiples of 3. A delimiter of the same
      // character between the opener and the closer that can both open
      // and close also triggers the rule (e.g. in "**a *b*c* d**" the
      // closing "*" of "*b*" blocks the later "*" from matching the
      // opening "**", while in "**a *b* c* d**" it does not).
      let oddApplies = (o.canOpen && o.canClose) || (c.canOpen && c.canClose);
      if (!oddApplies && c.len <= o.len) {
        for (let dk = dj + 1; dk < di; dk++) {
          const mid = delims[dk];
          if (mid.ch === c.ch && mid.canOpen && mid.canClose) { oddApplies = true; break; }
        }
      }
      if (oddApplies) {
        const sum = o.len + c.len;
        if (sum % 3 === 0 && !(o.len % 3 === 0 && c.len % 3 === 0)) { dj--; continue; }
      }
      // An inner emphasis formed by a "both" closer whose opener
      // could only open, and longer than this pair would use, blocks
      // the match: "*a **b**c*" stays literal (the "**b**" blocks the
      // outer "*...*"), while "*foo**bar**baz*" forms the outer
      // "<em>" (there the "**" opener can also close) and
      // "*changes *else*returns**" forms it (the inner "*else*" is
      // no longer than the outer pair would use).
      {
        const outerUse = Math.min(o.len, c.len);
        let blockedByInner = false;
        for (let dk = dj + 1; dk < di; dk++) {
          const mid = delims[dk];
          if (mid.ch !== c.ch || !mid.canOpen || !mid.canClose) continue;
          if (mid.innerLen === undefined || mid.partnerBoth) continue;
          if (mid.innerLen > outerUse) { blockedByInner = true; break; }
        }
        if (blockedByInner) { dj--; continue; }
      }
      // A strikethrough pair needs equal run lengths (1 or 2).
      if (c.ch === '~' && o.len !== c.len) { dj--; continue; }
      const oi = atoms.indexOf(o);
      const ci0 = atoms.indexOf(c);
      // A span may not partially overlap a link or an already-formed
      // emphasis: the link/emphasis depth between opener and closer
      // must stay >= 0 and end at 0 (a link or emphasis fully inside
      // the span is fine; one that starts inside and ends outside,
      // or vice versa, blocks the match).
      let ldepth = 0, edepth = 0, blocked = false;
      for (let k = oi + 1; k < ci0; k++) {
        const a = atoms[k];
        if (a.t === 5) ldepth++;
        else if (a.t === 6) ldepth--;
        else if (a.t === 8) edepth++;
        else if (a.t === 9) edepth--;
        if (ldepth < 0 || edepth < 0) { blocked = true; break; }
      }
      if (blocked || ldepth !== 0 || edepth !== 0) { dj--; continue; }
      const use = (o.len >= 2 && c.len >= 2) ? 2 : 1;
      const tag = c.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
      o.len -= use;
      c.len -= use;
      // Remember how this closer was used, so a later outer pair can
      // tell whether the inner emphasis blocks it (oracle50, doc-03,
      // doc-07): the closer's inner length and whether its opener
      // could also close.
      if (c.innerLen === undefined) {
        c.innerLen = use;
        c.partnerBoth = !!(o.canOpen && o.canClose);
      }
      // A link close between oi and ci whose open is before oi, and a link
      // open between oi and ci whose close is after ci, straddle the span.
      let closeAfter = null;
      let depth = 0;
      for (let k = oi + 1; k < ci0; k++) {
        const a = atoms[k];
        if (a.t === 5) depth++;
        else if (a.t === 6) {
          if (depth === 0) closeAfter = a;
          else depth--;
        }
      }
      let openBefore = null;
      depth = 0;
      for (let k = ci0 - 1; k > oi; k--) {
        const a = atoms[k];
        if (a.t === 6) depth++;
        else if (a.t === 5) {
          if (depth === 0) { openBefore = a; break; }
          else depth--;
        }
      }
      let closeBefore = null;
      if (openBefore) {
        depth = 0;
        for (let k = ci0 + 1; k < atoms.length; k++) {
          const a = atoms[k];
          if (a.t === 5) depth++;
          else if (a.t === 6) {
            if (depth === 0) { closeBefore = a; break; }
            else depth--;
          }
        }
      }
      const emOpen = { t: 8, tag };
      const emClose = { t: 9, tag };
      if (closeBefore) atoms.splice(atoms.indexOf(closeBefore), 1);
      if (closeAfter) atoms.splice(atoms.indexOf(closeAfter), 1);
      const ci = atoms.indexOf(c);
      atoms.splice(ci, 0, emClose);
      if (closeBefore) atoms.splice(atoms.indexOf(emClose), 0, closeBefore);
      if (closeAfter) atoms.splice(atoms.indexOf(emClose) + 1, 0, closeAfter);
      atoms.splice(atoms.indexOf(o) + 1, 0, emOpen);
      if (c.len === 0) break;
      if (o.len > 0) continue;
      dj--;
    }
  }
}

// Plain-text rendering of atoms (for image alt text): markup stripped,
// text and code kept, nested images contribute their own alt text.
function plainText(atoms) {
  let out = '';
  for (const a of atoms) {
    if (a.t === 0 || a.t === 1 || a.t === 10) out += a.s;
    else if (a.t === 3) { if (a.len > 0) out += a.ch.repeat(a.len); }
    else if (a.t === 7) { resolveEmphasis(a.altAtoms); out += plainText(a.altAtoms); }
  }
  return out;
}

function renderInline(atoms) {
  let out = '';
  for (const a of atoms) {
    switch (a.t) {
      case 0: out += a.s; break;
      case 1: out += '<code>' + a.s + '</code>'; break;
      case 2: out += a.s; break;
      case 3: if (a.len > 0) out += a.ch.repeat(a.len); break;
      case 4: out += '<br>'; break;
      case 5:
        out += '<a href="' + escapeAttr(a.href) + '"' +
          (a.title !== null ? ' title="' + escapeAttr(a.title) + '"' : '') + '>';
        break;
      case 6: out += '</a>'; break;
      case 7: {
        // Resolve emphasis in the alt text first so its markers are
        // stripped by plainText (foo *bar* -> "foo bar").
        resolveEmphasis(a.altAtoms);
        const alt = plainText(a.altAtoms);
        out += '<img src="' + escapeAttr(a.src) + '" alt="' + alt + '"' +
          (a.title !== null ? ' title="' + escapeAttr(a.title) + '"' : '') + '>';
        break;
      }
      case 8: out += '<' + a.tag + '>'; break;
      case 9: out += '</' + a.tag + '>'; break;
      case 10: out += a.s; break;
    }
  }
  return out;
}

// Render one inline string (paragraph, heading, table cell, ...) to HTML.
function parseInline(s, refs) {
  if (s === '') return '';
  const atoms = scanInline(s, refs, '\n', '\n');
  resolveEmphasis(atoms);
  return renderInline(atoms);
}

// ---------- block parser ----------

// Join paragraph / heading lines for inline parsing. Nothing is
// stripped here: hard breaks are detected by the inline scanner at
// each '\n' from the raw trailing chars, so code spans and html tag
// attributes keep their original spaces and newlines.
function joinLines(lines) {
  // Split each line on embedded '\n' (from merged lazy/continuation
  // lines) so every segment is its own line, then join with '\n'.
  const segs = [];
  for (const line of lines) {
    const parts = line.split('\n');
    for (const p of parts) segs.push(p);
  }
  return segs.join('\n');
}

function isHr(rest) {
  return /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(rest);
}

// ATX heading: rest is the line after its indentation was stripped.
// Returns {level, content} or null.
function matchAtx(rest) {
  if (rest.charCodeAt(0) !== 35) return null;
  let n = 0;
  while (rest[n] === '#') n++;
  if (n > 6) return null;
  if (rest[n] !== undefined && rest[n] !== ' ' && rest[n] !== '\t') return null;
  // The closing sequence is stripped first: the space before it may be
  // the separator space itself ("### ###" has empty content).
  let content = rest.slice(n).replace(/ +#+[ \t]*$/, '');
  content = content.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return { level: n, content };
}

// Fence start: rest after indent strip, indent <= 3. Returns the fence
// character and run length, or null.
function fenceStart(rest) {
  const ch = rest[0];
  if (ch !== '`' && ch !== '~') return null;
  let n = 0;
  while (rest[n] === ch) n++;
  if (n < 3) return null;
  return { ch, n };
}

function parseFence(lines, i) {
  const { cols, idx } = lineIndent(lines[i]);
  const rest = lines[i].slice(idx);
  const f = fenceStart(rest);
  const infoRaw = rest.slice(f.n);
  if (f.ch === '`' && infoRaw.indexOf('`') !== -1) return null;
  const info = infoRaw.trim();
  // Backslash escapes in the info string are decoded; entity references
  // are kept verbatim.
  const lang = info ? decodeBackslash(info.split(/[ \t]+/)[0]) : '';
  const content = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j];
    const ind = lineIndent(l);
    const r2 = l.slice(ind.idx);
    if (ind.cols <= 3 && r2[0] === f.ch) {
      let m = 0;
      while (r2[m] === f.ch) m++;
      if (m >= f.n && r2.slice(m).trim() === '') { j++; break; }
    }
    content.push(stripCols(l, cols));
    j++;
  }
  // One trailing blank line in a fenced code block's content is dropped
  // ("code\n\n" renders as "code\n", "code\n\n\n" as "code\n\n").
  if (content.length && content[content.length - 1] === '') content.pop();
  return {
    node: { t: 'fence', lang, text: content.join('\n') + (content.length ? '\n' : ''), start: i, end: j - 1 },
    next: j,
  };
}

function parseIndentedCode(lines, i) {
  const content = [];
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    if (line.trim() === '') {
      let k = j + 1;
      while (k < lines.length && lines[k].trim() === '') k++;
      if (k < lines.length && lineIndent(lines[k]).cols >= 4) {
        // A blank line inside indented code keeps its content after the
        // four-column strip ("      " becomes "  ").
        while (j < k) { content.push(stripCols(lines[j], 4)); j++; }
        continue;
      }
      break;
    }
    if (lineIndent(line).cols < 4) break;
    content.push(stripCols(line, 4));
    j++;
  }
  while (content.length && content[content.length - 1].trim() === '') content.pop();
  return {
    node: { t: 'code', text: content.join('\n') + (content.length ? '\n' : ''), start: i, end: j - 1 },
    next: j,
  };
}

// Try to parse a link reference definition starting at lines[j].
// Returns {next} (index of the first line after the definition) or null.
// A definition may span lines for its destination and title, but never a
// blank line. The first definition of a label wins.
function tryRefDef(lines, j, ctx) {
  const ind = lineIndent(lines[j]);
  if (ind.cols > 3 || lines[j][ind.idx] !== '[') return null;
  const take = Math.min(lines.length - j, 8);
  const virt = lines.slice(j, j + take).join('\n');
  let p = ind.idx;
  const close = findClosingBracket(virt, p + 1);
  if (close === -1) return null;
  const labelRaw = virt.slice(p + 1, close);
  if (!labelRaw || labelRaw.length > 999 || labelRaw.indexOf('\n\n') !== -1) return null;
  // A label with an unescaped '[' is invalid, as is a label that
  // normalizes to empty (whitespace only).
  if (hasUnescapedBracket(labelRaw) || normalizeLabel(labelRaw) === '') return null;
  let q = close + 1;
  if (virt[q] !== ':') return null;
  q++;
  let nl = 0;
  while (q < virt.length) {
    const c = virt[q];
    if (c === ' ' || c === '\t') q++;
    else if (c === '\n') { nl++; if (nl >= 2) return null; q++; }
    else break;
  }
  if (q >= virt.length) return null;
  const d = parseDest(virt, q);
  // An empty angle destination (<>) is valid; an empty bare one is not.
  if (!d || (d[0] === '' && virt[q] !== '<')) return null;
  const dest = d[0];
  q = d[1];
  // End of the destination's line: used to backtrack when a title on a
  // following line turns out invalid (the definition keeps the dest).
  let destLineEnd = virt.indexOf('\n', q);
  if (destLineEnd === -1) destLineEnd = virt.length;
  let title = null;
  let q2 = q;
  let nl2 = 0;
  let sawWS = false;
  let titleOnNextLine = false;
  while (q2 < virt.length) {
    const c = virt[q2];
    if (c === ' ' || c === '\t') { sawWS = true; q2++; }
    else if (c === '\n') { nl2++; if (nl2 >= 2) break; sawWS = true; titleOnNextLine = true; q2++; }
    else break;
  }
  // A title must be separated from the destination by whitespace.
  if (sawWS && q2 < virt.length && (virt[q2] === '"' || virt[q2] === "'" || virt[q2] === '(')) {
    const t = parseTitle(virt, q2);
    if (t) {
      let r = t[1];
      while (r < virt.length && (virt[r] === ' ' || virt[r] === '\t')) r++;
      if (r >= virt.length || virt[r] === '\n') {
        title = t[0];
        q = t[1];
      } else if (titleOnNextLine) {
        q = destLineEnd; // junk after the title: drop the title
      } else {
        return null; // junk on the destination's line: invalid definition
      }
    } else if (titleOnNextLine) {
      q = destLineEnd; // unparseable title on its own line: drop it
    } else {
      return null;
    }
  }
  let r = q;
  while (r < virt.length && (virt[r] === ' ' || virt[r] === '\t')) r++;
  if (r < virt.length && virt[r] !== '\n') return null;
  const consumed = virt.slice(0, r).split('\n').length;
  // A definition may never span a blank line.
  for (let k = j; k < j + consumed && k < lines.length; k++) {
    if (lines[k].trim() === '') return null;
  }
  const key = normalizeLabel(labelRaw);
  if (!ctx.refs.has(key)) {
    ctx.refs.set(key, { href: decodeBackslash(dest), title: title === null ? null : decodeBackslash(title) });
  }
  return { next: j + consumed };
}

// ---------- HTML blocks ----------

const BLOCK_TAGS = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul'.split(' '));

// HTML block type (1-7) starting at this line, or 0.
function htmlBlockType(line) {
  const ind = lineIndent(line);
  if (ind.cols > 3) return 0;
  const rest = line.slice(ind.idx);
  if (rest.charCodeAt(0) !== 60) return 0;
  if (/^<(script|pre|style|textarea)([ \t>]|\/>|$)/i.test(rest)) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (rest.startsWith('<![CDATA[')) return 5;
  if (rest.startsWith('<!')) {
    const c = rest.charCodeAt(2);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return 4;
    return 0;
  }
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) {
    const after = rest[m6[0].length];
    if (after === undefined || after === ' ' || after === '\t' || after === '>') return 6;
    if (after === '/' && rest[m6[0].length + 1] === '>' && rest[1] !== '/') return 6;
    return 0;
  }
  const h = matchHtmlTag(rest, 0);
  // Type 7 needs a complete tag on a single source line. A line with
  // an embedded newline is a merged lazy/continuation line, so a tag
  // spanning it is inline HTML in a paragraph, not an HTML block.
  if (h !== -1 && rest.slice(h).trim() === '' && rest.slice(0, h).indexOf('\n') === -1) return 7;
  return 0;
}

function parseHtmlBlock(lines, i, ctx, lastNL) {
  const type = htmlBlockType(lines[i]);
  let j = i;
  if (type === 1) {
    const tag = /^<(script|pre|style|textarea)/i.exec(lines[i])[1].toLowerCase();
    const closeRe = new RegExp('</' + tag + '[ \\t]*>', 'i');
    while (j < lines.length) {
      if (closeRe.test(lines[j])) { j++; break; }
      j++;
    }
  } else if (type === 2) {
    while (j < lines.length) {
      if (lines[j].indexOf('-->') !== -1) { j++; break; }
      j++;
    }
  } else if (type === 3) {
    while (j < lines.length) {
      if (lines[j].indexOf('?>') !== -1) { j++; break; }
      j++;
    }
  } else if (type === 4) {
    while (j < lines.length) {
      if (lines[j].indexOf('>', 2) !== -1) { j++; break; }
      j++;
    }
  } else if (type === 5) {
    while (j < lines.length) {
      if (lines[j].indexOf(']]>') !== -1) { j++; break; }
      j++;
    }
  } else {
    while (j < lines.length && !isBlankLine(lines, j, lastNL)) j++;
  }
  // The block's raw text ends with a newline when the line right after
  // the block is not blank (types 1-5 end at a closing marker, so a
  // following paragraph keeps the newline). A blank line after the
  // block swallows the newline. When the block is the last one in its
  // container, the newline is there only if the container's fed text
  // ends with one: true at the top level when the source does, false
  // inside a quote or list item (their fed text is lines joined by \n).
  const addNL = j < lines.length ? lines[j].trim() !== '' : lastNL;
  return {
    node: { t: 'html', lines: lines.slice(i, j), addNL, start: i, end: j - 1 },
    next: j,
  };
}

// Does this line start a block that interrupts a paragraph? Setext
// underlines and table delimiter rows are paragraph continuations, not
// block starts, so they are not listed here.
function isBlockStart(line) {
  const ind = lineIndent(line);
  if (ind.cols > 3) return false;
  const rest = line.slice(ind.idx);
  if (rest === '') return false;
  if (fenceOpen(rest)) return true;
  if (matchAtx(rest)) return true;
  if (isHr(rest)) return true;
  if (rest[0] === '>') return true;
  if (parseListMarker(line)) return true;
  const t = htmlBlockType(line);
  if (t >= 1 && t <= 6) return true;
  return false;
}

// A list marker at any indent (no indent <= 3 guard). Inside a list
// item a continuation line still carries its indent relative to the
// item's content, so a nested list marker can sit deeper than 3
// columns and still be a block start (e.g. "+ Method" at indent 5
// inside an item whose content indent is 5). ATX/fence/hr keep their
// indent cap in isBlockStart, so only list markers get this treatment.
function isListMarkerLoose(t) {
  const ind = lineIndent(t);
  const rest = t.slice(ind.idx);
  if (rest === '') return false;
  const c0 = rest.charCodeAt(0);
  if (c0 === 45 || c0 === 43 || c0 === 42) {
    if (rest.length === 1 || rest[1] === ' ' || rest[1] === '\t') return true;
  } else if (c0 >= 48 && c0 <= 57) {
    let k = 0;
    while (k < rest.length && rest.charCodeAt(k) >= 48 && rest.charCodeAt(k) <= 57) k++;
    if (k > 0 && k <= 9 && (rest[k] === '.' || rest[k] === ')') &&
        (k + 1 >= rest.length || rest[k + 1] === ' ' || rest[k + 1] === '\t')) return true;
  }
  return false;
}

// Like isBlockStart but without the indent <= 3 guard: a line that
// looks like a block start at any indent. Inside a list item a line's
// indent carries nesting information for a deeper parse, so such a line
// ends the open paragraph instead of continuing it.
function isBlockStartLoose(t) {
  const ind = lineIndent(t);
  const rest = t.slice(ind.idx);
  if (rest === '') return false;
  if (fenceOpen(rest)) return true;
  if (matchAtx(rest)) return true;
  if (isHr(rest)) return true;
  if (rest[0] === '>') return true;
  // A setext underline only counts at indent <= 3; deeper it is
  // paragraph text.
  if (ind.cols <= 3 && /^(=+|-+) *$/.test(rest)) return true;
  const c0 = rest.charCodeAt(0);
  if (c0 === 45 || c0 === 43 || c0 === 42) {
    if (rest.length === 1 || rest[1] === ' ' || rest[1] === '\t') return true;
  } else if (c0 >= 48 && c0 <= 57) {
    let k = 0;
    while (k < rest.length && rest.charCodeAt(k) >= 48 && rest.charCodeAt(k) <= 57) k++;
    if (k > 0 && k <= 9 && (rest[k] === '.' || rest[k] === ')') &&
        (k + 1 >= rest.length || rest[k + 1] === ' ' || rest[k + 1] === '\t')) return true;
  }
  if (htmlBlockType(rest) >= 1) return true;
  return false;
}

// A valid fenced-code opening (a ``` fence whose info contains a
// backtick is not a fence), or null. The indent is deliberately not
// capped at 3: a fence inside a nested container can sit deeper than 3
// columns relative to an outer list, and the outer list only needs to
// know a fence is open so its content lines are not stripped or merged.
function fenceOpen(t) {
  const ind = lineIndent(t);
  const f = fenceStart(t.slice(ind.idx));
  if (!f) return null;
  if (f.ch === '`' && t.slice(ind.idx + f.n).indexOf('`') !== -1) return null;
  return f;
}

// Does this line close the given open fence?
function fenceCloses(t, fence) {
  const ind = lineIndent(t);
  const r2 = t.slice(ind.idx);
  if (r2[0] !== fence.ch) return false;
  let m = 0;
  while (r2[m] === fence.ch) m++;
  return m >= fence.n && r2.slice(m).trim() === '';
}

// ---------- block quotes ----------

// After stripping '>', could this line still be paragraph text (so a
// following lazy line belongs to the quote)? Headings, fences, thematic
// breaks, setext underlines and HTML blocks end the paragraph.
function quoteLineInPara(stripped, prevInPara) {
  if (stripped.trim() === '') return false;
  const ind = lineIndent(stripped);
  // An indented line is paragraph text only when a paragraph is already
  // open (it continues it); otherwise it starts an indented code block,
  // so a following lazy line must not be swallowed into it.
  if (ind.cols > 3) return prevInPara;
  const rest = stripped.slice(ind.idx);
  if (/^(=+|-+) *$/.test(rest)) return false;
  if (fenceOpen(rest) || matchAtx(rest) || isHr(rest)) return false;
  if (htmlBlockType(stripped) >= 1) return false;
  return true;
}

function parseBlockquote(lines, i, ctx, lastNL) {
  const stripped = [];
  let j = i;
  let inPara = false;
  let fence = null;
  while (j < lines.length) {
    const line = lines[j];
    const ind = lineIndent(line);
    if (ind.cols <= 3 && line[ind.idx] === '>') {
      const rest = stripQuoteMarker(line);
      stripped.push({ t: rest, o: j });
      if (fence) {
        const r2 = rest.slice(lineIndent(rest).idx);
        if (lineIndent(rest).cols <= 3 && r2[0] === fence.ch) {
          let m = 0;
          while (r2[m] === fence.ch) m++;
          if (m >= fence.n && r2.slice(m).trim() === '') fence = null;
        }
        inPara = false;
      } else {
        const f = lineIndent(rest).cols <= 3 ? fenceStart(rest.slice(lineIndent(rest).idx)) : null;
        if (f && !(f.ch === '`' && rest.slice(lineIndent(rest).idx + f.n).indexOf('`') !== -1)) fence = f;
        inPara = quoteLineInPara(rest, inPara);
      }
      j++;
      continue;
    }
    if (line.trim() === '') break;
    if (inPara && !fence) {
      // A lazy continuation line is paragraph text only: a block start
      // (heading, fence, list, html, thematic break) ends the quote.
      // A setext underline cannot be lazy either: an hr line ends the
      // quote, while a setext-only line joins the paragraph as text,
      // indented four spaces so it cannot be read as an underline.
      const lind = lineIndent(line);
      const lrest = line.slice(lind.idx);
      if (lind.cols <= 3 && isHr(lrest)) break;
      if (lind.cols <= 3 && /^(=+|-+) *$/.test(lrest)) {
        // Merge into the previous line so the inner parse cannot read
        // it as an underline.
        stripped[stripped.length - 1].t += '\n' + '    ' + line;
        j++;
        continue;
      }
      if (isBlockStart(line)) break;
      // A lazy continuation line indented 4 or more columns is stripped
      // of four columns before joining the paragraph. Merge it into the
      // previous line so the inner parse cannot re-read it as a block
      // start (a stripped "- bar" is paragraph text, not a list).
      let t = line;
      if (lind.cols >= 4) t = stripCols(line, 4);
      stripped[stripped.length - 1].t += '\n' + t;
      j++;
      continue;
    }
    break;
  }
  const innerLines = stripped.map((x) => x.t);
  // A container's fed text is its lines joined by \n, so it never ends
  // with a newline: an html block that is the last block inside a quote
  // has no trailing newline.
  const children = parseBlocks(innerLines, ctx, false, false);
  return {
    node: { t: 'quote', children: children.blocks, start: i, end: j - 1 },
    next: j,
  };
}

// ---------- lists ----------

function parseListMarker(line) {
  const ind = lineIndent(line);
  if (ind.cols > 3) return null;
  const rest = line.slice(ind.idx);
  const c0 = rest.charCodeAt(0);
  let kind;
  let delim;
  let startNum = 0;
  let markerLen;
  if (c0 === 45 || c0 === 43 || c0 === 42) {
    kind = 'bullet';
    delim = rest[0];
    markerLen = 1;
  } else if (c0 >= 48 && c0 <= 57) {
    let j = 0;
    while (j < rest.length && rest.charCodeAt(j) >= 48 && rest.charCodeAt(j) <= 57) j++;
    if (j === 0 || j > 9) return null;
    const d = rest[j];
    if (d !== '.' && d !== ')') return null;
    kind = 'ordered';
    delim = d;
    markerLen = j + 1;
    startNum = parseInt(rest.slice(0, j), 10);
  } else return null;
  if (markerLen < rest.length && rest[markerLen] !== ' ' && rest[markerLen] !== '\t') return null;
  let k = markerLen;
  let col = ind.cols + markerLen;
  let wsCols = 0;
  while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) {
    if (rest[k] === ' ') { wsCols++; col++; k++; }
    else { const w = 4 - (col % 4); wsCols += w; col += w; k++; }
  }
  const hasContent = k < rest.length;
  let contentIndent;
  if (!hasContent) contentIndent = ind.cols + markerLen + 1;
  else if (wsCols >= 5) contentIndent = ind.cols + markerLen + 1;
  else contentIndent = ind.cols + markerLen + wsCols;
  return { kind, delim, startNum, indent: ind.cols, contentIndent, hasContent };
}

// True if the item's fed lines (so far) end with an open paragraph
// inside a nested container (blockquote or list), so a lazy line
// belongs to that paragraph rather than ending the list: in
// "> 1. > Blockquote" + "> continued here." the lazy line goes into
// the nested blockquote's paragraph.
function lastLineOpenPara(itemLines) {
  // A trailing blank line closes the paragraph: a lazy line after it
  // is a new block, not a continuation of the nested paragraph.
  if (itemLines.length === 0 || itemLines[itemLines.length - 1].t.trim() === '') return false;
  let k = itemLines.length - 1;
  while (k >= 0 && itemLines[k].t.trim() === '') k--;
  if (k < 0) return false;
  let seg = itemLines[k].t;
  const nl = seg.lastIndexOf('\n');
  if (nl !== -1) seg = seg.slice(nl + 1);
  for (;;) {
    const ind = lineIndent(seg);
    if (ind.cols > 3) return false;
    const rest = seg.slice(ind.idx);
    if (rest[0] === '>') { seg = stripQuoteMarker(seg); continue; }
    const m = parseListMarker(seg);
    if (m) { seg = stripColsExpand(seg, m.contentIndent); continue; }
    break;
  }
  if (seg.trim() === '') return false;
  const ind2 = lineIndent(seg);
  const r2 = seg.slice(ind2.idx);
  if (ind2.cols <= 3 && (fenceStart(r2) || matchAtx(r2) || isHr(r2) || htmlBlockType(seg) >= 1)) return false;
  if (/^(=+|-+) *$/.test(r2)) return false;
  return true;
}

function parseList(lines, i, ctx, lastNL) {
  const first = parseListMarker(lines[i]);
  const ordered = first.kind === 'ordered';
  const items = [];
  let j = i;
  let cur = { lines: [], start: i };
  let contentIndent = first.contentIndent;
  let inPara = false;
  // A fenced code block open inside the current item: its content lines
  // are not paragraph continuations (no strip-4, no merge) and its
  // closing fence must be a separate line.
  let fence = null;
  cur.lines.push({ t: stripColsExpand(lines[i], contentIndent), o: i });
  // A paragraph is open only when the item's first line is paragraph
  // text, not a block start (a fence, heading or nested list as the
  // item's content is a block, not a paragraph).
  inPara = cur.lines[0].t.trim() !== '' && !isBlockStartLoose(cur.lines[0].t);
  if (!inPara) fence = fenceOpen(cur.lines[0].t);
  let curHasContent = cur.lines[0].t.trim() !== '';
  j = i + 1;
  while (j < lines.length) {
    const line = lines[j];
    const ind = lineIndent(line);
    if (line.trim() === '') {
      // An empty item followed by a blank line ends the list, unless
      // the next non-blank line is another item of this list (then
      // the blank line belongs to the empty item and the list goes on,
      // loose). An indented line after the blank line becomes a new
      // block outside the list.
      if (!curHasContent) {
        let k = j + 1;
        while (k < lines.length && lines[k].trim() === '') k++;
        let more = false;
        if (k < lines.length) {
          const mm = parseListMarker(lines[k]);
          more = !!mm && mm.kind === (ordered ? 'ordered' : 'bullet') &&
            mm.delim === first.delim && mm.indent <= first.indent + 3;
        }
        if (!more) break;
      }
      cur.lines.push({ t: '', o: j });
      inPara = false;
      j++;
      continue;
    }
    if (ind.cols >= contentIndent) {
      let t = stripColsExpand(line, contentIndent);
      if (fence) {
        // Inside a fenced code block: content lines keep their indent
        // (no strip-4, no merge) and the closing fence ends the block.
        if (fenceCloses(t, fence)) fence = null;
        cur.lines.push({ t, o: j });
        if (t.trim() !== '') curHasContent = true;
        inPara = false;
        j++;
        continue;
      }
      // A fence opening at indent <= 3 always opens a fence (it
      // interrupts a paragraph); a deeper fence-like line only counts
      // when no paragraph is open (otherwise it is paragraph text).
      const tind0 = lineIndent(t);
      const fOpen = (tind0.cols <= 3 || !inPara) ? fenceOpen(t) : null;
      if (fOpen) {
        fence = fOpen;
        cur.lines.push({ t, o: j });
        if (t.trim() !== '') curHasContent = true;
        inPara = false;
        j++;
        continue;
      }
      // A paragraph continuation line is merged into the paragraph so
      // the inner parse cannot re-read it as a block start ("# head"
      // stays paragraph text, a "```" pair stays an inline code span).
      // A line that is a block start at indent <= 3 (a nested list
      // marker, a heading) is a new block instead. A continuation line
      // indented 4 or more columns (after the content indent) is
      // stripped of four columns before joining the paragraph.
      const tind = lineIndent(t);
      const setext = tind.cols <= 3 && /^(=+|-+) *$/.test(t.slice(tind.idx));
      let merged = false;
      if (inPara && !isBlockStart(t) && !isListMarkerLoose(t) && !setext) {
        if (lineIndent(t).cols >= 4) t = stripCols(t, 4);
        cur.lines[cur.lines.length - 1].t += '\n' + t;
        merged = true;
      } else {
        cur.lines.push({ t, o: j });
      }
      if (t.trim() !== '') curHasContent = true;
      // A pushed line indented 4+ columns is indented code, not
      // paragraph text, so a paragraph is not open after it (otherwise
      // the next code line would be merged and stripped twice).
      inPara = t.trim() !== '' && !setext &&
        (merged || (!isBlockStartLoose(t) && lineIndent(t).cols < 4));
      j++;
      continue;
    }
    // A thematic break line ends the list (marked checks hr before list
    // markers, so "* * *" or "- - -" between items is an <hr>, not an item).
    if (ind.cols <= 3 && isHr(line.slice(ind.idx))) break;
    const m = parseListMarker(line);
    if (m && m.kind === (ordered ? 'ordered' : 'bullet') && m.delim === first.delim &&
        m.indent <= first.indent + 3) {
      items.push(cur);
      cur = { lines: [], start: j };
      contentIndent = m.contentIndent;
      cur.lines.push({ t: stripColsExpand(line, contentIndent), o: j });
      inPara = cur.lines[0].t.trim() !== '' && !isBlockStartLoose(cur.lines[0].t);
      fence = inPara ? null : fenceOpen(cur.lines[0].t);
      curHasContent = cur.lines[0].t.trim() !== '';
      j++;
      continue;
    }
    if (m && ind.cols <= 3) break;
    if (fence) {
      // Inside a fenced code block, a non-structural line belongs to
      // the item as fence content even when it is not indented enough
      // (it is pushed as-is; the fence strips its own indent). A
      // structural line (heading, blockquote, html block, closing
      // fence) ends the list instead.
      const r = line.slice(ind.idx);
      if (ind.cols <= 3 && (matchAtx(r) || r[0] === '>' || htmlBlockType(line) >= 1 || fenceCloses(line, fence))) break;
      cur.lines.push({ t: line, o: j });
      if (line.trim() !== '') curHasContent = true;
      inPara = false;
      j++;
      continue;
    }
    if (inPara) {
      const rest = line.slice(ind.idx);
      // A setext underline cannot be a lazy continuation line: an hr
      // line ends the list, while a setext-only line joins the paragraph
      // as text. Merge it into the previous line so the inner parse
      // cannot read it as an underline.
      const isSetextOnly = ind.cols <= 3 && /^(=+|-+) *$/.test(rest) && !isHr(rest);
      if (!isSetextOnly && isBlockStart(line)) break;
      if (isSetextOnly && cur.lines.length) {
        const prev = cur.lines[cur.lines.length - 1];
        prev.t = prev.t + '\n' + line;
      } else {
        // A lazy continuation line indented 4 or more columns is
        // stripped of four columns before joining the paragraph. Merge
        // it into the previous line so the inner parse cannot re-read
        // it as a block start (a stripped "- bar" is text, not a list).
        let t = line;
        if (ind.cols >= 4) t = stripCols(line, 4);
        if (cur.lines.length) {
          cur.lines[cur.lines.length - 1].t += '\n' + t;
        } else {
          cur.lines.push({ t, o: j });
        }
        if (t.trim() !== '') curHasContent = true;
      }
      inPara = true;
      j++;
      continue;
    }
    // A lazy line also belongs to the item when its content ends with
    // an open paragraph inside a nested container (blockquote or
    // list). Merge it into the last line so the inner parse routes
    // it into that paragraph.
    if (lastLineOpenPara(cur.lines)) {
      let t = line;
      if (ind.cols >= 4) t = stripCols(line, 4);
      cur.lines[cur.lines.length - 1].t += '\n' + t;
      if (line.trim() !== '') curHasContent = true;
      inPara = false;
      j++;
      continue;
    }
    break;
  }
  items.push(cur);
  const outItems = [];
  let loose = false;
  for (let it = 0; it < items.length; it++) {
    const item = items[it];
    let lastNB = item.lines.length - 1;
    while (lastNB >= 0 && item.lines[lastNB].t === '') lastNB--;
    let separated = false;
    if (it < items.length - 1) {
      if (lastNB >= 0) separated = lastNB < item.lines.length - 1;
      else separated = item.lines.length > 1;
    }
    if (separated) loose = true;
    const itemLines = item.lines.map((x) => x.t);
    // A list item's fed text is right-trimmed: the trailing whitespace
    // of its last non-blank line is stripped (a middle line keeps its
    // trailing spaces, so a hard break still works).
    let lastNB2 = itemLines.length - 1;
    while (lastNB2 >= 0 && itemLines[lastNB2] === '') lastNB2--;
    if (lastNB2 >= 0) itemLines[lastNB2] = itemLines[lastNB2].replace(/[ \t]+$/, '');
    // As in a blockquote, a list item's fed text never ends with a
    // newline, so an html block last inside an item has no trailing one.
    const inner = parseBlocks(itemLines, ctx, false, true);
    // Content spans: rendered blocks plus consumed reference
    // definitions (a paragraph and a ref def separated by a blank
    // line make the list loose, as in "- b\n\n  [ref]: /url").
    const spans = inner.blocks.map((b) => ({ start: b.start, end: b.end }))
      .concat(inner.refDefs || []);
    spans.sort((a, b) => a.start - b.start);
    for (let b = 1; b < spans.length; b++) {
      // Two spans are separated by a blank line if the next span
      // starts more than one line after the previous span's last
      // non-blank line (a span's end may itself be a blank line it
      // consumed, e.g. a nested list ending on a blank line).
      const prev = spans[b - 1];
      let prevEnd = prev.end;
      while (prevEnd > prev.start && itemLines[prevEnd].trim() === '') prevEnd--;
      if (spans[b].start > prevEnd + 1) { loose = true; break; }
    }
    if (inner.blocks.length && inner.blocks[0].t === 'para') {
      const p0 = inner.blocks[0];
      const mt = /^\[([ xX])\]([ \t]|$)/.exec(p0.lines[0]);
      if (mt) {
        p0.task = mt[1] === ' ' ? ' ' : 'x';
        p0.lines[0] = p0.lines[0].slice(mt[0].length);
      }
    }
    outItems.push({ nodes: inner.blocks });
  }
  return {
    node: { t: 'list', ordered, startNum: first.startNum, items: outItems, loose, start: i, end: j - 1 },
    next: j,
  };
}

// ---------- paragraphs ----------

function parseParagraph(lines, i, ctx, lastNL, allowAnyListStart) {
  const paraLines = [lines[i]];
  let k = i + 1;
  let headingLevel = 0;
  while (k < lines.length) {
    const line = lines[k];
    if (isBlankLine(lines, k, lastNL)) break;
    const ind = lineIndent(line);
    const rest = line.slice(ind.idx);
    if (ind.cols <= 3 && /^(=+|-+) *$/.test(rest)) {
      headingLevel = rest[0] === '=' ? 1 : 2;
      k++;
      break;
    }
    if (ind.cols <= 3) {
      const m = parseListMarker(line);
      if (m) {
        // An ordered list may interrupt a paragraph with any start
        // number when the paragraph is directly inside a list item;
        // at the top level or inside a blockquote it needs start 1.
        if (m.hasContent && (m.kind === 'bullet' || m.startNum === 1 || allowAnyListStart)) break;
      } else if (isBlockStart(line)) break;
    }
    paraLines.push(line);
    k++;
  }
  if (headingLevel) {
    // A setext heading strips the first line's leading whitespace and
    // the last line's trailing whitespace (spaces and tabs).
    paraLines[0] = paraLines[0].replace(/^[ \t]+/, '');
    paraLines[paraLines.length - 1] = paraLines[paraLines.length - 1].replace(/[ \t]+$/, '');
    return {
      node: { t: 'heading', level: headingLevel, lines: paraLines, start: i, end: k - 1 },
      next: k,
    };
  }
  return { node: { t: 'para', lines: paraLines, start: i, end: k - 1 }, next: k };
}

// ---------- block loop ----------

function parseBlocks(lines, ctx, lastNL, allowAnyListStart) {
  const blocks = [];
  // Line ranges of consumed link reference definitions (they render
  // nothing but count as block-level content for loose-list detection).
  const refDefs = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i].trim() === '') { i++; continue; }
    let j = i;
    while (j < n) {
      const d = tryRefDef(lines, j, ctx);
      if (!d) break;
      refDefs.push({ start: j, end: d.next - 1 });
      j = d.next;
    }
    if (j > i) {
      if (j >= n || lines[j].trim() === '') { i = j; continue; }
      i = j;
    }
    const ind = lineIndent(lines[i]);
    const rest = lines[i].slice(ind.idx);
    if (ind.cols <= 3) {
      const f = fenceStart(rest);
      if (f) {
        const r = parseFence(lines, i);
        if (r) { blocks.push(r.node); i = r.next; continue; }
      }
      const atx = matchAtx(rest);
      if (atx) {
        blocks.push({ t: 'heading', level: atx.level, lines: [atx.content], start: i, end: i });
        i++;
        continue;
      }
      if (isHr(rest)) { blocks.push({ t: 'hr', start: i, end: i }); i++; continue; }
      const ht = htmlBlockType(lines[i]);
      if (ht >= 1 && ht <= 6) {
        const r = parseHtmlBlock(lines, i, ctx, lastNL);
        blocks.push(r.node);
        i = r.next;
        continue;
      }
      if (rest[0] === '>') {
        const r = parseBlockquote(lines, i, ctx, lastNL);
        blocks.push(r.node);
        i = r.next;
        continue;
      }
      if (parseListMarker(lines[i])) {
        const r = parseList(lines, i, ctx, lastNL);
        blocks.push(r.node);
        i = r.next;
        continue;
      }
      if (ht === 7) {
        const r = parseHtmlBlock(lines, i, ctx, lastNL);
        blocks.push(r.node);
        i = r.next;
        continue;
      }
      if (i + 1 < n && lineIndent(lines[i + 1]).cols <= 3) {
        const aligns = parseDelimiterRow(lines[i + 1]);
        if (aligns) {
          const headerCells = splitCells(rest);
          if (headerCells.length === aligns.length &&
              (lines[i + 1].indexOf(':') !== -1 || lines[i + 1].indexOf('|') !== -1 ||
               rest.indexOf('|') !== -1)) {
            const r = parseTable(lines, i, aligns, ctx, lastNL);
            blocks.push(r.node);
            i = r.next;
            continue;
          }
        }
      }
    }
    if (ind.cols >= 4) {
      const r = parseIndentedCode(lines, i);
      blocks.push(r.node);
      i = r.next;
      continue;
    }
    const r = parseParagraph(lines, i, ctx, lastNL, allowAnyListStart);
    blocks.push(r.node);
    i = r.next;
  }
  return { blocks, refDefs };
}

// ---------- tables ----------

// Split a table row into cells on unescaped '|'. Edge pipes are dropped.
function splitCells(line) {
  const s = line.trim();
  const cells = [];
  let cur = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    // An escaped pipe is consumed by the split (the cell content holds
    // a bare "|"); other escapes are kept for the inline parser.
    if (c === '\\' && i + 1 < s.length && s[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[i] + s[i + 1]; i += 2; continue; }
    if (c === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += c;
    i++;
  }
  cells.push(cur);
  for (let k = 0; k < cells.length; k++) cells[k] = cells[k].trim();
  if (s[0] === '|' && cells[0] === '') cells.shift();
  if (s[s.length - 1] === '|' && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

// Parse a delimiter row into alignments, or null when it is not one.
function parseDelimiterRow(line) {
  const cells = splitCells(line);
  if (!cells.length) return null;
  const aligns = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    if (cell[0] === ':' && cell[cell.length - 1] === ':' && cell.length > 1) aligns.push('center');
    else if (cell[cell.length - 1] === ':') aligns.push('right');
    else if (cell[0] === ':') aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}

function parseTable(lines, i, aligns, ctx, lastNL) {
  const header = splitCells(lines[i].slice(lineIndent(lines[i]).idx));
  const rows = [];
  let j = i + 2;
  while (j < lines.length) {
    const line = lines[j];
    // A whitespace-only line ends the table, except a line of 0-3
    // spaces plus a single tab, which marked reads as an empty row.
    if (line.trim() === '' && !/^ {0,3}\t$/.test(line)) break;
    if (lineIndent(line).cols <= 3 && isBlockStart(line)) break;
    const cells = splitCells(line.slice(lineIndent(line).idx));
    while (cells.length < header.length) cells.push('');
    rows.push(cells.slice(0, header.length));
    j++;
  }
  return {
    node: { t: 'table', aligns, header, rows, start: i, end: j - 1 },
    next: j,
  };
}

// ---------- rendering ----------

function renderBlock(b, refs, tight) {
  switch (b.t) {
    case 'para': {
      const inner = parseInline(joinLines(b.lines), refs);
      const cb = b.task
        ? (b.task === 'x' ? '<input checked="" disabled="" type="checkbox">'
                          : '<input disabled="" type="checkbox">')
        : '';
      const content = cb ? (inner ? cb + ' ' + inner : cb) : inner;
      return tight ? content : '<p>' + content + '</p>\n';
    }
    case 'heading': {
      const inner = parseInline(joinLines(b.lines), refs);
      return '<h' + b.level + '>' + inner + '</h' + b.level + '>\n';
    }
    case 'code':
      return '<pre><code>' + escapeHtml(b.text) + '</code></pre>\n';
    case 'fence': {
      const cls = b.lang ? ' class="language-' + escapeAttr(b.lang) + '"' : '';
      return '<pre><code' + cls + '>' + escapeHtml(b.text) + '</code></pre>\n';
    }
    case 'hr':
      return '<hr>\n';
    case 'html': {
      let out = b.lines.join('\n');
      if (b.addNL) out += '\n';
      return out;
    }
    case 'quote':
      return '<blockquote>\n' + renderBlocks(b.children, refs, false) + '</blockquote>\n';
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      let out = '<' + tag +
        (b.ordered && b.startNum !== 1 ? ' start="' + b.startNum + '"' : '') + '>\n';
      for (const item of b.items) {
        out += '<li>' + renderBlocks(item.nodes, refs, !b.loose) + '</li>\n';
      }
      return out + '</' + tag + '>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let k = 0; k < b.header.length; k++) {
        const a = b.aligns[k];
        out += '<th' + (a ? ' align="' + a + '"' : '') + '>' +
          parseInline(b.header[k], refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length === 0) return out + '</table>\n';
      out += '<tbody>';
      for (const row of b.rows) {
        out += '<tr>\n';
        for (let k = 0; k < row.length; k++) {
          const a = b.aligns[k];
          out += '<td' + (a ? ' align="' + a + '"' : '') + '>' +
            parseInline(row[k], refs) + '</td>\n';
        }
        out += '</tr>\n';
      }
      return out + '</tbody></table>\n';
    }
  }
  return '';
}

function renderBlocks(nodes, refs, tight) {
  let out = '';
  for (const b of nodes) out += renderBlock(b, refs, tight);
  return out;
}

// ---------- entry point ----------

export function parse(markdown) {
  suppressExtAutolink = false;
  let src = String(markdown).replace(/\r\n?/g, '\n');
  src = src.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '�');
  const lines = src.split('\n');
  const lastNL = src.endsWith('\n');
  if (lastNL) lines.pop();
  const ctx = { refs: new Map() };
  const tree = parseBlocks(lines, ctx, lastNL);
  return renderBlocks(tree.blocks, ctx.refs, false);
}
