/**
 * Contexto pre-armado para el LLM a partir de una ejecución fallida. Devuelve datos
 * estructurados (qué nodo falló, con qué error, dónde verlo) y una instrucción lista para
 * pegar a un agente/LLM, de modo que el usuario le dé contexto desde el minuto cero del
 * error sin tener que reconstruirlo a mano. Función pura (sin DB): el endpoint le pasa la
 * ejecución ya cargada.
 */

interface NodeResult { nodeId: string; nodeName: string; status: string; error?: string }
interface ExecutionLike {
  id: string;
  workflow_id?: string;
  status?: string;
  executed_at?: string;
  report?: { success?: boolean; nodeResults?: Record<string, NodeResult> };
}

export interface ErrorLlmContext {
  hasError: boolean;
  workflowId?: string;
  workflowName?: string;
  executionId: string;
  status?: string;
  executedAt?: string;
  failedNode?: { id: string; name: string; type?: string; error?: string };
  prompt: string;
}

/** Construye el contexto + la instrucción para el LLM desde una ejecución. */
export function buildExecutionLlmContext(
  execution: ExecutionLike,
  opts: { workflowName?: string; nodeTypeById?: Record<string, string> } = {}
): ErrorLlmContext {
  const results = execution.report?.nodeResults || {};
  const failed = Object.values(results).find(r => r.status === 'failed');
  const workflowName = opts.workflowName || execution.workflow_id || '(desconocido)';

  const failedNode = failed
    ? {
        id: failed.nodeId,
        name: failed.nodeName,
        type: opts.nodeTypeById?.[failed.nodeId],
        error: failed.error,
      }
    : undefined;

  const lines: string[] = [];
  lines.push('Un flujo de LibreFlow ha fallado. Diagnostica la causa raíz y corrige el flujo.');
  lines.push('');
  lines.push(`- Flujo: «${workflowName}»${execution.workflow_id ? ` (id: ${execution.workflow_id})` : ''}`);
  lines.push(`- Ejecución: ${execution.id}${execution.status ? ` (estado: ${execution.status})` : ''}${execution.executed_at ? ` — ${execution.executed_at}` : ''}`);
  if (failedNode) {
    lines.push(`- Nodo que falló: «${failedNode.name}»${failedNode.type ? ` (tipo: ${failedNode.type})` : ''}`);
    lines.push(`- Error: ${failedNode.error || '(sin mensaje)'}`);
  } else {
    lines.push('- No se identificó un nodo fallido concreto; revisa la ejecución completa.');
  }
  lines.push('');
  lines.push('Dónde mirar: abre la ejecución indicada para ver entradas/salidas de cada nodo.');
  lines.push('Usa las herramientas MCP de LibreFlow para leer el flujo y su ejecución, propón el');
  lines.push('cambio MÍNIMO que lo arregla, valida la coherencia del flujo y explica la causa raíz.');

  return {
    hasError: !!failed || execution.report?.success === false,
    workflowId: execution.workflow_id,
    workflowName: opts.workflowName,
    executionId: execution.id,
    status: execution.status,
    executedAt: execution.executed_at,
    failedNode,
    prompt: lines.join('\n'),
  };
}
