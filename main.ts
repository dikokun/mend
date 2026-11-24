// mend: the CLI SPEC.md specifies. Built from the kit's starter (MIT): the command line, output and exit
// codes, safe paths, format detection, JSON edits and the all-or-nothing write are the starter's frame;
// the unified-diff, SEARCH/REPLACE and V4A readers and the three-tier line matching (SPEC.md sections
// 5 to 8) are written here. Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over
// to runner.ts (the last lines below): the hand-over and runner.ts stay as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file's own line model (SPEC.md section 3): its break, its lines, whether it ends with a break. */
interface FileText {
  br: string;
  lines: string[];
  final: boolean;
}

function splitText(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { br, lines: parts, final: fin };
}

function joinText(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

/** Section 5 matching: the first tier at which O occurs in the file's lines, and every position there. */
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
function normAt(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s);
}

interface TierMatch {
  tier: number;
  positions: number[];
}

function findTierFrom(lines: string[], o: string[], from: number, strict: boolean, eofOnly: boolean): TierMatch | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + o.length <= lines.length; i++) {
      if (eofOnly && i + o.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (normAt(lines[i + j]!, tier) !== normAt(o[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function findTier(lines: string[], o: string[], strict: boolean): TierMatch | null {
  return findTierFrom(lines, o, 0, strict, false);
}

/** One side of a hunk or chunk body: old lines O, new lines N, and for each line of N the line of O it
 *  pairs with when it is a context line (-1 when it is an added line). */
interface BodyEntry {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  rawEmpty: boolean;
}
interface ON {
  oT: string[];
  nT: string[];
  nCtx: number[];
  bsLast: boolean;
}

function onFromEntries(entries: BodyEntry[]): ON {
  const oT: string[] = [];
  const nT: string[] = [];
  const nCtx: number[] = [];
  let lastNew = -1;
  entries.forEach((e, idx) => {
    if (e.kind === 'ctx') {
      nCtx.push(oT.length);
      oT.push(e.text);
      nT.push(e.text);
      lastNew = idx;
    } else if (e.kind === 'del') {
      oT.push(e.text);
    } else if (e.kind === 'add') {
      nT.push(e.text);
      nCtx.push(-1);
      lastNew = idx;
    }
  });
  const bsLast = lastNew >= 0 && entries[lastNew + 1]?.kind === 'bs';
  return { oT, nT, nCtx, bsLast };
}

const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0];

/** The lines actually written for a match: context lines are the file's own, and at tier 2 the other
 *  lines are re-indented from O's first line's prefix to the file's first matched line's. */
function buildNew(lines: string[], pos: number, on: ON, tier: number): string[] {
  const f = leadWS(lines[pos] ?? '');
  const p = leadWS(on.oT[0] ?? '');
  return on.nT.map((txt, k) => {
    const oi = on.nCtx[k]!;
    if (oi >= 0) return lines[pos + oi]!;
    if (tier === 2 && txt !== '' && txt.trim() !== '' && txt.startsWith(p)) return f + txt.slice(p.length);
    return txt;
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ JSON (section 9) */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const st = splitText(before);
      if (line < 0 || line > st.lines.length) throw new Fail('no-match', p);
      const lines = [...st.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinText(lines, st.br, st.final));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ unified diffs (section 6) */

function headerPath(l: string): string {
  let t = l.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function renamePath(l: string, prefix: string): string {
  let t = l.slice(prefix.length);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return t.trim();
}

interface UHunk {
  a: number;
  on: ON;
}

function unifiedSectionEdit(
  oldRaw: string | undefined,
  newRaw: string | undefined,
  newFile: boolean,
  delFile: boolean,
  hunks: UHunk[],
  strict: boolean,
): Edit {
  const oldNull = oldRaw === '/dev/null';
  const newNull = newRaw === '/dev/null';
  if (oldNull || newFile) {
    // a creation: the file is the + lines of all its hunks
    const path = newRaw === undefined || newNull ? oldRaw! : newRaw;
    const plus: string[] = [];
    let bsAfterLast = false;
    for (const h of hunks) {
      h.on.nT.forEach((t, k) => {
        if (h.on.nCtx[k] === -1) plus.push(t);
      });
      if (h.on.nT.some((_, k) => h.on.nCtx[k] === -1)) bsAfterLast = h.on.bsLast;
    }
    const text = plus.length === 0 ? '' : plus.join('\n') + (bsAfterLast ? '' : '\n');
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, text);
    };
  }
  if (newNull || delFile) {
    const path = oldRaw!;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  const src = oldRaw!;
  const dst = newRaw === undefined ? src : newRaw;
  return (tree) => {
    if (!safe(src)) throw new Fail('unsafe', src);
    if (dst !== src && !safe(dst)) throw new Fail('unsafe', dst);
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    if (dst !== src && tree.get(dst) !== null) throw new Fail('exists', dst);
    const st = splitText(before);
    const lines = [...st.lines];
    let fin = st.final;
    let d = 0;
    for (const h of hunks) {
      const on = h.on;
      if (on.oT.length === 0) {
        const pos = Math.min(h.a + d, lines.length);
        const atEnd = pos === lines.length;
        lines.splice(pos, 0, ...on.nT);
        if (atEnd) fin = !on.bsLast;
        d += on.nT.length;
      } else {
        const f = findTier(lines, on.oT, strict);
        if (f === null) throw new Fail('no-match', src);
        const target = h.a - 1 + d;
        let best = f.positions[0]!;
        let bestDist = Math.abs(best - target);
        for (const p of f.positions) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
        const repl = buildNew(lines, best, on, f.tier);
        const atEnd = best + on.oT.length === lines.length;
        lines.splice(best, on.oT.length, ...repl);
        if (atEnd) fin = !on.bsLast;
        d += on.nT.length - on.oT.length;
      }
    }
    tree.now.set(dst, joinText(lines, st.br, fin));
    if (dst !== src) {
      tree.now.set(src, null);
      tree.moves.push([src, dst]);
    }
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  const isPair = (k: number): boolean => k < n && lines[k]!.startsWith('--- ') && k + 1 < n && lines[k + 1]!.startsWith('+++ ');
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    let gitOld: string | undefined;
    let gitNew: string | undefined;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const sep = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
      if (sep < 0) throw new Exit2(`error: parse ${i + 1}`);
      gitOld = rest.slice(2, sep);
      gitNew = rest.slice(sep + 3);
      i++;
    } else if (isPair(i)) {
      // a section that starts at its --- / +++ pair; the header loop below consumes it
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
      continue;
    }
    // the section's header, up to its first hunk
    let oldRaw: string | undefined = gitOld;
    let newRaw: string | undefined = gitNew;
    let newFile = false;
    let delFile = false;
    let sawPair = false;
    let j = i;
    while (j < n) {
      const l = lines[j]!;
      if (l.startsWith('@@')) break;
      if (l.startsWith('diff --git ')) break;
      if (isPair(j)) {
        if (sawPair) break;
        oldRaw = headerPath(l);
        newRaw = headerPath(lines[j + 1]!);
        sawPair = true;
        j += 2;
        continue;
      }
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${j + 2}`);
      if (l.startsWith('rename from ')) {
        if (!sawPair) oldRaw = renamePath(l, 'rename from ');
        j++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!sawPair) newRaw = renamePath(l, 'rename to ');
        j++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        newFile = true;
        j++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        delFile = true;
        j++;
        continue;
      }
      j++;
    }
    // the section's hunks
    const hunks: UHunk[] = [];
    while (j < n && lines[j]!.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(lines[j]!);
      if (m === null) throw new Exit2(`error: parse ${j + 1}`);
      const a = parseInt(m[1]!, 10);
      j++;
      const entries: BodyEntry[] = [];
      while (j < n) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (isPair(j)) break;
        if (l === '') {
          entries.push({ kind: 'ctx', text: '', rawEmpty: true });
          j++;
          continue;
        }
        const c = l[0]!;
        if (c === ' ') entries.push({ kind: 'ctx', text: l.slice(1), rawEmpty: false });
        else if (c === '-') entries.push({ kind: 'del', text: l.slice(1), rawEmpty: false });
        else if (c === '+') entries.push({ kind: 'add', text: l.slice(1), rawEmpty: false });
        else if (c === '\\') entries.push({ kind: 'bs', text: l.slice(1), rawEmpty: false });
        else break;
        j++;
      }
      while (entries.length > 0 && entries[entries.length - 1]!.rawEmpty) entries.pop();
      hunks.push({ a, on: onFromEntries(entries) });
    }
    edits.push(unifiedSectionEdit(oldRaw, newRaw, newFile, delFile, hunks, strict));
    i = j;
  }
  return edits;
}

/* ------------------------------------------------------------------ SEARCH/REPLACE (section 7) */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevPath: string | null = null;
  let bound = -1;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let k = i - 1; k > bound; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine}`);
    }
    let j = i + 1;
    while (j < n && lines[j]!.trimEnd() !== '=======') j++;
    if (j >= n) throw new Exit2(`error: parse ${searchLine}`);
    let k = j + 1;
    while (k < n && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (k >= n) throw new Exit2(`error: parse ${searchLine}`);
    const oldL = lines.slice(i + 1, j);
    const newL = lines.slice(j + 1, k);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldL.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newL.length === 0 ? '' : newL.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const st = splitText(before);
      const f = findTier(st.lines, oldL, strict);
      if (f === null) throw new Fail('no-match', p);
      if (f.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = f.positions[0]!;
      const on: ON = { oT: oldL, nT: newL, nCtx: newL.map(() => -1), bsLast: false };
      const repl = buildNew(st.lines, pos, on, f.tier);
      const out = [...st.lines];
      out.splice(pos, oldL.length, ...repl);
      tree.now.set(p, joinText(out, st.br, st.final));
    });
    prevPath = path;
    bound = k;
    i = k + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ V4A (section 8) */

interface Chunk {
  anchor: string | null;
  entries: BodyEntry[];
  eof: boolean;
}

const ADD_P = '*** Add File: ';
const DEL_P = '*** Delete File: ';
const UPD_P = '*** Update File: ';
const MOV_P = '*** Move to: ';

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const secStart = (l: string): boolean => l.startsWith(ADD_P) || l.startsWith(DEL_P) || l.startsWith(UPD_P);
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith(ADD_P)) {
      const path = l.slice(ADD_P.length).trim();
      i++;
      const body: string[] = [];
      while (i < last && !secStart(lines[i]!)) {
        const bl = lines[i]!;
        if (bl.startsWith('+')) body.push(bl.slice(1));
        else if (bl === '') body.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, body.length === 0 ? '' : body.join('\n') + '\n');
      });
      continue;
    }
    if (l.startsWith(DEL_P)) {
      const path = l.slice(DEL_P.length).trim();
      i++;
      while (i < last && !secStart(lines[i]!)) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (l.startsWith(UPD_P)) {
      const path = l.slice(UPD_P.length).trim();
      const updLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith(MOV_P)) {
        moveTo = lines[i]!.slice(MOV_P.length).trim();
        i++;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      while (i < last && !secStart(lines[i]!)) {
        const bl = lines[i]!;
        if (bl.startsWith('@@')) {
          cur = { anchor: bl.slice(2).trim() || null, entries: [], eof: false };
          chunks.push(cur);
          i++;
          continue;
        }
        if (bl.trimEnd() === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, entries: [], eof: true };
            chunks.push(cur);
          } else {
            cur.eof = true;
          }
          cur = null;
          i++;
          continue;
        }
        const c = bl[0];
        if (bl === '' || c === ' ' || c === '-' || c === '+') {
          if (cur === null) {
            cur = { anchor: null, entries: [], eof: false };
            chunks.push(cur);
          }
          cur.entries.push({
            kind: bl === '' || c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add',
            text: bl === '' ? '' : bl.slice(1),
            // a source line that is empty or only whitespace is a blank line: at the end of a
            // section it is not part of the section (section 8), so the last chunk drops it there
            rawEmpty: bl.trim() === '',
          });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const lc = chunks[chunks.length - 1];
      if (lc !== undefined) {
        while (lc.entries.length > 0 && lc.entries[lc.entries.length - 1]!.rawEmpty) lc.entries.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updLine}`);
      const mv = moveTo;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        const st = splitText(before);
        const out = [...st.lines];
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const anchor = ch.anchor;
            let found = -1;
            const tiers = strict ? [0] : [0, 1, 2];
            for (const tier of tiers) {
              for (let k = cursor; k < out.length; k++) {
                if (normAt(out[k]!, tier) === normAt(anchor, tier)) {
                  found = k;
                  break;
                }
              }
              if (found >= 0) break;
            }
            if (found < 0) throw new Fail('no-match', path);
            cursor = found + 1;
          }
          const on = onFromEntries(ch.entries);
          if (on.oT.length === 0) {
            const pos = ch.eof ? out.length : Math.min(cursor, out.length);
            out.splice(pos, 0, ...on.nT);
            cursor = pos + on.nT.length;
          } else {
            const f = findTierFrom(out, on.oT, cursor, strict, ch.eof);
            if (f === null) throw new Fail('no-match', path);
            const pos = f.positions[0]!;
            const repl = buildNew(out, pos, on, f.tier);
            out.splice(pos, on.oT.length, ...repl);
            cursor = pos + repl.length;
          }
        }
        const text = joinText(out, st.br, st.final);
        if (mv !== null) {
          tree.now.set(mv, text);
          tree.now.set(path, null);
          tree.moves.push([path, mv]);
        } else {
          tree.now.set(path, text);
        }
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ------------------------------------------------------------------ the run (sections 1, 2, 10) */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    text: string;
  }
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  let rows: Row[] = changed.map((p) => {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    return { key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` };
  });
  for (const [o, nw] of tree.moves) {
    const wasO = tree.original(o);
    const nowO = tree.now.get(o);
    const wasN = tree.original(nw);
    const nowN = tree.now.get(nw);
    if (wasO !== null && nowO === null && wasN === null && nowN !== null && nowN !== undefined) {
      const di = rows.findIndex((r) => r.key === o && r.text === `D ${o}`);
      const ai = rows.findIndex((r) => r.key === nw && r.text === `A ${nw}`);
      if (di >= 0 && ai >= 0) {
        rows = rows.filter((_, idx) => idx !== di && idx !== ai);
        rows.push({ key: nw, text: `R ${o} -> ${nw}` });
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
