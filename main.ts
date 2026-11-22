// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
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
  /** The move edits that succeeded, as [old, new]. */
  moves: [string, string][] = [];
}

type Edit = (tree: Tree) => void;

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

// ---------------------------------------------------------------------------------------------------------------
// Files as lines (section 3) and matching at three tiers (section 5).

let STRICT = false;

interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

function readDoc(t: string): Doc {
  if (t === '') return { lines: [], br: '\n', final: false };
  const nl = t.indexOf('\n');
  const br = nl > 0 && t[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = t.split(br);
  const final = t.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function writeDoc(d: Doc): string {
  return d.lines.length === 0 ? '' : d.lines.join(d.br) + (d.final ? d.br : '');
}

/** A file created by an edit: LF breaks, a final one unless `final` is false. */
function newFile(lines: string[], final = true): string {
  return lines.length === 0 ? '' : lines.join('\n') + (final ? '\n' : '');
}

const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const strip = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const TIERS: ((s: string) => string)[] = [(s) => s, rstrip, strip];
const lead = (s: string): string => /^[ \t]*/.exec(s)![0];

/** The occurrences of `old` in `file` at the first tier with any that `ok` accepts. */
function find(file: string[], old: string[], ok: (i: number) => boolean = () => true): { tier: number; at: number[] } | null {
  const tiers = STRICT ? 1 : 3;
  for (let tier = 0; tier < tiers; tier += 1) {
    const norm = TIERS[tier]!;
    const f = file.map(norm);
    const o = old.map(norm);
    const at: number[] = [];
    for (let i = 0; i + o.length <= f.length; i += 1) {
      if (!ok(i)) continue;
      let hit = true;
      for (let k = 0; k < o.length; k += 1) {
        if (f[i + k] !== o[k]) {
          hit = false;
          break;
        }
      }
      if (hit) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** A line of N: its text, and for a context line the index of its line in O. */
interface NLine {
  text: string;
  ctx: number;
}

/** N in place of the old.length lines at `at`, matched at `tier`. */
function splice(file: string[], at: number, old: string[], n: NLine[], tier: number): string[] {
  const F = old.length > 0 ? lead(file[at]!) : '';
  const P = old.length > 0 ? lead(old[0]!) : '';
  const out = n.map((l) => {
    if (l.ctx >= 0) return file[at + l.ctx]!;
    if (tier === 2 && l.text.trim() !== '' && l.text.startsWith(P)) return F + l.text.slice(P.length);
    return l.text;
  });
  return [...file.slice(0, at), ...out, ...file.slice(at + old.length)];
}

interface Item {
  kind: string; // ' ', '-' or '+'
  text: string;
  bs: boolean; // a `\` line follows it
}

function oldNew(items: Item[]): { old: string[]; n: NLine[] } {
  const old: string[] = [];
  const n: NLine[] = [];
  for (const it of items) {
    if (it.kind === ' ') {
      n.push({ text: it.text, ctx: old.length });
      old.push(it.text);
    } else if (it.kind === '-') old.push(it.text);
    else n.push({ text: it.text, ctx: -1 });
  }
  return { old, n };
}

function checkSafe(...paths: string[]): void {
  for (const p of paths) if (!safe(p)) throw new Fail('unsafe', p);
}

// ---------------------------------------------------------------------------------------------------------------
// Unified diffs (section 6).

interface Hunk {
  a: number;
  items: Item[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null | undefined; // undefined: no ---/+++ pair; null: /dev/null
  pairNew: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

function diffPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.replace(/^ +/, '').replace(/ +$/, '');
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let header = false; // in sec's header (no hunk yet)
  const isPair = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  const fresh = (): Section => ({ gitOld: null, gitNew: null, pairOld: undefined, pairNew: undefined, renameFrom: null, renameTo: null, creation: false, deletion: false, hunks: [] });
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      let x = m[1]!;
      let y = m[2]!;
      // With spaces in paths the split is ambiguous: prefer the one that names the same path twice.
      const rest = l.slice('diff --git a/'.length);
      for (let k = rest.indexOf(' b/'); k >= 0; k = rest.indexOf(' b/', k + 1)) {
        if (rest.slice(0, k) === rest.slice(k + 3)) {
          x = rest.slice(0, k);
          y = rest.slice(k + 3);
          break;
        }
      }
      sec = fresh();
      sec.gitOld = x;
      sec.gitNew = y;
      sections.push(sec);
      header = true;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (isPair(i)) {
        if (!(header && sec !== null && sec.pairOld === undefined)) {
          sec = fresh();
          sections.push(sec);
          header = true;
        }
        sec!.pairOld = diffPath(l);
        sec!.pairNew = diffPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (header) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null || sec === null) throw new Exit2(`error: parse ${i + 1}`);
      header = false;
      const hunk: Hunk = { a: Number(m[1]), items: [] };
      sec.hunks.push(hunk);
      i += 1;
      let end = i;
      while (end < lines.length) {
        const b = lines[end]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && isPair(end)) break;
        const c = b[0];
        if (b === '' || c === ' ' || c === '-' || c === '+' || c === '\\') end += 1;
        else break;
      }
      let last = end;
      while (last > i && lines[last - 1] === '') last -= 1;
      for (let k = i; k < last; k += 1) {
        const b = lines[k]!;
        if (b.startsWith('\\')) {
          const prev = hunk.items[hunk.items.length - 1];
          if (prev !== undefined) prev.bs = true;
        } else if (b === '') hunk.items.push({ kind: ' ', text: '', bs: false });
        else hunk.items.push({ kind: b[0]!, text: b.slice(1), bs: false });
      }
      i = last;
      continue;
    }
    if (header && sec !== null) {
      if (l.startsWith('rename from ')) sec.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) sec.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) sec.creation = true;
      else if (l.startsWith('deleted file mode')) sec.deletion = true;
    }
    i += 1;
  }
  return sections.map(sectionEdit);
}

function sectionEdit(s: Section): Edit {
  const oldPath = s.pairOld !== undefined ? s.pairOld : (s.renameFrom ?? s.gitOld);
  const newPath = s.pairNew !== undefined ? s.pairNew : (s.renameTo ?? s.gitNew);
  if (oldPath === null || s.creation) {
    const p = newPath ?? '/dev/null';
    const plus = s.hunks.flatMap((h) => h.items.filter((it) => it.kind === '+'));
    const final = plus.length === 0 || !plus[plus.length - 1]!.bs;
    return (tree) => {
      checkSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, newFile(plus.map((it) => it.text), final));
    };
  }
  if (newPath === null || s.deletion) {
    const p = oldPath;
    return (tree) => {
      checkSafe(p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const move = oldPath !== newPath;
  return (tree) => {
    checkSafe(oldPath, ...(move ? [newPath] : []));
    const text = tree.get(oldPath);
    if (text === null) throw new Fail('missing', oldPath);
    if (move && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const doc = readDoc(text);
    let d = 0;
    for (const h of s.hunks) {
      const { old, n } = oldNew(h.items);
      const lastN = [...h.items].reverse().find((it) => it.kind !== '-');
      const noEol = lastN !== undefined && lastN.bs;
      let atEnd: boolean;
      if (old.length > 0) {
        const r = find(doc.lines, old);
        if (r === null) throw new Fail('no-match', oldPath);
        const target = h.a - 1 + d;
        let best = r.at[0]!;
        for (const p of r.at) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
        atEnd = best + old.length === doc.lines.length;
        doc.lines = splice(doc.lines, best, old, n, r.tier);
      } else {
        const at = Math.max(0, Math.min(h.a + d, doc.lines.length));
        atEnd = at === doc.lines.length;
        doc.lines = splice(doc.lines, at, [], n, 0);
      }
      if (atEnd) doc.final = !noEol;
      d += n.length - old.length;
    }
    const out = writeDoc(doc);
    if (move) {
      tree.now.set(oldPath, null);
      tree.now.set(newPath, out);
      tree.moves.push([oldPath, newPath]);
    } else tree.now.set(oldPath, out);
  };
}

// ---------------------------------------------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7).

function searchReplaceEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  for (let s = 0; s < lines.length; s += 1) {
    if (rstripWs(lines[s]!) !== '<<<<<<< SEARCH') continue;
    let path: string | null = null;
    for (let k = s - 1; k >= prevEnd; k -= 1) {
      const t = lines[k]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    for (let k = s + 1; k < lines.length; k += 1) {
      if (rstripWs(lines[k]!) === '=======') {
        eq = k;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let k = eq + 1; k < lines.length; k += 1) {
        if (rstripWs(lines[k]!) === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(blockEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep)));
    prevPath = path;
    prevEnd = rep + 1;
    s = rep;
  }
  return edits;
}

const rstripWs = (s: string): string => s.replace(/\s+$/, '');

function blockEdit(p: string, old: string[], neu: string[]): Edit {
  return (tree) => {
    checkSafe(p);
    const text = tree.get(p);
    if (old.length === 0) {
      if (text !== null) throw new Fail('exists', p);
      tree.now.set(p, newFile(neu));
      return;
    }
    if (text === null) throw new Fail('missing', p);
    const doc = readDoc(text);
    const r = find(doc.lines, old);
    if (r === null) throw new Fail('no-match', p);
    if (r.at.length > 1) throw new Fail('ambiguous', p);
    doc.lines = splice(doc.lines, r.at[0]!, old, neu.map((t) => ({ text: t, ctx: -1 })), r.tier);
    tree.now.set(p, writeDoc(doc));
  };
}

// ---------------------------------------------------------------------------------------------------------------
// V4A patches (section 8).

interface Chunk {
  anchor: string | null;
  items: Item[];
  eof: boolean;
}

const ADD = '*** Add File: ';
const DEL = '*** Delete File: ';
const UPD = '*** Update File: ';
const MOVE = '*** Move to: ';

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last === first || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const starts = (l: string): boolean => l.startsWith(ADD) || l.startsWith(DEL) || l.startsWith(UPD);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (!starts(l)) throw new Exit2(`error: parse ${i + 1}`);
    let end = i + 1;
    while (end < last && !starts(lines[end]!)) end += 1;
    let stop = end;
    while (stop > i + 1 && blank(lines[stop - 1]!)) stop -= 1;
    const body = lines.slice(i + 1, stop);
    const at = (k: number): number => i + 2 + k; // 1-based patch line of body[k]
    if (l.startsWith(ADD)) {
      const p = l.slice(ADD.length).trim();
      const out: string[] = [];
      body.forEach((b, k) => {
        if (b === '') out.push('');
        else if (b.startsWith('+')) out.push(b.slice(1));
        else throw new Exit2(`error: parse ${at(k)}`);
      });
      edits.push((tree) => {
        checkSafe(p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newFile(out));
      });
    } else if (l.startsWith(DEL)) {
      const p = l.slice(DEL.length).trim();
      if (body.length > 0) throw new Exit2(`error: parse ${at(0)}`);
      edits.push((tree) => {
        checkSafe(p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const p = l.slice(UPD.length).trim();
      let moveTo: string | null = null;
      let k = 0;
      if (body.length > 0 && body[0]!.startsWith(MOVE)) {
        moveTo = body[0]!.slice(MOVE.length).trim();
        k = 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      for (; k < body.length; k += 1) {
        const b = body[k]!;
        const c = b[0];
        if (b.trim() === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, items: [], eof: false };
            chunks.push(cur);
          }
          cur.eof = true;
          cur = null;
        } else if (b.startsWith('@@')) {
          const a = b.slice(2).trim();
          cur = { anchor: a === '' ? null : a, items: [], eof: false };
          chunks.push(cur);
        } else if (b === '' || c === ' ' || c === '-' || c === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${at(k)}`);
            cur = { anchor: null, items: [], eof: false };
            chunks.push(cur);
          }
          cur.items.push({ kind: b === '' ? ' ' : c!, text: b.slice(1), bs: false });
        } else throw new Exit2(`error: parse ${at(k)}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(updateEdit(p, moveTo, chunks));
    }
    i = end;
  }
  return edits;
}

function updateEdit(p: string, moveTo: string | null, chunks: Chunk[]): Edit {
  return (tree) => {
    checkSafe(p, ...(moveTo !== null ? [moveTo] : []));
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = readDoc(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const r = find(doc.lines, [ch.anchor], (j) => j >= cursor);
        if (r === null) throw new Fail('no-match', p);
        cursor = r.at[0]! + 1;
      }
      const { old, n } = oldNew(ch.items);
      if (old.length > 0) {
        const len = doc.lines.length;
        const r = find(doc.lines, old, (j) => j >= cursor && (!ch.eof || j + old.length === len));
        if (r === null) throw new Fail('no-match', p);
        const at = r.at[0]!;
        doc.lines = splice(doc.lines, at, old, n, r.tier);
        cursor = at + n.length;
      } else {
        const at = ch.eof ? doc.lines.length : Math.min(cursor, doc.lines.length);
        doc.lines = splice(doc.lines, at, [], n, 0);
        cursor = at + n.length;
      }
    }
    const out = writeDoc(doc);
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, out);
      tree.moves.push([p, moveTo]);
    } else tree.now.set(p, out);
  };
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
  STRICT = strict;
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else edits = v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = moves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  const rows: { key: string; text: string }[] = [];
  const paired = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (paired.has(o) || paired.has(n)) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      paired.add(o);
      paired.add(n);
      rows.push({ key: n, text: `R ${o} -> ${n}` });
    }
  }
  for (const p of changed) {
    if (paired.has(p)) continue;
    const was = tree.original(p);
    rows.push({ key: p, text: `${was === null ? 'A' : tree.now.get(p) === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      if (tree.now.get(p) !== null) continue;
      rmSync(p, { force: true });
      // A directory a deletion leaves empty goes too, so a later write may put a file at its path (D a/b, A a).
      for (let d = dirname(p); d !== '.'; d = dirname(d)) {
        try {
          rmdirSync(d);
        } catch {
          break;
        }
      }
    }
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
