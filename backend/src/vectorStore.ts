// Vector store / RAG dentro de LibreFlow. Motor: js-vector-store (zero-dep). Los vectores viven
// en el propio SQLite (tabla vector_store) — el adaptador de la lib es SÍNCRONO, así que se opera
// sobre un MemoryStorageAdapter que se HIDRATA desde SQLite (async) antes y se PERSISTE después.
// Owner-scoped: cada colección es por dueño (aislamiento F2).
import pkg from 'js-vector-store';
import { assertSafeUrl, safeFetch } from './security.js';
import { getVectorFiles, upsertVectorFile } from './db.js';

const { VectorStore, MemoryStorageAdapter } = pkg as any;

export interface EmbedConfig {
  endpoint: string;                      // base OpenAI-compatible, p.ej. http://localhost:1234/v1
  model: string;
  headers?: Record<string, string>;      // auth ya resuelta por el nodo (no se maneja secreto aquí)
}

export interface VectorMatch { id: string; score: number; metadata: any }

const binFile = (c: string) => `${c}.bin`;
const jsonFile = (c: string) => `${c}.json`;

/** Genera embeddings vía un endpoint OpenAI-compatible (`POST <endpoint>/embeddings`). SSRF-guarded. */
export async function embedTexts(texts: string[], cfg: EmbedConfig): Promise<number[][]> {
  if (!cfg.endpoint) throw new Error('Vector store: falta el endpoint de embeddings.');
  if (!cfg.model) throw new Error('Vector store: falta el modelo de embeddings.');
  const url = `${cfg.endpoint.replace(/\/$/, '')}/embeddings`;
  await assertSafeUrl(url);
  const res = await safeFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.headers || {}) },
    body: JSON.stringify({ model: cfg.model, input: texts }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Vector store: el endpoint de embeddings falló (HTTP ${res.status}): ${t.slice(0, 200)}`);
  }
  const json: any = await res.json();
  if (!Array.isArray(json?.data)) throw new Error('Vector store: respuesta de embeddings sin "data".');
  return json.data.map((d: any) => d.embedding);
}

/** Carga los ficheros (<col>.bin/.json) de una colección de un dueño en un MemoryStorageAdapter. */
async function hydrate(ownerId: string | null, collection: string): Promise<any> {
  const mem = new MemoryStorageAdapter();
  const files = await getVectorFiles(ownerId, [binFile(collection), jsonFile(collection)]);
  for (const f of files) {
    if (f.filename.endsWith('.bin')) {
      const buf = f.data;
      mem.writeBin(f.filename, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    } else {
      mem.writeJson(f.filename, JSON.parse(f.data.toString('utf8')));
    }
  }
  return mem;
}

/** Persiste los ficheros de la colección desde el MemoryStorageAdapter al SQLite. */
async function persist(ownerId: string | null, collection: string, mem: any): Promise<void> {
  const bin = mem.readBin(binFile(collection));
  if (bin) await upsertVectorFile(ownerId, collection, binFile(collection), Buffer.from(bin));
  const json = mem.readJson(jsonFile(collection));
  if (json) await upsertVectorFile(ownerId, collection, jsonFile(collection), Buffer.from(JSON.stringify(json)));
}

/** Indexa items {id?, text, metadata?} en una colección: embebe el texto y guarda los vectores. */
export async function indexVectors(
  ownerId: string | null,
  collection: string,
  items: Array<{ id?: string; text: string; metadata?: any }>,
  cfg: EmbedConfig
): Promise<{ indexed: number; dim: number }> {
  const list = (items || []).filter(it => it && (it.text ?? '') !== '');
  if (!list.length) throw new Error('Vector store: "items" vacío (cada item necesita "text").');
  const texts = list.map(it => String(it.text));
  const vectors = await embedTexts(texts, cfg);
  const dim = vectors[0]?.length;
  if (!dim) throw new Error('Vector store: el endpoint no devolvió embeddings.');

  const mem = await hydrate(ownerId, collection);
  const store = new VectorStore(mem, dim);
  list.forEach((it, idx) => {
    const id = String(it.id ?? `v-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`);
    store.set(collection, id, vectors[idx], it.metadata ?? { text: texts[idx] });
  });
  store.flush();
  await persist(ownerId, collection, mem);
  return { indexed: list.length, dim };
}

/** Busca en una colección por similitud con el texto de consulta (embebe la query). top-K. */
export async function searchVectors(
  ownerId: string | null,
  collection: string,
  query: string,
  topK: number,
  cfg: EmbedConfig,
  metric: 'cosine' | 'euclidean' | 'dotProduct' | 'manhattan' = 'cosine'
): Promise<VectorMatch[]> {
  if (!query) throw new Error('Vector store: falta el texto de consulta.');
  const [qVec] = await embedTexts([query], cfg);
  if (!qVec) throw new Error('Vector store: no se pudo embeber la consulta.');
  const mem = await hydrate(ownerId, collection);
  const store = new VectorStore(mem, qVec.length);
  const limit = Math.max(1, Math.min(100, Number(topK) || 5));
  return store.search(collection, qVec, limit, undefined, metric) as VectorMatch[];
}
