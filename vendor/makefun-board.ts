// make.fun's dashboard-dossier library for Node 22: one file, the Node standard library
// only, erasable TypeScript, so it runs as-is under `node main.ts` with no flags, no build
// and no install. It lives at vendor/makefun-board.ts in this repository and is imported as:
//
//   import { buildDossier } from './vendor/makefun-board.ts';
//   writeFileSync('/output/dossier.json', buildDossier('/output', { text_max_bytes: 65536 }));
//
// The bounty's scorer runs this same file, byte for byte, on what is handed in, and requires
// the dossier.json to equal what buildDossier writes from the dashboard/ and screenshots/.
//
//   buildDossier(dir, caps)  the dossier (makefun/dossier/v1) of a dashboard directory, as
//                            canonical JSON bytes: the screenshots plus a text of the page's
//                            source
//
// A dossier is one JSON object (contracts/dossier.ts):
//
//   schema   "makefun/dossier/v1"
//   cover    0: the first screenshot by name is the cover
//   images   the PNG and JPEG files in dir/screenshots/ (names starting with '.' skipped),
//            in name order, each {name, media_type, sha256, base64}
//   text     what the judge reads: a "## Dashboard" block (the file count, the bytes, and
//            every file's path with its size), then "## Source", each text file's path, size
//            and line count and its contents in a fenced block by path, every file by path
//
// The text holds at most caps.text_max_bytes UTF-8 bytes: every file that fits goes in whole,
// in path order; the first that does not goes in up to its last complete line that fits (its
// fence closed, then a line naming how many of its lines are not shown), or not at all when
// not one line fits; nothing follows it but a last line naming how many whole files and how
// many bytes were left out. A file whose extension is not one of .html .css .js .json .mjs
// .svg .md .txt is named in the Dashboard block and not shown: the text is source, and the
// page's images are not source.
//
// buildDossier refuses (DossierError) an empty screenshots/ directory, a screenshot name a
// dossier refuses, a screenshot that is not a whole PNG or JPEG, a screenshot past its byte
// cap or more screenshots than the count cap, a dashboard file that is not plain (a link, a
// dot-directory, a name that is not letters, digits and . _ -, a file past its byte cap or
// more files than the count cap), a text cap that cannot hold the Dashboard block and the cut
// line, and a dossier past DOSSIER_MAX_BYTES. The caps only refuse: they never shape the
// bytes. Only text_max_bytes shapes them, so a program that passes {text_max_bytes} and
// writes the result has written what the scorer, given its other caps too, compares byte
// for byte.

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';

/** The dossier schema buildDossier writes (contracts/dossier.ts DOSSIER_SCHEMA). */
export const DOSSIER_SCHEMA = 'makefun/dossier/v1';
/** The most bytes a dossier holds (contracts/dossier.ts DOSSIER_MAX_BYTES): 4 MiB. */
export const DOSSIER_MAX_BYTES = 4 * 1024 * 1024;
/** The most images a dossier holds (contracts/dossier.ts DOSSIER_MAX_IMAGES). */
export const DOSSIER_MAX_IMAGES = 8;
/** A plain file's name (contracts/dossier.ts DossierImageName): a letter, digit or _ first, then letters, digits and . _ -, 1 to 128 of them, no directory. */
export const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
/** A dashboard file whose contents the dossier's text shows: source, never an image. */
export const TEXT_FILE = /\.(?:html|css|js|json|mjs|svg|md|txt)$/;

/** What buildDossier is held to: the text's cap in UTF-8 bytes, and, when given, the screenshot and dashboard caps, which only refuse. */
export interface DossierCaps {
  text_max_bytes: number;
  screenshots?: { max: number; max_bytes: number };
  dashboard?: { max_files: number; max_bytes: number };
}

/** Why buildDossier writes no dossier for a directory: its caps, its screenshots, its dashboard or its size. */
export class DossierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DossierError';
  }
}

// ---------------------------------------------------------------- small pieces

