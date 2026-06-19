import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { initDatabase, saveDataTable, addDataTableRow } from '../src/db.js';
import { indexVectors, searchVectors } from '../src/vectorStore.js';
import { NodeRegistry } from '../src/registry.js';

// Embedding DETERMINISTA de prueba: cuenta keywords -> vector 4-d. Así la similitud es predecible
// sin depender de un modelo real (el endpoint se stubea).
const KW = ['perro', 'gato', 'coche', 'casa'];
const fakeEmbed = (text: string) => KW.map(k => text.toLowerCase().split(k).length - 1);

function stubFetch() {
  return vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const data = body.input.map((t: string) => ({ embedding: fakeEmbed(t) }));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data }) } as any;
  });
}

describe('vectorStore (RAG)', () => {
  beforeAll(async () => { await initDatabase(); });
  afterEach(() => vi.unstubAllGlobals());

  const cfg = { endpoint: 'http://localhost:9999/v1', model: 'fake-embed' };
  const owner = 'owner-vs';
  const col = 'vs-' + Math.random().toString(36).slice(2, 7);

  it('indexa textos y busca por similitud (top-K, con metadata)', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const r = await indexVectors(owner, col, [
      { id: 'd1', text: 'el perro corre en el parque', metadata: { tema: 'animal' } },
      { id: 'd2', text: 'el gato duerme todo el dia', metadata: { tema: 'animal' } },
      { id: 'd3', text: 'el coche es rojo y rapido', metadata: { tema: 'vehiculo' } },
    ], cfg);
    expect(r.indexed).toBe(3);
    expect(r.dim).toBe(4);

    const matches = await searchVectors(owner, col, 'mi perro juega', 2, cfg);
    expect(matches.length).toBe(2);
    expect(matches[0].id).toBe('d1');                 // el más similar (perro)
    expect(matches[0].metadata.tema).toBe('animal');
    expect(matches[0].score).toBeGreaterThan(matches[1].score); // orden por score desc
  });

  it('persiste entre instancias (recargado desde SQLite)', async () => {
    vi.stubGlobal('fetch', stubFetch());
    // Sin re-indexar: la búsqueda lee los vectores guardados en la 1ª prueba.
    const matches = await searchVectors(owner, col, 'coche veloz', 1, cfg);
    expect(matches[0].id).toBe('d3');
  });

  it('aísla por dueño: otro owner no ve la colección', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const matches = await searchVectors('otro-owner', col, 'perro', 5, cfg);
    expect(matches.length).toBe(0);
  });

  it('indexTable: indexa las filas de una data table (columna de texto) y luego busca', async () => {
    vi.stubGlobal('fetch', stubFetch());
    const tableId = 'tbl-vs-' + Math.random().toString(36).slice(2, 7);
    const tcol = 'kbtbl-' + Math.random().toString(36).slice(2, 7);
    await saveDataTable(tableId, tableId, [{ name: 'contenido', type: 'string' }], null, owner);
    await addDataTableRow(tableId, 'r1', { contenido: 'el perro ladra fuerte' });
    await addDataTableRow(tableId, 'r2', { contenido: 'el coche acelera' });
    await addDataTableRow(tableId, 'r3', { contenido: '' }); // sin texto -> se omite

    const node = NodeRegistry.getNodeType('vectorStore')!;
    const r: any = await node.execute(
      { operation: 'indexTable', collection: tcol, tableId, textColumn: 'contenido', endpoint: cfg.endpoint, model: cfg.model, authentication: 'none' },
      {} as any, {} as any, { ownerId: owner, isAdmin: false } as any
    );
    expect(r.indexed).toBe(2); // la fila vacía se omite

    const matches = await searchVectors(owner, tcol, 'mi perro', 1, cfg);
    expect(matches[0].id).toBe('r1');                 // id = id de la fila
    expect(matches[0].metadata._rowId).toBe('r1');    // metadata conserva la fila
  });
});
