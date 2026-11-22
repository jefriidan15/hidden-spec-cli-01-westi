// main.ts is mend, the CLI SPEC.md specifies: the command line, the output and
// exit codes, safe paths, format detection, all four edit formats (unified diffs
// section 6, SEARCH/REPLACE blocks section 7, V4A patches section 8, JSON section 9),
// matching lines at three tiers (section 5), and the all-or-nothing write (section 10).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
  readonly moves: Array<[string, string]> = [];
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

/** Split a file's text into lines per SPEC.md section 3. */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** One line of new text: ctx >= 0 means it mirrors O[ctx] (a context line). */
interface NLine {
  text: string;
  ctx: number;
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  const t = s.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

/** 0-based positions where O occurs in lines at one tier. */
function occurrences(O: string[], lines: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(O[j]!, tier) !== normLine(lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier at which O occurs at least once (SPEC.md section 5). */
function findTier(O: string[], lines: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(O, lines, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** Replace O at position `at` with N. Context lines come from the file itself;
    at tier 2 every other line is re-indented from O's first line to the file's. */
function applyAt(lines: string[], at: number, O: string[], N: NLine[], tier: number): string[] {
  const out = lines.slice(0, at);
  const F = at < lines.length ? /^[\t ]*/.exec(lines[at]!)![0] : '';
  const P = O.length > 0 ? /^[\t ]*/.exec(O[0]!)![0] : '';
  for (const n of N) {
    if (n.ctx >= 0) out.push(lines[at + n.ctx]!);
    else if (O.length > 0 && tier === 2 && n.text !== '' && n.text.trim() !== '' && n.text.startsWith(P)) {
      out.push(F + n.text.slice(P.length));
    } else out.push(n.text);
  }
  out.push(...lines.slice(at + O.length));
  return out;
}

/** First line at or after `from` equal to `single` at the first tier with one. */
function findSingleLine(single: string, lines: string[], from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(single, t) === normLine(lines[i]!, t)) return i;
    }
  }
  return -1;
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
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

/* ---- Unified diffs (SPEC.md section 6) ---- */

interface HunkBody {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}
interface Hunk {
  a: number;
  body: HunkBody[];
}
interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[]): UniSection[] {
  const diffRe = /^diff --git a\/([^ ]+) b\/([^ ]+)\s*$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const sections: UniSection[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    let m = diffRe.exec(line);
    let started = false;
    if (m) started = true;
    else if (line.startsWith('diff --git ')) throw new Exit2(`error: parse ${i + 1}`);
    else if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) started = true;
    if (!started) {
      i++;
      continue;
    }
    let diffOld: string | null = null;
    let diffNew: string | null = null;
    if (m) {
      diffOld = m[1]!;
      diffNew = m[2]!;
      i++;
    }
    let oldP: string | null = null;
    let newP: string | null = null;
    let havePair = false;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let isCreate = false;
    let isDelete = false;
    const hunks: Hunk[] = [];
    // Header: before the first hunk.
    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('@@')) break;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          const op = l.slice(4).split('\t')[0]!.trim();
          const np = lines[i + 1]!.slice(4).split('\t')[0]!.trim();
          oldP = op === '/dev/null' ? null : stripAB(op);
          newP = np === '/dev/null' ? null : stripAB(np);
          havePair = true;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) {
        renameFrom = stripAB(l.slice('rename from '.length).trim());
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        renameTo = stripAB(l.slice('rename to '.length).trim());
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        isCreate = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        isDelete = true;
        i++;
        continue;
      }
      i++;
    }
    if (!havePair) {
      if (renameFrom !== null) oldP = renameFrom;
      else if (diffOld !== null) oldP = stripAB(diffOld);
      if (renameTo !== null) newP = renameTo;
      else if (diffNew !== null) newP = stripAB(diffNew);
    }
    // Hunks.
    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('@@')) {
        const hm = hunkRe.exec(l);
        if (!hm) throw new Exit2(`error: parse ${i + 1}`);
        const a = parseInt(hm[1]!, 10);
        i++;
        const body: HunkBody[] = [];
        while (i < n) {
          const b = lines[i]!;
          if (b.startsWith('diff --git ')) break;
          if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
            body.push({ kind: (b === '' ? ' ' : b[0]) as HunkBody['kind'], text: b === '' ? '' : b.slice(1) });
            i++;
          } else break;
        }
        while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
        hunks.push({ a, body });
        continue;
      }
      if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) break;
      i++;
    }
    sections.push({ oldPath: oldP, newPath: newP, isCreate, isDelete, hunks });
  }
  return sections;
}

/** Does a `\` line follow the hunk's last context or `+` line? */
function hunkNoEol(h: Hunk): boolean {
  for (let k = h.body.length - 1; k >= 0; k--) {
    const b = h.body[k]!;
    if (b.kind === ' ' || b.kind === '+') {
      return h.body[k + 1] !== undefined && h.body[k + 1]!.kind === '\\';
    }
  }
  return false;
}