/** The sha256 of `bytes`, as lowercase hex. */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Strings in code-unit order: -1, 0 or 1. The sort order of every list the dossier writes. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A string's length in UTF-8 bytes. */
function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/** Whether `bytes` starts with every byte of `magic`. */
function opensWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
}

/**
 * A regular file's bytes when it is at most `cap` long; never through a link, never more
 * than `cap` bytes read. A link, a directory or a missing file is a DossierError with `what`.
 * The size is checked twice — once from the directory entry, once from the opened file —
 * so a file that grows between the two checks is refused rather than half-read.
 */
function readCapped(path: string, cap: number, what: string): Uint8Array {
  let size: number;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) throw new DossierError(`buildDossier: ${what} is not a regular file`);
    size = st.size;
  } catch (err) {
    if (err instanceof DossierError) throw err;
    throw new DossierError(`buildDossier: ${what} cannot be read`);
  }
  if (size > cap) throw new DossierError(`buildDossier: ${what} is ${size} bytes, over the ${cap} a dossier reads`);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new DossierError(`buildDossier: ${what} is not a regular file`);
  }
  try {
    const now = fstatSync(fd).size;
    if (now > cap) throw new DossierError(`buildDossier: ${what} is ${now} bytes, over the ${cap} a dossier reads`);
    const buf = Buffer.alloc(now);
    let at = 0;
    while (at < buf.length) {
      const n = readSync(fd, buf, at, buf.length - at, at);
      if (n === 0) break;
      at += n;
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, at);
  } finally {
    closeSync(fd);
  }
}

/** Lines of a text: 0 when empty, else its newlines plus one for a last line with none. */
function lineCount(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let n = 0;
  for (const b of bytes) if (b === 0x0a) n++;
  return bytes[bytes.length - 1] === 0x0a ? n : n + 1;
}

/** A Markdown fence one backtick longer than the longest run in `body`, three at least. */
function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** The fence a file's extension is shown with (.mjs files read as js). */
function languageOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1);
  return ext === 'mjs' ? 'js' : ext;
}

/**
 * JSON with every object's keys in code-unit order and no whitespace: one spelling per
 * value. Takes null, booleans, finite numbers, strings, arrays and plain objects; throws
 * TypeError on anything else (undefined, a function, a bigint, NaN, Infinity, a class
 * instance).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: ${value} is not a finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('canonicalJson: only plain objects and arrays');
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort(byCodeUnit)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  throw new TypeError(`canonicalJson: a ${typeof value} has no JSON form`);
}

// ---------------------------------------------------------------- the dashboard walk

/** One file of the dashboard tree: its path relative to the directory, and its size in bytes. */
interface DashFile {
  path: string;
  size: number;
}

/**
 * Every regular file under `root` (symbolic links are neither followed nor taken for files),
 * in path order, with its size. Refuses a dot-directory, a file whose name a dossier
 * refuses, an entry that is neither a file nor a directory, and, when the caps are given,
 * too many files or bytes in all. The walk is a stack over directories; the final sort is
 * what fixes the order, so the walk's own order never reaches the dossier.
 */
function dashboardFiles(root: string, caps: { max_files: number; max_bytes: number } | null): DashFile[] {
  let st: import('node:fs').Stats;
  try {
    st = lstatSync(root);
  } catch {
    throw new DossierError('buildDossier: no dashboard/ directory: the page and its source are what the judge reads');
  }
  if (!st.isDirectory()) throw new DossierError('buildDossier: dashboard is not a directory');
  const out: DashFile[] = [];
  let bytes = 0;
  const stack: string[] = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    for (const e of readdirSync(rel === '' ? root : join(root, rel), { withFileTypes: true })) {
      const p = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) throw new DossierError(`buildDossier: dashboard/${p} is a dot-directory`);
        stack.push(p);
      } else if (e.isFile()) {
        if (!PLAIN_NAME.test(e.name)) throw new DossierError(`buildDossier: dashboard/${p}: a file's name is letters, digits and . _ -, 1 to 128 characters, not starting with . or -`);
        const size = lstatSync(join(root, p)).size;
        out.push({ path: p, size });
        bytes += size;
        if (caps !== null && out.length > caps.max_files) throw new DossierError(`buildDossier: dashboard/ holds more than the ${caps.max_files} files it may`);
        if (caps !== null && bytes > caps.max_bytes) throw new DossierError(`buildDossier: dashboard/'s files come to more than the ${caps.max_bytes} bytes they may`);
      } else {
        throw new DossierError(`buildDossier: dashboard/${p} is neither a file nor a directory`);
      }
    }
  }
  return out.sort((a, b) => byCodeUnit(a.path, b.path));
}

