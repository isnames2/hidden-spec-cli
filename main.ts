// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A,
// JSON edits), finds the lines each edit names at the first of three matching
// tiers (exact, trailing whitespace, both-side whitespace), and writes every
// change or none, printing what it changed or why it failed.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

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
  /** Successful moves, in order: [old, new]. Used only to print `R` lines. */
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
  recordMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Lines: a file's break, its lines, and whether it ends with a break (SPEC 3).
// ---------------------------------------------------------------------------

interface Split {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): Split {
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

// ---------------------------------------------------------------------------
// Matching at three tiers (SPEC 5). Only spaces and tabs count as whitespace.
// ---------------------------------------------------------------------------

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** Tier order is deliberate: exact first, then trailing-whitespace, then
    both-side, so a stricter match is never shadowed by a looser one. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}

// Strict mode tries the exact tier only; normal mode tries all three in order.
function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** All 0-based positions at or after `from` where O occurs in `file` at `tier`. */
function occurrences(O: string[], file: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j]!, file[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2) at which O occurs at least once, with its positions. */
function findTier(O: string[], file: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  for (const t of tiers(strict)) {
    const occ = occurrences(O, file, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One body line of a hunk / chunk / block: context, old, or new. */
interface Item {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line follows this body line in the patch. */
  bs: boolean;
}

function oldLines(items: Item[]): string[] {
  return items.filter((i) => i.kind !== 'new').map((i) => i.text);
}

/**
 * The lines N writes when O matched at `pos` at `tier`: a context line is the
 * file's own matched line; at tier 2 every other (new) line is re-indented
 * from O's first line's leading whitespace to the file's first matched line's.
 */
function buildNew(items: Item[], file: string[], pos: number, tier: number): string[] {
  const O = oldLines(items);
  let f = '';
  let p = '';
  if (tier === 2 && O.length > 0) {
    f = leadST(file[pos] ?? '');
    p = leadST(O[0]!);
  }
  const out: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(file[pos + oi]!);
      oi += 1;
    } else if (it.kind === 'old') {
      oi += 1;
    } else {
      let t = it.text;
      if (tier === 2 && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
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

// ---------------------------------------------------------------------------
// JSON edits (SPEC 9). Unchanged from the kit starter.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Unified diffs (SPEC 6).
// ---------------------------------------------------------------------------

/** The path after `--- ` / `+++ `: up to the first tab, spaces removed, a/b prefix removed. */
function headerPath(line: string): string {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

interface Hunk {
  /** A from `@@ -A[,B] +C[,D] @@`. */
  a: number;
  items: Item[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNL: boolean;
}

interface Section {
  oldPath: string;
  newPath: string;
  kind: 'create' | 'delete' | 'move' | 'change';
  hunks: Hunk[];
}

function makeHunk(a: number, body: string[]): Hunk {
  const items: Item[] = [];
  for (const bl of body) {
    if (bl.startsWith('\\')) {
      if (items.length > 0) items[items.length - 1]!.bs = true;
    } else if (bl.startsWith(' ')) {
      items.push({ kind: 'ctx', text: bl.slice(1), bs: false });
    } else if (bl.startsWith('-')) {
      items.push({ kind: 'old', text: bl.slice(1), bs: false });
    } else if (bl.startsWith('+')) {
      items.push({ kind: 'new', text: bl.slice(1), bs: false });
    } else if (bl === '') {
      items.push({ kind: 'ctx', text: '', bs: false });
    }
  }
  let noNL = false;
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k]!.kind !== 'old') {
      noNL = items[k]!.bs;
      break;
    }
  }
  return { a, items, noNL };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  interface Raw {
    gitOld: string | undefined;
    gitNew: string | undefined;
    pairOld: string | undefined;
    pairNew: string | undefined;
    renOld: string | undefined;
    renNew: string | undefined;
    newFile: boolean;
    delFile: boolean;
    hunks: Hunk[];
    headerDone: boolean;
  }
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*|)$/;
  const gitRe = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = gitRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { gitOld: m[1], gitNew: m[2], pairOld: undefined, pairNew: undefined, renOld: undefined, renNew: undefined, newFile: false, delFile: false, hunks: [], headerDone: false };
      raws.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.headerDone) {
        cur = { gitOld: undefined, gitNew: undefined, pairOld: undefined, pairNew: undefined, renOld: undefined, renNew: undefined, newFile: false, delFile: false, hunks: [], headerDone: false };
        raws.push(cur);
      }
      cur.pairOld = headerPath(line);
      cur.pairNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i += 1;
      const body: string[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(makeHunk(a, body));
      cur.headerDone = true;
      continue;
    }
    if (cur !== null && !cur.headerDone) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (raws.length === 0) throw new Exit2('error: parse 1');
  const sections: Section[] = raws.map((r) => {
    const oldPath = r.pairOld ?? r.renOld ?? r.gitOld ?? '';
    const newPath = r.pairNew ?? r.renNew ?? r.gitNew ?? '';
    let kind: Section['kind'];
    if (oldPath === '/dev/null' || r.newFile) kind = 'create';
    else if (newPath === '/dev/null' || r.delFile) kind = 'delete';
    else if (oldPath !== newPath) kind = 'move';
    else kind = 'change';
    return { oldPath, newPath, kind, hunks: r.hunks };
  });
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const p = s.kind === 'create' ? s.newPath : s.oldPath;
    if (s.kind === 'move') {
      if (!safe(s.oldPath)) throw new Fail('unsafe', s.oldPath);
      if (!safe(s.newPath)) throw new Fail('unsafe', s.newPath);
    } else if (!safe(p)) {
      throw new Fail('unsafe', p);
    }
    if (s.kind === 'create') {
      if (tree.get(s.newPath) !== null) throw new Fail('exists', s.newPath);
      const plus: { text: string; bs: boolean }[] = [];
      for (const h of s.hunks) for (const it of h.items) if (it.kind === 'new') plus.push({ text: it.text, bs: it.bs });
      tree.now.set(s.newPath, plus.length === 0 ? '' : plus.map((x) => x.text).join('\n') + (plus[plus.length - 1]!.bs ? '' : '\n'));
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.oldPath) === null) throw new Fail('missing', s.oldPath);
      tree.now.set(s.oldPath, null);
      return;
    }
    if (s.kind === 'move') {
      if (tree.get(s.oldPath) === null) throw new Fail('missing', s.oldPath);
      if (tree.get(s.newPath) !== null) throw new Fail('exists', s.newPath);
    } else if (tree.get(s.oldPath) === null) {
      throw new Fail('missing', s.oldPath);
    }
    const before = tree.get(s.oldPath)!;
    const split = splitFile(before);
    const lines = split.lines;
    let final = split.final;
    let d = 0;
    for (const h of s.hunks) {
      const O = oldLines(h.items);
      if (O.length === 0) {
        const pos = Math.max(0, Math.min(h.a + d, lines.length));
        const ins = h.items.filter((it) => it.kind === 'new').map((it) => it.text);
        const atEnd = pos === lines.length;
        lines.splice(pos, 0, ...ins);
        if (atEnd) final = !h.noNL;
        d += ins.length;
      } else {
        const found = findTier(O, lines, 0, strict);
        if (found === null) throw new Fail('no-match', s.oldPath);
        const target = h.a - 1 + d;
        let best = found.occ[0]!;
        let bestDist = Math.abs(best - target);
        for (const q of found.occ) {
          const dist = Math.abs(q - target);
          if (dist < bestDist) {
            best = q;
            bestDist = dist;
          }
        }
        const atEnd = best + O.length === lines.length;
        const repl = buildNew(h.items, lines, best, found.tier);
        lines.splice(best, O.length, ...repl);
        if (atEnd) final = !h.noNL;
        d += repl.length - O.length;
      }
    }
    const out = joinFile(lines, split.br, final);
    if (s.kind === 'move') {
      tree.now.set(s.newPath, out);
      tree.now.set(s.oldPath, null);
      tree.recordMove(s.oldPath, s.newPath);
    } else {
      tree.now.set(s.oldPath, out);
    }
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC 7).
// ---------------------------------------------------------------------------

function srEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    old: string[];
    nw: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchIdx = i;
      let path: string | null = null;
      for (let j = searchIdx - 1; j >= prevEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
        path = prevPath;
      }
      let sep = -1;
      for (let j = searchIdx + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          sep = j;
          break;
        }
      }
      if (sep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
      let end = -1;
      for (let j = sep + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
      if (end === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
      blocks.push({ path, old: lines.slice(searchIdx + 1, sep), nw: lines.slice(sep + 1, end) });
      prevPath = path;
      prevEnd = end + 1;
      i = end + 1;
      continue;
    }
    i += 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    const items: Item[] = [
      ...b.old.map((text): Item => ({ kind: 'old', text, bs: false })),
      ...b.nw.map((text): Item => ({ kind: 'new', text, bs: false })),
    ];
    return (tree: Tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.old.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
        return;
      }
      const before = tree.get(b.path);
      if (before === null) throw new Fail('missing', b.path);
      const split = splitFile(before);
      const found = findTier(b.old, split.lines, 0, strict);
      if (found === null) throw new Fail('no-match', b.path);
      if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
      const pos = found.occ[0]!;
      const repl = buildNew(items, split.lines, pos, found.tier);
      split.lines.splice(pos, b.old.length, ...repl);
      tree.now.set(b.path, joinFile(split.lines, split.br, split.final));
    };
  });
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC 8).
// ---------------------------------------------------------------------------

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  interface RawSection {
    kind: 'add' | 'delete' | 'update';
    path: string;
    headerLine: number;
    content: string[];
    contentStart: number;
  }
  const rawSections: RawSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: RawSection['kind'];
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    i += 1;
    const start = i;
    while (i < last && !isSectionStart(lines[i]!)) i += 1;
    const content = lines.slice(start, i);
    while (content.length > 0 && blank(content[content.length - 1]!)) content.pop();
    rawSections.push({ kind, path, headerLine, content, contentStart: start + 1 });
  }
  if (rawSections.length === 0) throw new Exit2('error: parse 1');
  return rawSections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(
  s: { kind: 'add' | 'delete' | 'update'; path: string; headerLine: number; content: string[]; contentStart: number },
  strict: boolean,
): Edit {
  if (s.kind === 'add') {
    const fileLines: string[] = [];
    for (let k = 0; k < s.content.length; k++) {
      const l = s.content[k]!;
      if (l.startsWith('+')) fileLines.push(l.slice(1));
      else if (l === '') fileLines.push('');
      else throw new Exit2(`error: parse ${s.contentStart + k}`);
    }
    const text = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, text);
    };
  }
  if (s.kind === 'delete') {
    for (let k = 0; k < s.content.length; k++) {
      if (!blank(s.content[k]!)) throw new Exit2(`error: parse ${s.contentStart + k}`);
    }
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
    };
  }
  // Update File.
  let moveTo: string | undefined;
  let rest = s.content;
  let restStart = s.contentStart;
  if (rest.length > 0 && rest[0]!.startsWith('*** Move to: ')) {
    moveTo = rest[0]!.slice('*** Move to: '.length).trim();
    rest = rest.slice(1);
    restStart += 1;
  }
  interface Chunk {
    anchor: string | null;
    items: Item[];
    eof: boolean;
  }
  const chunks: Chunk[] = [];
  let curChunk: Chunk | null = null;
  for (let k = 0; k < rest.length; k++) {
    const l = rest[k]!;
    const num = restStart + k;
    if (l === '*** End of File') {
      if (curChunk === null) curChunk = { anchor: null, items: [], eof: false };
      curChunk.eof = true;
      chunks.push(curChunk);
      curChunk = null;
    } else if (l.startsWith('@@')) {
      if (curChunk !== null) chunks.push(curChunk);
      curChunk = { anchor: l.slice(2).trim(), items: [], eof: false };
    } else if (l.startsWith(' ')) {
      if (curChunk === null) curChunk = { anchor: null, items: [], eof: false };
      curChunk.items.push({ kind: 'ctx', text: l.slice(1), bs: false });
    } else if (l.startsWith('-')) {
      if (curChunk === null) curChunk = { anchor: null, items: [], eof: false };
      curChunk.items.push({ kind: 'old', text: l.slice(1), bs: false });
    } else if (l.startsWith('+')) {
      if (curChunk === null) curChunk = { anchor: null, items: [], eof: false };
      curChunk.items.push({ kind: 'new', text: l.slice(1), bs: false });
    } else if (l === '') {
      if (curChunk === null) curChunk = { anchor: null, items: [], eof: false };
      curChunk.items.push({ kind: 'ctx', text: '', bs: false });
    } else {
      throw new Exit2(`error: parse ${num}`);
    }
  }
  if (curChunk !== null) chunks.push(curChunk);
  if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${s.headerLine}`);
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const split = splitFile(before);
    const lines = split.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        let foundIdx = -1;
        for (const t of tiers(strict)) {
          for (let k = cursor; k < lines.length; k++) {
            if (lineEq(chunk.anchor, lines[k]!, t)) {
              foundIdx = k;
              break;
            }
          }
          if (foundIdx >= 0) break;
        }
        if (foundIdx < 0) throw new Fail('no-match', s.path);
        cursor = foundIdx + 1;
      }
      const O = oldLines(chunk.items);
      if (O.length === 0) {
        const pos = chunk.eof ? lines.length : cursor;
        const ins = chunk.items.filter((it) => it.kind === 'new').map((it) => it.text);
        lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
      } else {
        let found: { tier: number; pos: number } | null = null;
        for (const t of tiers(strict)) {
          const occ = occurrences(O, lines, t, cursor).filter((p) => !chunk.eof || p + O.length === lines.length);
          if (occ.length > 0) {
            found = { tier: t, pos: occ[0]! };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', s.path);
        const repl = buildNew(chunk.items, lines, found.pos, found.tier);
        lines.splice(found.pos, O.length, ...repl);
        cursor = found.pos + repl.length;
      }
    }
    const out = joinFile(lines, split.br, split.final);
    if (moveTo !== undefined) {
      tree.now.set(moveTo, out);
      tree.now.set(s.path, null);
      tree.recordMove(s.path, moveTo);
    } else {
      tree.now.set(s.path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Invocation, output and exit codes (SPEC 1, 2, 10).
// ---------------------------------------------------------------------------

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
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
  // Changed paths, in byte order of the paths; a move prints one `R` line
  // (sorted by its new path) in place of the pair's `D` and `A` lines.
  const entries: { key: string; line: string }[] = [];
  const deleted = new Set<string>();
  const added = new Set<string>();
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) added.add(p);
    else if (now === null) deleted.add(p);
    else entries.push({ key: p, line: `M ${p}` });
  }
  const seenPairs = new Set<string>();
  for (const [o, n] of tree.moves) {
    let end = n;
    const seen = new Set<string>([o]);
    for (;;) {
      const nxt = tree.moves.find(([oo]) => oo === end);
      if (nxt === undefined || seen.has(nxt[1])) break;
      seen.add(nxt[1]);
      end = nxt[1];
    }
    const key = `${o}\0${end}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    if (deleted.has(o) && added.has(end)) {
      deleted.delete(o);
      added.delete(end);
      entries.push({ key: end, line: `R ${o} -> ${end}` });
    }
  }
  for (const p of deleted) entries.push({ key: p, line: `D ${p}` });
  for (const p of added) entries.push({ key: p, line: `A ${p}` });
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
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
