/**
 * Primitivas de transformación de colecciones (el track que MCP/agente no cubren bien:
 * lógica local, barata y determinista). Funciones puras usadas por los nodos `filter`,
 * `aggregate` y `switch`. Sin DB, sin estado — fáciles de testear.
 */

/** Lee un campo por ruta con puntos ("a.b.c"); ruta vacía = el propio elemento. */
export function getPath(obj: any, path?: string): any {
  if (!path) return obj;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Compara dos valores con un operador. Igualdad laxa (5 == "5"); orden numérico. */
export function compareValues(a: any, op: string, b: any): boolean {
  const aS = a == null ? '' : String(a);
  const bS = b == null ? '' : String(b);
  const aN = Number(a);
  const bN = Number(b);
  const isEmpty = (v: any) => v == null || (typeof v === 'string' && v === '') || (Array.isArray(v) && v.length === 0);
  switch (op) {
    case 'equal': return a == b || aS === bS;
    case 'notEqual': return !(a == b || aS === bS);
    case 'contains': return aS.includes(bS);
    case 'notContains': return !aS.includes(bS);
    case 'startsWith': return aS.startsWith(bS);
    case 'endsWith': return aS.endsWith(bS);
    case 'greaterThan': return aN > bN;
    case 'greaterOrEqual': return aN >= bN;
    case 'lessThan': return aN < bN;
    case 'lessOrEqual': return aN <= bN;
    case 'isEmpty': return isEmpty(a);
    case 'isNotEmpty': return !isEmpty(a);
    case 'isTrue': return a === true || aS === 'true';
    case 'isFalse': return a === false || aS === 'false';
    default: return false;
  }
}

const asArray = (items: any): any[] => (Array.isArray(items) ? items : []);

export interface FilterOptions { field?: string; operator?: string; value?: any }
export interface FilterResult { items: any[]; kept: number; removed: number; total: number }

/** Conserva los elementos que cumplen la condición. */
export function filterItems(items: any, opts: FilterOptions): FilterResult {
  const arr = asArray(items);
  const kept = arr.filter(it => compareValues(getPath(it, opts.field), opts.operator || 'equal', opts.value));
  return { items: kept, kept: kept.length, removed: arr.length - kept.length, total: arr.length };
}

export interface Aggregation { field?: string; fn: 'count' | 'sum' | 'avg' | 'min' | 'max'; as?: string }

function computeAgg(rows: any[], agg: Aggregation): any {
  if (agg.fn === 'count') return rows.length;
  const nums = rows.map(r => Number(getPath(r, agg.field))).filter(n => Number.isFinite(n));
  if (nums.length === 0) return agg.fn === 'sum' ? 0 : null;
  switch (agg.fn) {
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min': return Math.min(...nums);
    case 'max': return Math.max(...nums);
    default: return null;
  }
}

/** Agrupa (opcional) y aplica agregaciones (count/sum/avg/min/max). Devuelve un array de grupos. */
export function summarize(items: any, opts: { groupBy?: string; aggregations?: Aggregation[] }): any[] {
  const arr = asArray(items);
  const aggs = opts.aggregations && opts.aggregations.length ? opts.aggregations : [{ fn: 'count' as const }];
  const groups = new Map<string, any[]>();
  if (opts.groupBy) {
    for (const it of arr) {
      const k = String(getPath(it, opts.groupBy));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(it);
    }
  } else {
    groups.set('__all__', arr);
  }
  const out: any[] = [];
  for (const [key, rows] of groups) {
    const rec: Record<string, any> = {};
    if (opts.groupBy) rec[opts.groupBy] = rows.length ? getPath(rows[0], opts.groupBy) : key;
    for (const agg of aggs) {
      rec[agg.as || `${agg.fn}_${agg.field || 'all'}`] = computeAgg(rows, agg);
    }
    out.push(rec);
  }
  return out;
}

/** Ordena por campo (numérico si ambos lo son, si no alfabético). No muta el original. */
export function sortItems(items: any, opts: { field?: string; dir?: 'asc' | 'desc' }): any[] {
  const arr = [...asArray(items)];
  const mul = opts.dir === 'desc' ? -1 : 1;
  arr.sort((a, b) => {
    const av = getPath(a, opts.field);
    const bv = getPath(b, opts.field);
    const an = Number(av);
    const bn = Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * mul;
    return String(av ?? '').localeCompare(String(bv ?? '')) * mul;
  });
  return arr;
}

/** Primeros N elementos (offset opcional). */
export function limitItems(items: any, n: number, offset = 0): any[] {
  const arr = asArray(items);
  const start = Math.max(0, offset);
  const count = Math.max(0, n);
  return arr.slice(start, start + count);
}

/** Elimina duplicados por campo (o por el elemento entero si no se da campo). Conserva el primero. */
export function uniqueItems(items: any, opts: { field?: string }): any[] {
  const arr = asArray(items);
  const seen = new Set<string>();
  const out: any[] = [];
  for (const it of arr) {
    const k = opts.field ? String(getPath(it, opts.field)) : JSON.stringify(it);
    if (!seen.has(k)) { seen.add(k); out.push(it); }
  }
  return out;
}