// ---------------------------------------------------------------- the dossier text

/** A shown file as the dossier shows it: its heading, its fenced block, and their sizes. */
interface ShownFile {
  /** The file's bytes, and its text decoded as UTF-8. */
  bytes: Uint8Array;
  text: string;
  /** The fence that wraps the text, and the language the fence opens with. */
  fence: string;
  lang: string;
  /** The fenced block: fence and language, the text (a last LF added when it lacks one), the fence, a blank line. */
  block: string;
  /** The block's length in UTF-8 bytes, and the file's line count. */
  blockBytes: number;
  lines: number;
}

/** One section of the dossier's text: its heading, its shown file (null when empty), its byte sizes. */
interface Section {
  heading: string;
  code: ShownFile | null;
  /** Heading plus block, in UTF-8 bytes. */
  size: number;
  /** The file's own byte length (what the cut line counts). */
  bytes: number;
}

/** The text's "## Dashboard" block: file count, total bytes, every file's path with its size. */
function dashboardHead(files: DashFile[]): string {
  return [
    '## Dashboard',
    '',
    `Files: ${files.length} (${files.reduce((n, f) => n + f.size, 0)} bytes)`,
    ...files.map((f) => `- ${f.path} (${f.size} bytes)`),
    '',
    '## Source',
    '',
    '',
  ].join('\n');
}