function hunkON(h: Hunk): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of h.body) {
    if (b.kind === ' ') {
      const idx = O.length;
      O.push(b.text);
      N.push({ text: b.text, ctx: idx });
    } else if (b.kind === '-') O.push(b.text);
    else if (b.kind === '+') N.push({ text: b.text, ctx: -1 });
  }
  return { O, N };
}

function applyUniHunk(cur: { lines: string[]; br: string; final: boolean }, h: Hunk, d: number, strict: boolean, path: string): { lines: string[]; br: string; final: boolean } {
  const { O, N } = hunkON(h);
  if (O.length === 0) {
    const at = Math.min(h.a + d, cur.lines.length);
    const ins = N.map((x) => x.text);
    const lines = [...cur.lines.slice(0, at), ...ins, ...cur.lines.slice(at)];
    const final = at === cur.lines.length ? !hunkNoEol(h) : cur.final;
    return { lines, br: cur.br, final };
  }
  const found = findTier(O, cur.lines, strict);
  if (!found) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.pos[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.pos) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const lines = applyAt(cur.lines, best, O, N, found.tier);
  const final = best + O.length === cur.lines.length ? !hunkNoEol(h) : cur.final;
  return { lines, br: cur.br, final };
}

function applyUniSection(tree: Tree, s: UniSection, strict: boolean): void {
  const oldP = s.oldPath;
  const newP = s.newPath;
  if (s.isCreate || oldP === null) {
    if (newP === null) throw new Fail('unsafe', '/dev/null');
    if (!safe(newP)) throw new Fail('unsafe', newP);
    if (tree.get(newP) !== null) throw new Fail('exists', newP);
    const plus: string[] = [];
    for (const h of s.hunks) for (const b of h.body) if (b.kind === '+') plus.push(b.text);
    let eol = true;
    for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
      const h = s.hunks[hi]!;
      let hasPlus = false;
      for (const b of h.body) if (b.kind === '+') hasPlus = true;
      if (hasPlus) {
        eol = !hunkNoEol(h);
        break;
      }
    }
    tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (eol ? '\n' : ''));
    return;
  }
  if (s.isDelete || newP === null) {
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (tree.get(oldP) === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, null);
    return;
  }
  if (!safe(oldP)) throw new Fail('unsafe', oldP);
  if (!safe(newP)) throw new Fail('unsafe', newP);
  const before = tree.get(oldP);
  if (before === null) throw new Fail('missing', oldP);
  if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
  let cur = splitFile(before);
  let d = 0;
  for (const h of s.hunks) {
    const { O, N } = hunkON(h);
    cur = applyUniHunk(cur, h, d, strict, oldP);
    d += N.length - O.length;
  }
  const out = joinFile(cur.lines, cur.br, cur.final);
  if (oldP !== newP) {
    tree.now.set(oldP, null);
    tree.now.set(newP, out);
    tree.moves.push([oldP, newP]);
  } else {
    tree.now.set(oldP, out);
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => (tree: Tree) => applyUniSection(tree, s, strict));
}

/* ---- SEARCH/REPLACE blocks (SPEC.md section 7) ---- */

interface SRBlock {
  path: string;
  old: string[];
  nw: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let j = i + 1;
    let eq = -1;
    while (j < lines.length) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
      j++;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let k = eq + 1;
    let rep = -1;
    while (k < lines.length) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      k++;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const old = lines.slice(i + 1, eq);
    const nw = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let p = searchIdx - 1; p > prevEnd; p--) {
      const t = lines[p]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    blocks.push({ path, old, nw });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks;
}

function applySRBlock(tree: Tree, b: SRBlock, strict: boolean): void {
  const p = b.path;
  if (!safe(p)) throw new Fail('unsafe', p);
  if (b.old.length === 0) {
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
    return;
  }
  const before = tree.get(p);
  if (before === null) throw new Fail('missing', p);
  const cur = splitFile(before);
  const found = findTier(b.old, cur.lines, strict);
  if (!found) throw new Fail('no-match', p);
  if (found.pos.length > 1) throw new Fail('ambiguous', p);
  const at = found.pos[0]!;
  const N = b.nw.map((t) => ({ text: t, ctx: -1 }));
  const lines = applyAt(cur.lines, at, b.old, N, found.tier);
  tree.now.set(p, joinFile(lines, cur.br, cur.final));
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks = parseSearchReplace(lines);
  return blocks.map((b) => (tree: Tree) => applySRBlock(tree, b, strict));
}

/* ---- V4A patches (SPEC.md section 8) ---- */

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: HunkBody[];
}
interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4AChunk[];
}

