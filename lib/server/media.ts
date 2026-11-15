/**
 * Media intake (HLD 04 §3): magic-byte validation (never trust extensions), size caps,
 * JPEG EXIF/APP1 stripping (removes GPS), content-addressed local storage, retention deletion.
 * ClamAV and re-encoding are not in the MVP; see docs/SHORTCUTS.md.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { all, run, type Db } from './db.ts';

export type MediaKind = 'image' | 'audio';
export interface Sniffed { kind: MediaKind; mime: string }

export function sniff(buf: Buffer): Sniffed | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'image', mime: 'image/jpeg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image', mime: 'image/png' };
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (buf.length >= 4 && buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { kind: 'audio', mime: 'audio/webm' };
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'OggS') return { kind: 'audio', mime: 'audio/ogg' };
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WAVE') return { kind: 'audio', mime: 'audio/wav' };
  if (buf.length >= 8 && buf.subarray(4, 8).toString('ascii') === 'ftyp') return { kind: 'audio', mime: 'audio/mp4' };
  if (buf.length >= 3 && (buf.subarray(0, 3).toString('ascii') === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0))) return { kind: 'audio', mime: 'audio/mpeg' };
  return null;
}

/** Removes JPEG APP1 segments (EXIF/XMP, which can hold GPS). Other segments are untouched. */
export function stripJpegMetadata(buf: Buffer): Buffer {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
  const out: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    if (marker === 0xda) { // start of scan: copy the rest verbatim
      out.push(buf.subarray(i));
      return Buffer.concat(out);
    }
    const len = buf.readUInt16BE(i + 2);
    const segment = buf.subarray(i, i + 2 + len);
    if (marker !== 0xe1) out.push(segment);
    i += 2 + len;
  }
  return Buffer.concat(out);
}

export interface Accepted { kind: MediaKind; mime: string; bytes: Buffer; sha256: string; strippedBytes: number }

export function validateUpload(buf: Buffer, caps: { imageBytes: number; audioBytes: number }): Accepted | { error: string } {
  const s = sniff(buf);
  if (!s) return { error: 'unsupported or unrecognised file type' };
  const cap = s.kind === 'image' ? caps.imageBytes : caps.audioBytes;
  if (buf.length === 0) return { error: 'empty file' };
  if (buf.length > cap) return { error: `file exceeds ${Math.round(cap / 1024 / 1024)} MB limit` };
  const clean = s.mime === 'image/jpeg' ? stripJpegMetadata(buf) : buf;
  return { kind: s.kind, mime: s.mime, bytes: clean, sha256: createHash('sha256').update(clean).digest('hex'), strippedBytes: buf.length - clean.length };
}

export class MediaStore {
  private readonly root: string;
  private readonly db: Db;
  constructor(dataDir: string, db: Db) {
    this.root = resolve(dataDir, 'media');
    this.db = db;
  }

  save(tenantId: string, caseId: string, acc: Accepted, retainUntil: Date): { id: string; path: string } {
    const dir = join(this.root, tenantId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${acc.sha256}.bin`);
    if (!existsSync(path)) writeFileSync(path, acc.bytes, { mode: 0o600 });
    const id = `${caseId}:${acc.sha256.slice(0, 16)}`;
    run(this.db, `INSERT OR IGNORE INTO media (id, tenant_id, case_id, kind, path, sha256, bytes, mime, created_at, retention_until)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, id, tenantId, caseId, acc.kind, path, acc.sha256, acc.bytes.length, acc.mime, new Date().toISOString(), retainUntil.toISOString());
    return { id, path };
  }

  /** Deletes files past retention (HLD 0.7). Rows are kept with deleted_at for audit. */
  purgeExpired(now: Date): number {
    const rows = all<{ id: string; path: string }>(this.db,
      `SELECT id, path FROM media WHERE deleted_at IS NULL AND retention_until < ?`, now.toISOString());
    for (const r of rows) {
      try { unlinkSync(r.path); } catch { /* already gone */ }
      run(this.db, `UPDATE media SET deleted_at = ? WHERE id = ?`, now.toISOString(), r.id);
    }
    return rows.length;
  }
}
