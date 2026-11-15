/**
 * Embedded vector store (spec Phase 1.2): in-process, zero-dependency cosine-similarity search.
 *
 * The in-memory LocalVectorStore is the spec's class. PersistentVectorStore wraps it so entries survive restarts:
 * every upsert is written to SQLite (vector_entries, Float32 BLOB) and the memory index is rebuilt on load.
 * Embeddings from different models are never compared: each store is keyed by (tenant, collection, embedding model)
 * and rejects vectors whose dimension does not match.
 *
 * Scale: brute-force scan, O(n·d) per query. Fine to ~50k entries per tenant; beyond that use an ANN index
 * (sqlite-vec, pgvector). See docs/SHORTCUTS.md.
 */
import { all, run, type Db } from './db.ts';
import { shared } from './shared.ts';
import { clock } from './clock.ts';

export interface VectorEntry {
  id: string;
  text: string;
  embedding: number[];
  metadata: {
    vinPrefix: string;
    model: string;
    customerComplaint: string;
    aiPredicted: string;
    technicianDiagnosis: string;
    technicianAction: string;
    wasOverride: boolean;
    laborCode: string;
    date: string;
  };
}

export class LocalVectorStore {
  private entries: VectorEntry[] = [];

  public upsert(entry: VectorEntry): void {
    const idx = this.entries.findIndex((e) => e.id === entry.id);
    if (idx >= 0) this.entries[idx] = entry;
    else this.entries.push(entry);
  }

  public search(queryEmbedding: number[], topK = 3, filter?: (m: VectorEntry['metadata']) => boolean): Array<{ entry: VectorEntry; similarity: number }> {
    const results: Array<{ entry: VectorEntry; similarity: number }> = [];
    for (const e of this.entries) {
      if (filter && !filter(e.metadata)) continue;
      const sim = cosineSimilarity(queryEmbedding, e.embedding);
      results.push({ entry: e, similarity: sim });
    }
    return results.sort((a, b) => b.similarity - a.similarity).slice(0, topK);
  }

  public get size(): number {
    return this.entries.length;
  }
}

/** Cosine similarity. Vectors of different length are incomparable (different models) and score 0. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

const toBlob = (v: number[]): Uint8Array => new Uint8Array(Float32Array.from(v).buffer);
const fromBlob = (b: Uint8Array): number[] => Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));

/** SQLite-backed store for one (tenant, collection, embedding model). */
export class PersistentVectorStore {
  private readonly mem = new LocalVectorStore();
  private dim: number | null = null;
  private readonly db: Db;
  readonly tenantId: string;
  readonly collection: string;
  readonly model: string;

  private constructor(db: Db, tenantId: string, collection: string, model: string) {
    this.db = db;
    this.tenantId = tenantId;
    this.collection = collection;
    this.model = model;
  }

  static load(db: Db, tenantId: string, collection: string, model: string): PersistentVectorStore {
    const s = new PersistentVectorStore(db, tenantId, collection, model);
    for (const r of all<{ id: string; text: string; dim: number; embedding: Uint8Array; metadata: string }>(db,
      'SELECT id, text, dim, embedding, metadata FROM vector_entries WHERE tenant_id = ? AND collection = ? AND model = ?', tenantId, collection, model)) {
      s.dim ??= Number(r.dim);
      s.mem.upsert({ id: r.id, text: r.text, embedding: fromBlob(r.embedding), metadata: JSON.parse(r.metadata) });
    }
    return s;
  }

  upsert(entry: VectorEntry): void {
    if (entry.embedding.length === 0) throw new Error('empty embedding');
    if (this.dim != null && entry.embedding.length !== this.dim) throw new Error(`embedding dimension ${entry.embedding.length} does not match store dimension ${this.dim}`);
    this.dim ??= entry.embedding.length;
    run(this.db, `INSERT INTO vector_entries (id, tenant_id, collection, model, dim, text, embedding, metadata, created_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, collection, model, id) DO UPDATE SET text = excluded.text, dim = excluded.dim, embedding = excluded.embedding, metadata = excluded.metadata`,
      entry.id, this.tenantId, this.collection, this.model, entry.embedding.length, entry.text, toBlob(entry.embedding) as never, JSON.stringify(entry.metadata), clock.iso());
    this.mem.upsert(entry);
  }

  search(queryEmbedding: number[], topK = 3, filter?: (m: VectorEntry['metadata']) => boolean): Array<{ entry: VectorEntry; similarity: number }> {
    if (this.dim != null && queryEmbedding.length !== this.dim) return [];
    return this.mem.search(queryEmbedding, topK, filter);
  }

  get size(): number {
    return this.mem.size;
  }
}

/** Process-wide cache of loaded stores, keyed by db handle + tenant + collection + model. */
const cache = shared('vectorStores', () => new WeakMap<Db, Map<string, PersistentVectorStore>>());

export function vectorStore(db: Db, tenantId: string, collection: string, model: string): PersistentVectorStore {
  let m = cache.get(db);
  if (!m) cache.set(db, (m = new Map()));
  const key = `${tenantId}\u0000${collection}\u0000${model}`;
  let s = m.get(key);
  if (!s) m.set(key, (s = PersistentVectorStore.load(db, tenantId, collection, model)));
  return s;
}
