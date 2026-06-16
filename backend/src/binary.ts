import crypto from 'node:crypto';
import { saveBinary } from './db.js';

/**
 * Manejo de binarios. Los bytes NO viven en el JSON de salida del nodo (que se persiste y
 * alimenta MCP/agente): se guardan en la tabla `binaries` y la salida del nodo lleva una
 * referencia ligera. Cualquier nodo aguas abajo detecta la referencia y carga los bytes.
 */

export interface BinaryRef {
  _lfBinary: string;   // id en la tabla binaries
  fileName?: string;
  mimeType?: string;
  size: number;
}

/** Tope de tamaño por binario (se guarda en SQLite, se lee en memoria). */
export const MAX_BINARY_BYTES = Math.max(1, Number(process.env.LF_MAX_BINARY_MB) || 16) * 1024 * 1024;

/** ¿El valor es una referencia a binario? */
export function isBinaryRef(v: any): v is BinaryRef {
  return !!v && typeof v === 'object' && typeof v._lfBinary === 'string' && typeof v.size === 'number';
}

/**
 * Guarda bytes en el store y devuelve la referencia a incluir en la salida del nodo.
 * Lanza si excede el tope configurado.
 */
export async function storeBinary(
  data: Buffer,
  opts: { executionId?: string | null; fileName?: string | null; mimeType?: string | null } = {}
): Promise<BinaryRef> {
  if (data.length > MAX_BINARY_BYTES) {
    throw new Error(`El binario (${data.length} bytes) supera el tope LF_MAX_BINARY_MB (${MAX_BINARY_BYTES} bytes).`);
  }
  const id = 'bin-' + crypto.randomBytes(12).toString('hex');
  await saveBinary(id, opts.executionId ?? null, opts.fileName ?? null, opts.mimeType ?? null, data);
  return {
    _lfBinary: id,
    fileName: opts.fileName ?? undefined,
    mimeType: opts.mimeType ?? undefined,
    size: data.length,
  };
}

/**
 * Lee el cuerpo de una respuesta a un Buffer SIN bufferizar más de `maxBytes`. Evita el OOM
 * de `response.arrayBuffer()/text()` (que cargan todo en memoria) si un endpoint envía —o
 * miente sobre— una respuesta enorme. Pre-chequea Content-Length y corta el stream al superar.
 */
export async function readResponseCapped(res: { headers: { get(n: string): string | null }; body: any }, maxBytes: number): Promise<Buffer> {
  const len = res.headers.get('content-length');
  if (len && Number(len) > maxBytes) {
    throw new Error(`La respuesta (${len} bytes) supera el tope LF_MAX_BINARY_MB (${maxBytes} bytes).`);
  }
  const reader = res.body?.getReader?.();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* */ }
      throw new Error(`La respuesta supera el tope LF_MAX_BINARY_MB (${maxBytes} bytes).`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Deriva un nombre de fichero razonable desde una URL (para descargas sin Content-Disposition). */
export function fileNameFromUrl(url: string): string | undefined {
  try {
    const p = new URL(url).pathname;
    const last = p.split('/').filter(Boolean).pop();
    return last || undefined;
  } catch {
    return undefined;
  }
}