/** The sections for the dashboard's text files, by path: heading plus fenced block each. */
function textSections(dir: string, files: DashFile[]): Section[] {
  return files
    .filter((f) => TEXT_FILE.test(f.path))
    .map((f) => {
      const bytes = readCapped(join(dir, 'dashboard', f.path), DOSSIER_MAX_BYTES, `dashboard/${f.path}`);
      const lines = lineCount(bytes);
      const heading = `### ${f.path}\n\n${bytes.length} bytes, ${lines} line${lines === 1 ? '' : 's'}\n\n`;
      if (bytes.length === 0) return { heading, code: null, size: byteLength(heading), bytes: 0 };
      const text = new TextDecoder('utf-8').decode(bytes);
      const fence = fenceFor(text);
      const lang = languageOf(f.path);
      const block = `${fence}${lang}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
      return { heading, code: { bytes, text, fence, lang, block, blockBytes: byteLength(block), lines }, size: byteLength(heading) + byteLength(block), bytes: bytes.length };
    });
}

/** The text's last line: how many whole files and bytes the cap left out. */
function cutLine(max: number, count: number, bytes: number): string {
  return `[Cut at ${max} bytes: ${count} file${count === 1 ? '' : 's'} and ${bytes} bytes left out.]\n`;
}

/**
 * A file's section cut inside its contents: its heading, its first k lines in its fence
 * (closed), a line naming how many of its lines are not shown, then `tail(hidden)` (the cut
 * line, given the bytes this file leaves out), k the most lines (at least one, fewer than
 * all) whose whole fits in `room` UTF-8 bytes; null when not one line fits. It cuts only
 * after a line's LF, which is never inside a UTF-8 sequence nor a replacement character's
 * bytes, so no character is split, and a line's shown bytes are those of its text.
 */
function fileHead(heading: string, code: ShownFile, room: number, tail: (hidden: number) => string): string | null {
  const total = code.lines;
  const lines = code.text.split('\n');
  const open = `${code.fence}${code.lang}\n`;
  const close = `${code.fence}\n\n`;
  const note = (k: number): string => `[${total - k} of this file's ${total} lines not shown.]\n`;
  const fixed = byteLength(heading) + byteLength(open) + byteLength(close);
  let best = 0;
  let shown = 0;
  let raw = 0;
  for (let k = 1; k < total; k++) {
    shown += byteLength(lines[k - 1]!) + 1;
    raw = code.bytes.indexOf(0x0a, raw) + 1;
    if (fixed + shown + byteLength(note(k)) + byteLength(tail(code.bytes.length - raw)) <= room) best = k;
  }
  if (best === 0) return null;
  let rawEnd = 0;
  for (let k = 0; k < best; k++) rawEnd = code.bytes.indexOf(0x0a, rawEnd) + 1;
  const head = lines.slice(0, best).map((l) => `${l}\n`).join('');
  return `${heading}${open}${head}${close}${note(best)}${tail(code.bytes.length - rawEnd)}`;
}

/**
 * The dossier's text: the Dashboard block, then each text file's section in path order,
 * whole while it fits, cut at the cap by the rule above. `restBytes[k]` is the bytes of the
 * shown files after section k, which the cut line reports alongside the files left out.
 */
function dossierText(files: DashFile[], sections: Section[], dir: string, max: number): string {
  const head = dashboardHead(files);
  const restBytes = new Array<number>(sections.length + 1).fill(0);
  for (let k = sections.length - 1; k >= 0; k--) restBytes[k] = restBytes[k + 1]! + (k + 1 < sections.length ? sections[k + 1]!.bytes : 0);

  let out = head;
  let used = byteLength(head);
  if (used + byteLength(cutLine(max, 0, 0)) > max) throw new DossierError(`buildDossier: caps.text_max_bytes ${max} cannot hold even the Dashboard block and the cut line`);
  let kept = 0;
  for (; kept < sections.length; kept++) {
    const section = sections[kept]!;
    const restCount = sections.length - kept - 1;
    const tail = restCount === 0 ? 0 : byteLength(cutLine(max, restCount, restBytes[kept]!));
    if (used + section.size + tail > max) break;
    out += section.code === null ? section.heading : `${section.heading}${section.code.block}`;
    used += section.size;
  }
  if (kept < sections.length) {
    // The first file that does not fit whole: its head, up to its last complete line that fits, then nothing more.
    const first = sections[kept]!;
    const restCount = sections.length - kept - 1;
    const after = restBytes[kept]!;
    const part = first.code === null ? null : fileHead(first.heading, first.code, max - used, (hidden) => cutLine(max, restCount, after + hidden));
    out += part ?? cutLine(max, restCount + 1, after + first.bytes);
  }
  if (byteLength(out) > max) throw new DossierError(`buildDossier: caps.text_max_bytes ${max} cannot hold even the Dashboard block and the cut line`);
  return out;
}

// ---------------------------------------------------------------- the dossier

/** The caps a caller passes, checked and reduced to the tighter of the caller's and the dossier's own. */
function checkedCaps(caps: DossierCaps): { textMax: number; maxImages: number; maxImageBytes: number; fileCaps: { max_files: number; max_bytes: number } | null } {
  const max = caps.text_max_bytes;
  if (!Number.isSafeInteger(max) || max <= 0) throw new DossierError(`buildDossier: caps.text_max_bytes must be a positive integer, not ${String(max)}`);

  let maxImages = DOSSIER_MAX_IMAGES;
  let maxImageBytes = DOSSIER_MAX_BYTES;
  if (caps.screenshots !== undefined) {
    const s = caps.screenshots as { max?: unknown; max_bytes?: unknown } | null;
    if (typeof s !== 'object' || s === null) throw new DossierError('buildDossier: caps.screenshots must be an object {max, max_bytes}');
    for (const k of ['max', 'max_bytes'] as const) {
      const v = s[k];
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new DossierError(`buildDossier: caps.screenshots.${k} must be a positive integer, not ${String(v)}`);
    }
    if ((s.max as number) < maxImages) maxImages = s.max as number;
    if ((s.max_bytes as number) < maxImageBytes) maxImageBytes = s.max_bytes as number;
  }
  let fileCaps: { max_files: number; max_bytes: number } | null = null;
  if (caps.dashboard !== undefined) {
    const d = caps.dashboard as { max_files?: unknown; max_bytes?: unknown } | null;
    if (typeof d !== 'object' || d === null) throw new DossierError('buildDossier: caps.dashboard must be an object {max_files, max_bytes}');
    for (const k of ['max_files', 'max_bytes'] as const) {
      const v = d[k];
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new DossierError(`buildDossier: caps.dashboard.${k} must be a positive integer, not ${String(v)}`);
    }
    fileCaps = { max_files: d.max_files as number, max_bytes: d.max_bytes as number };
  }
  return { textMax: max, maxImages, maxImageBytes, fileCaps };
}

/** The dossier's images: dir/screenshots/'s PNG and JPEG files, in name order. */
function dossierImages(dir: string, maxImages: number, maxImageBytes: number): { name: string; media_type: string; sha256: string; base64: string }[] {
  const shotsDir = join(dir, 'screenshots');
  let shotNames: string[];
  try {
    shotNames = readdirSync(shotsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort(byCodeUnit);
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') throw new DossierError('buildDossier: no screenshots/ directory: the first screenshot is the cover');
    throw new DossierError('buildDossier: screenshots/ cannot be read');
  }
  if (shotNames.length === 0) throw new DossierError('buildDossier: screenshots/ holds no image: the first is the cover');
  if (shotNames.length > maxImages) throw new DossierError(`buildDossier: screenshots/ holds ${shotNames.length} files, over the ${maxImages} a dossier holds`);
  return shotNames.map((name) => {
    if (!PLAIN_NAME.test(name)) throw new DossierError(`buildDossier: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters, not starting with . or -`);
    const bytes = readCapped(join(shotsDir, name), maxImageBytes, `screenshots/${name}`);
    const media_type = opensWith(bytes, PNG_MAGIC) ? 'image/png' : opensWith(bytes, JPEG_MAGIC) ? 'image/jpeg' : null;
    if (media_type === null) throw new DossierError(`buildDossier: screenshots/${name} is neither a PNG nor a JPEG`);
    return { name, media_type, sha256: sha256Hex(bytes), base64: Buffer.from(bytes).toString('base64') };
  });
}

/**
 * The dossier (makefun/dossier/v1, contracts/dossier.ts) of a dashboard directory, as
 * canonical JSON bytes: `dir/screenshots/`'s PNG and JPEG files (names starting with '.'
 * skipped) are its images, the first the cover; its text is the "## Dashboard" block and the
 * "## Source" sections described above, capped at `caps.text_max_bytes` UTF-8 bytes with the
 * cut rule above. Throws DossierError on caps it cannot keep and on a dashboard or
 * screenshots directory it refuses (see the header).
 */
export function buildDossier(dir: string, caps: DossierCaps): Uint8Array {
  const { textMax, maxImages, maxImageBytes, fileCaps } = checkedCaps(caps);
  const files = dashboardFiles(join(dir, 'dashboard'), fileCaps);
  const images = dossierImages(dir, maxImages, maxImageBytes);
  const sections = textSections(dir, files);
  const text = dossierText(files, sections, dir, textMax);

  const doc = { schema: DOSSIER_SCHEMA, cover: 0, text: text.replace(/\n+$/, '\n'), images };
  const bytes = Buffer.from(canonicalJson(doc), 'utf8');
  if (bytes.length > DOSSIER_MAX_BYTES) throw new DossierError(`buildDossier: the dossier is ${bytes.length} bytes, over the ${DOSSIER_MAX_BYTES} one holds`);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}