function parseV4A(lines: string[]): V4ASection[] {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && lines[last]!.trim() === '') last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (l.trim() === '') {
      i++;
      continue;
    }
    let kind: V4ASection['kind'] | null = null;
    let path = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i + 1;
    i++;
    const sec: V4ASection = { kind, path, moveTo: null, lines: [], chunks: [] };
    if (kind === 'add') {
      while (i < last) {
        const b = lines[i]!;
        if (b === '') {
          sec.lines.push('');
          i++;
        } else if (b.startsWith('+')) {
          sec.lines.push(b.slice(1));
          i++;
        } else break;
      }
      while (sec.lines.length > 0 && sec.lines[sec.lines.length - 1] === '') sec.lines.pop();
    } else if (kind === 'delete') {
      // No lines; anything else is handled by the outer loop as a parse error.
    } else {
      // update
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        sec.moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      let cur: V4AChunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) {
          while (cur.body.length > 0 && cur.body[cur.body.length - 1]!.kind === ' ' && cur.body[cur.body.length - 1]!.text === '') cur.body.pop();
          sec.chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const b = lines[i]!;
        if (b.startsWith('*** Add File: ') || b.startsWith('*** Delete File: ') || b.startsWith('*** Update File: ')) break;
        if (b.trim() === '*** End Patch') break;
        if (b.startsWith('*** End of File')) {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          closeChunk();
          i++;
          continue;
        }
        if (b.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${i + 1}`);
        if (b.startsWith('***')) throw new Exit2(`error: parse ${i + 1}`);
        if (b.startsWith('@@')) {
          closeChunk();
          cur = { anchor: b.slice(2).trim() === '' ? null : b.slice(2).trim(), eof: false, body: [] };
          i++;
          continue;
        }
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          if (cur === null) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, eof: false, body: [] };
          }
          cur.body.push({ kind: (b === '' ? ' ' : b[0]) as HunkBody['kind'], text: b === '' ? '' : b.slice(1) });
          i++;
          continue;
        }
        break;
      }
      closeChunk();
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${startLine}`);
    }
    sections.push(sec);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

function applyV4ASection(tree: Tree, s: V4ASection, strict: boolean): void {
  const p = s.path;
  if (!safe(p)) throw new Fail('unsafe', p);
  if (s.kind === 'add') {
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
    return;
  }
  if (s.kind === 'delete') {
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
    return;
  }
  const before = tree.get(p);
  if (before === null) throw new Fail('missing', p);
  let newP: string | null = null;
  if (s.moveTo !== null) {
    newP = s.moveTo;
    if (!safe(newP)) throw new Fail('unsafe', newP);
    if (tree.get(newP) !== null) throw new Fail('exists', newP);
  }
  let cur = splitFile(before);
  let cursor = 0;
  for (const ch of s.chunks) {
    if (ch.anchor !== null) {
      const at = findSingleLine(ch.anchor, cur.lines, cursor, strict);
      if (at < 0) throw new Fail('no-match', p);
      cursor = at + 1;
    }
    const O: string[] = [];
    const N: NLine[] = [];
    for (const b of ch.body) {
      if (b.kind === ' ') {
        const idx = O.length;
        O.push(b.text);
        N.push({ text: b.text, ctx: idx });
      } else if (b.kind === '-') O.push(b.text);
      else if (b.kind === '+') N.push({ text: b.text, ctx: -1 });
    }
    if (O.length === 0) {
      const at = ch.eof ? cur.lines.length : cursor;
      const ins = N.map((x) => x.text);
      cur = { ...cur, lines: [...cur.lines.slice(0, at), ...ins, ...cur.lines.slice(at)] };
      cursor = at + ins.length;
      continue;
    }
    const tiers = strict ? [0] : [0, 1, 2];
    let placed: { tier: number; at: number } | null = null;
    for (const t of tiers) {
      const pos = occurrences(O, cur.lines, t).filter((x) => x >= cursor);
      const okPos = ch.eof ? pos.filter((x) => x + O.length === cur.lines.length) : pos;
      if (okPos.length > 0) {
        placed = { tier: t, at: okPos[0]! };
        break;
      }
    }
    if (!placed) throw new Fail('no-match', p);
    cur = { ...cur, lines: applyAt(cur.lines, placed.at, O, N, placed.tier) };
    cursor = placed.at + N.length;
  }
  const out = joinFile(cur.lines, cur.br, cur.final);
  if (newP !== null) {
    tree.now.set(p, null);
    tree.now.set(newP, out);
    tree.moves.push([p, newP]);
  } else {
    tree.now.set(p, out);
  }
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseV4A(lines);
  return sections.map((s) => (tree: Tree) => applyV4ASection(tree, s, strict));
}

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
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? srEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const movedFrom = new Set(tree.moves.map(([o]) => o));
  const movedTo = new Map(tree.moves.map(([o, n]) => [n, o] as [string, string]));
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (!check && was !== now) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
    if (movedFrom.has(p)) continue;
    if (was === now) continue;
    rows.push(movedTo.has(p) ? `R ${movedTo.get(p)} -> ${p}` : `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
