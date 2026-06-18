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

/** Parámetros obligatorios por tipo de nodo (su ausencia impide ejecutar). */
const REQUIRED_PARAMS: Record<string, string[]> = {
  httpRequest: ['url'],
  executeWorkflow: ['targetWorkflowId'],
  mcpToolCall: ['serverUrl', 'toolName'],
};

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
    } else {
      // Parámetros obligatorios ausentes (antes solo lo comprobaba el validador del MCP).
      for (const p of REQUIRED_PARAMS[n.type] || []) {
        const v = n.parameters?.[p];
        if (v === undefined || v === null || String(v).trim() === '') {
          issues.push({ level: 'error', code: 'REQUIRED_PARAM', nodeId: n.id, nodeName: n.name, message: `Falta el parámetro requerido "${p}" en el nodo "${n.name}".` });
        }
      }
    }
  }

  // Nombres duplicados → las expresiones {{ $node.Nombre }} se vuelven ambiguas.
  for (const [name, count] of nameCount) {
    if (count > 1) {
      issues.push({ level: 'warning', code: 'DUP_NAME', nodeName: name, message: `El nombre de nodo "${name}" está repetido ${count} veces; las expresiones que lo referencien son ambiguas.` });
    }
  }

  // Trigger: exactamente uno. 0 o >1 impiden una ejecución coherente (antes el validador
  // del MCP marcaba esto como error y el de la UI solo avisaba; ahora es un único criterio).
  const triggers = nodes.filter(n => n.type === 'trigger');
  if (nodes.length && triggers.length === 0) {
    issues.push({ level: 'error', code: 'NO_TRIGGER', message: 'El flujo debe contener exactamente un nodo Trigger (Inicio).' });
  } else if (triggers.length > 1) {
    issues.push({ level: 'error', code: 'MULTIPLE_TRIGGERS', message: `El flujo contiene múltiples nodos Trigger (${triggers.map(t => t.name || t.id).join(', ')}). Solo se permite uno.` });
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

  // Alcanzabilidad desde el único trigger (BFS). Nodos desconectados → aviso.
  if (triggers.length === 1) {
    const adjacency = new Map<string, string[]>();
    for (const n of nodes) adjacency.set(n.id, []);
    for (const c of connections) if (adjacency.has(c.source)) adjacency.get(c.source)!.push(c.target);
    const visited = new Set<string>([triggers[0].id]);
    const queue = [triggers[0].id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nb of adjacency.get(cur) || []) if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
    }
    for (const n of nodes) {
      if (!visited.has(n.id)) {
        issues.push({ level: 'warning', code: 'UNREACHABLE', nodeId: n.id, nodeName: n.name, message: 'Este nodo está desconectado y nunca será ejecutado.' });
      }
    }
  }

  // Ciclos que NO pasan por el handle 'loop' de un nodo loop (esos son retroalimentación legítima).
  const cyc = new Map<string, string[]>();
  for (const n of nodes) cyc.set(n.id, []);
  for (const c of connections) {
    const src = byId.get(c.source);
    if (src && src.type === 'loop' && c.sourceHandle === 'loop') continue;
    if (cyc.has(c.source)) cyc.get(c.source)!.push(c.target);
  }
  const state = new Map<string, 0 | 1 | 2>(); // 0=sin visitar, 1=en pila, 2=hecho
  for (const n of nodes) state.set(n.id, 0);
  const dfs = (id: string): boolean => {
    state.set(id, 1);
    for (const nb of cyc.get(id) || []) {
      const s = state.get(nb);
      if (s === 1) return true;
      if (s === 0 && dfs(nb)) return true;
    }
    state.set(id, 2);
    return false;
  };
  let hasCycle = false;
  for (const n of nodes) { if (state.get(n.id) === 0 && dfs(n.id)) { hasCycle = true; break; } }
  if (hasCycle) {
    issues.push({ level: 'error', code: 'CYCLE', message: 'Se ha detectado una dependencia cíclica (bucle infinito) en las conexiones del flujo.' });
  }

  const errors = issues.filter(i => i.level === 'error').length;
  const warnings = issues.length - errors;
  return { ok: errors === 0, errors, warnings, issues };
}

export interface BatchValidationItem extends FlowValidationResult {
  id: string;
  name: string;
}

export interface BatchValidationResult {
  summary: { total: number; withErrors: number; withWarnings: number };
  workflows: BatchValidationItem[];
}

/**
 * Valida muchos flujos de una (el patrón "arregla en una sesión todos los flujos que pegan a
 * una misma API"): por flujo devuelve su resultado, más un resumen agregado.
 */
export function validateWorkflows(
  list: Array<{ id: string; name: string; nodes?: WfNode[]; connections?: WfConn[] }>
): BatchValidationResult {
  const workflows = (list || []).map(w => ({
    id: w.id,
    name: w.name,
    ...validateWorkflow(w),
  }));
  return {
    summary: {
      total: workflows.length,
      withErrors: workflows.filter(w => w.errors > 0).length,
      withWarnings: workflows.filter(w => w.warnings > 0).length,
    },
    workflows,
  };
}
