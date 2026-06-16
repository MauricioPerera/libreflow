import { NodeRegistry } from './registry.js';

/**
 * Validador de coherencia de flujo. Comprueba ESTRUCTURA (no ejecuta nada): tipos de nodo
 * existentes, conexiones a nodos/handles válidos, y —lo más útil— que las expresiones
 * `{{ $node.Nombre.output... }}` apunten a nodos que existen (atrapa el fallo silencioso
 * clásico: renombras un nodo y las expresiones quedan colgando). Pensado para correr al
 * guardar (avisa, no bloquea) y tras un fix en lote, antes de dar el flujo por bueno.
 */

export interface FlowIssue {
  level: 'error' | 'warning';
  code: string;
  nodeId?: string;
  nodeName?: string;
  message: string;
}

export interface FlowValidationResult {
  ok: boolean;           // true si no hay issues de nivel 'error'
  errors: number;
  warnings: number;
  issues: FlowIssue[];
}

interface WfNode { id: string; type: string; name: string; parameters?: Record<string, any> }
interface WfConn { source: string; target: string; sourceHandle?: string; targetHandle?: string }
interface Wf { nodes?: WfNode[]; connections?: WfConn[] }

/** Extrae los nombres de nodo referenciados en una cadena vía {{ $node.NOMBRE.output... }}. */
function extractNodeRefs(text: string): string[] {
  const refs: string[] = [];
  const re = /\{\{\s*\$node\.([^.}]+)\.output/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    refs.push(m[1].trim());
  }
  return refs;
}

/** Recorre un valor (objeto/array/string) acumulando todas las referencias a nodos. */
function collectRefs(value: any, acc: Set<string>): void {
  if (typeof value === 'string') {
    for (const r of extractNodeRefs(value)) acc.add(r);
  } else if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, acc);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectRefs(v, acc);
  }
}

/** Conjunto de handles de salida válidos de un nodo según su definición en el registro. */
function validOutputHandles(type: string): Set<string> {
  const def = NodeRegistry.getNodeType(type);
  const outs = def?.ui?.outputs;
  const set = new Set<string>();
  if (outs && outs.length) {
    for (const o of outs) set.add(o.id || 'main');
  } else {
    set.add('main');
  }
  // Una conexión sin handle explícito equivale a la salida principal.
  set.add('main');
  return set;
}

export function validateWorkflow(workflow: Wf): FlowValidationResult {
  const issues: FlowIssue[] = [];
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const connections = Array.isArray(workflow?.connections) ? workflow.connections : [];

  const byId = new Map<string, WfNode>();
  const nameCount = new Map<string, number>();
  const names = new Set<string>();

  for (const n of nodes) {
    if (!n || typeof n.id !== 'string') {
      issues.push({ level: 'error', code: 'NODE_NO_ID', message: 'Hay un nodo sin id.' });
      continue;
    }
    if (byId.has(n.id)) {
      issues.push({ level: 'error', code: 'DUP_ID', nodeId: n.id, message: `Id de nodo duplicado: "${n.id}".` });
    }
    byId.set(n.id, n);
    if (n.name) {
      nameCount.set(n.name, (nameCount.get(n.name) || 0) + 1);
      names.add(n.name);
    }
    if (!NodeRegistry.getNodeType(n.type)) {
      issues.push({ level: 'error', code: 'UNKNOWN_TYPE', nodeId: n.id, nodeName: n.name, message: `Tipo de nodo desconocido: "${n.type}".` });
    }
  }

  // Nombres duplicados → las expresiones {{ $node.Nombre }} se vuelven ambiguas.
  for (const [name, count] of nameCount) {
    if (count > 1) {
      issues.push({ level: 'warning', code: 'DUP_NAME', nodeName: name, message: `El nombre de nodo "${name}" está repetido ${count} veces; las expresiones que lo referencien son ambiguas.` });
    }
  }

  // Trigger presente.
  if (nodes.length && !nodes.some(n => n.type === 'trigger')) {
    issues.push({ level: 'warning', code: 'NO_TRIGGER', message: 'El flujo no tiene ningún nodo "trigger" (punto de inicio).' });
  }

  // Conexiones: extremos existentes + handle de salida válido.
  for (const c of connections) {
    if (!c || !byId.has(c.source)) {
      issues.push({ level: 'error', code: 'CONN_BAD_SOURCE', message: `Conexión con origen inexistente: "${c?.source}".` });
      continue;
    }
    if (!byId.has(c.target)) {
      issues.push({ level: 'error', code: 'CONN_BAD_TARGET', message: `Conexión con destino inexistente: "${c?.target}".` });
      continue;
    }
    if (c.sourceHandle) {
      const src = byId.get(c.source)!;
      const valid = validOutputHandles(src.type);
      if (!valid.has(c.sourceHandle)) {
        issues.push({
          level: 'warning', code: 'BAD_HANDLE', nodeId: src.id, nodeName: src.name,
          message: `La conexión usa la salida "${c.sourceHandle}" que no existe en "${src.name}" (${src.type}). Salidas válidas: ${[...valid].join(', ')}.`
        });
      }
    }
  }

  // Expresiones que referencian nodos inexistentes (el fallo del rename).
  for (const n of nodes) {
    const refs = new Set<string>();
    collectRefs(n.parameters, refs);
    for (const ref of refs) {
      if (!names.has(ref)) {
        issues.push({
          level: 'error', code: 'BAD_EXPR_REF', nodeId: n.id, nodeName: n.name,
          message: `El nodo "${n.name}" referencia {{ $node.${ref}.output... }} pero no existe ningún nodo llamado "${ref}" (¿lo renombraste?).`
        });
      }
    }
  }

  const errors = issues.filter(i => i.level === 'error').length;
  const warnings = issues.length - errors;
  return { ok: errors === 0, errors, warnings, issues };
}
