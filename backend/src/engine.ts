import { WorkflowNode, executeNode, resolveValue } from './nodes.js';

/** Thrown for workflow-structure problems that are safe and useful to show the user. */
export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowValidationError';
  }
}

/**
 * Thrown by a `wait` node to SUSPEND execution until an external resume. The engine
 * stamps `token`/`waitNodeId`, persists the partial results, and returns a `suspended`
 * report. Resuming replays the already-completed nodes from their cached outputs (no
 * re-execution / no double side effects) and continues from the wait node.
 */
export class WorkflowSuspendError extends Error {
  token = '';
  waitNodeId = '';
  constructor() {
    super('Workflow suspended (waiting for resume)');
    this.name = 'WorkflowSuspendError';
  }
}

/** State needed to resume a suspended run at its wait node. */
export interface ResumeState {
  waitNodeId: string;
  resumePayload: any;
  priorResults: Record<string, NodeExecutionResult>;
}

export interface Connection {
  source: string;
  target: string;
  sourceHandle?: string; // e.g. "true" or "false" for conditional nodes
  targetHandle?: string;
}

export interface Workflow {
  nodes: WorkflowNode[];
  connections: Connection[];
}

export interface ExecutionContext {
  [nodeName: string]: {
    output: any;
  };
}

export interface NodeExecutionResult {
  nodeId: string;
  nodeName: string;
  status: 'success' | 'failed' | 'skipped';
  output?: any;
  pinned?: boolean;          // true when the output came from pinned data (manual run)
  error?: string;
  startTime?: string;
  endTime?: string;
  durationMs?: number;
}

/** Custom HTTP response declared by a `respond` node, emitted by the webhook route. */
export interface HttpResponseIntent {
  status: number;
  headers: Record<string, string>;
  contentType: string;
  body: any;
}

export interface WorkflowExecutionReport {
  success: boolean;
  suspended?: boolean;       // true when a `wait` node paused the run
  resumeToken?: string;      // present when suspended — POST /hooks/resume/:token to continue
  waitNodeId?: string;
  httpResponse?: HttpResponseIntent; // set when a `respond` node ran (synchronous webhook)
  startTime: string;
  endTime: string;
  durationMs: number;
  nodeResults: Record<string, NodeExecutionResult>;
}

/**
 * BFS genérico: conjunto alcanzable desde `seeds` expandiendo por `neighborsOf`, tratando
 * `boundaryId` como frontera infranqueable (ni se incluye ni se expande a través de él).
 */
function reachableSet(
  seeds: string[],
  neighborsOf: (id: string) => string[],
  boundaryId: string
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const s of seeds) {
    if (s !== boundaryId && !seen.has(s)) { seen.add(s); queue.push(s); }
  }
  while (queue.length > 0) {
    const curr = queue.shift()!;
    for (const n of neighborsOf(curr)) {
      if (n === boundaryId || seen.has(n)) continue; // frontera o ya visto
      seen.add(n);
      queue.push(n);
    }
  }
  return seen;
}

export function getLoopBodyNodes(
  loopNodeId: string,
  outgoingConnectionsMap: Map<string, Connection[]>,
  incomingConnectionsMap: Map<string, Connection[]>
): Set<string> {
  // El nodo loop es una FRONTERA: nunca se atraviesa, así que los caminos que salen por
  // 'done'/feedback y reentran (o entran a otros loops) no se filtran al cuerpo. Esencial
  // para el anidamiento. El cuerpo = alcanzables hacia delante por 'loop' ∩ predecesores del feedback.
  const targetsOf = (id: string) => (outgoingConnectionsMap.get(id) || []).map(c => c.target);
  const sourcesOf = (id: string) => (incomingConnectionsMap.get(id) || []).map(c => c.source);

  const loopSeeds = (outgoingConnectionsMap.get(loopNodeId) || [])
    .filter(c => c.sourceHandle === 'loop')
    .map(c => c.target);
  const reachable = reachableSet(loopSeeds, targetsOf, loopNodeId);
  const predecessors = reachableSet(sourcesOf(loopNodeId), sourcesOf, loopNodeId);

  const body = new Set<string>();
  for (const nodeId of reachable) {
    if (predecessors.has(nodeId)) body.add(nodeId);
  }
  body.add(loopNodeId);
  return body;
}

/** Node ids reachable downstream from `fromId` (inclusive), following connections. */
export function descendantsOf(workflow: Workflow, fromId: string): Set<string> {
  const out = new Map<string, string[]>();
  for (const c of workflow.connections || []) {
    const arr = out.get(c.source) || [];
    arr.push(c.target);
    out.set(c.source, arr);
  }
  const seen = new Set<string>([fromId]);
  const stack = [fromId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const t of out.get(id) || []) {
      if (!seen.has(t)) { seen.add(t); stack.push(t); }
    }
  }
  return seen;
}

// waitNodeId centinela que no casa con ningún id de nodo real: hace que el replay reuse las
// salidas previas SIN activar la rama del wait.
const RERUN_SENTINEL = '__lf_rerun_no_wait__';

/**
 * Construye el `ResumeState` para "re-ejecutar desde un nodo": reusa las salidas cacheadas de
 * la última ejecución para todo MENOS el nodo `fromId` y sus descendientes (que se vuelven a
 * ejecutar). El resto del grafo no se toca. Pensado para nodos del grafo principal.
 */
export function buildRerunResume(
  workflow: Workflow,
  fromId: string,
  priorResults: Record<string, NodeExecutionResult>
): ResumeState {
  const desc = descendantsOf(workflow, fromId);
  const filtered: Record<string, NodeExecutionResult> = {};
  for (const [id, r] of Object.entries(priorResults || {})) {
    if (!desc.has(id)) filtered[id] = r;
  }
  return { waitNodeId: RERUN_SENTINEL, resumePayload: undefined, priorResults: filtered };
}

/**
 * Estado compartido de UNA ejecución. Antes vivía como variables capturadas por las closures
 * dentro de execute(); extraerlo a un objeto permite partir la lógica en métodos privados sin
 * cambiar la conducta (los métodos leen/mutan estos campos en vez de variables de cierre).
 */
interface RunCtx {
  workflow: Workflow;
  nodeResults: Record<string, NodeExecutionResult>;
  context: ExecutionContext;
  httpResponse?: HttpResponseIntent;
  nodeMap: Map<string, WorkflowNode>;
  incomingMap: Map<string, Connection[]>;
  outgoingMap: Map<string, Connection[]>;
  loopBodies: Map<string, Set<string>>;
  enclosingLoop: Map<string, string | null>;
  nodeParamOverrides: Map<string, Record<string, any>>;
  mainNodeIds: Set<string>;
  execDepth: number;
  execStack: string[];
  execExecutionId?: string;
  execOwnerId: string | null;
  execIsAdmin: boolean;
  usePinData: boolean;
  resume?: ResumeState;
  MAX_STEPS: number;
  steps: number;
  startTime: Date;
  genToken: () => string;
}

/** Estado efímero de un sub-grafo en curso (grafo principal o una iteración de loop). */
interface SubgraphState {
  nodeIds: Set<string>;
  processed: Set<string>;
  resolvedPaths: Map<string, Map<Connection, 'success' | 'skipped'>>;
  queue: { nodeId: string; status: 'execute' | 'skip' }[];
}

export class WorkflowEngine {
  async execute(
    workflow: Workflow,
    initialPayload: Record<string, any> = {},
    execMeta: { depth?: number; stack?: string[]; executionId?: string; usePinData?: boolean; ownerId?: string | null; isAdmin?: boolean } = {},
    resume?: ResumeState
  ): Promise<WorkflowExecutionReport> {
    const ctx = this.buildRunCtx(workflow, initialPayload, execMeta, resume);

    // --- Run the top-level graph ---
    try {
      await this.runSubgraph(ctx, ctx.mainNodeIds);
    } catch (err: any) {
      if (err instanceof WorkflowSuspendError) {
        const endTime = new Date();
        return {
          success: false,
          suspended: true,
          resumeToken: err.token,
          waitNodeId: err.waitNodeId,
          httpResponse: ctx.httpResponse,
          startTime: ctx.startTime.toISOString(),
          endTime: endTime.toISOString(),
          durationMs: endTime.getTime() - ctx.startTime.getTime(),
          nodeResults: ctx.nodeResults,
        };
      }
      throw err;
    }

    this.reconcileUnrunNodes(ctx);

    const endTime = new Date();
    const allSuccessful = Object.values(ctx.nodeResults).every(r => r.status !== 'failed');

    return {
      success: allSuccessful,
      httpResponse: ctx.httpResponse,
      startTime: ctx.startTime.toISOString(),
      endTime: endTime.toISOString(),
      durationMs: endTime.getTime() - ctx.startTime.getTime(),
      nodeResults: ctx.nodeResults
    };
  }

  /** Construye los mapas de grafo (id→nodo, entrantes y salientes por nodo). */
  private buildGraphMaps(workflow: Workflow) {
    const nodeMap = new Map<string, WorkflowNode>();
    for (const node of workflow.nodes) nodeMap.set(node.id, node);

    const incomingMap = new Map<string, Connection[]>();
    const outgoingMap = new Map<string, Connection[]>();
    for (const node of workflow.nodes) {
      incomingMap.set(node.id, []);
      outgoingMap.set(node.id, []);
    }
    for (const conn of workflow.connections) {
      if (incomingMap.has(conn.target)) incomingMap.get(conn.target)!.push(conn);
      if (outgoingMap.has(conn.source)) outgoingMap.get(conn.source)!.push(conn);
    }
    return { nodeMap, incomingMap, outgoingMap };
  }

  /**
   * Modelo de anidamiento de loops: el cuerpo completo de cada loop, el loop *envolvente*
   * (más interno) de cada nodo y el conjunto del grafo principal. Valida que ningún `wait`
   * viva dentro de un loop (v1: el suspend/resume no checkpointea media iteración).
   */
  private buildLoopModel(
    workflow: Workflow,
    outgoingMap: Map<string, Connection[]>,
    incomingMap: Map<string, Connection[]>
  ) {
    const loopBodies = new Map<string, Set<string>>();
    for (const node of workflow.nodes) {
      if (node.type === 'loop') {
        loopBodies.set(node.id, getLoopBodyNodes(node.id, outgoingMap, incomingMap));
      }
    }

    const enclosingLoop = new Map<string, string | null>();
    for (const node of workflow.nodes) {
      let best: string | null = null;
      let bestSize = Infinity;
      for (const [loopId, body] of loopBodies) {
        if (loopId === node.id) continue; // un loop no se envuelve a sí mismo
        if (body.has(node.id) && body.size < bestSize) {
          best = loopId;
          bestSize = body.size;
        }
      }
      enclosingLoop.set(node.id, best);
    }

    const mainNodeIds = new Set<string>(
      workflow.nodes.filter(n => enclosingLoop.get(n.id) === null).map(n => n.id)
    );

    for (const node of workflow.nodes) {
      if (node.type === 'wait' && enclosingLoop.get(node.id) !== null) {
        throw new WorkflowValidationError('A "wait" node cannot be placed inside a loop.');
      }
    }

    return { loopBodies, enclosingLoop, mainNodeIds };
  }

  /** Ensambla el estado compartido de una ejecución (mapas, modelo de loops, config, overrides). */
  private buildRunCtx(
    workflow: Workflow,
    initialPayload: Record<string, any>,
    execMeta: { depth?: number; stack?: string[]; executionId?: string; usePinData?: boolean; ownerId?: string | null; isAdmin?: boolean },
    resume?: ResumeState
  ): RunCtx {
    const { nodeMap, incomingMap, outgoingMap } = this.buildGraphMaps(workflow);
    const { loopBodies, enclosingLoop, mainNodeIds } = this.buildLoopModel(workflow, outgoingMap, incomingMap);

    // El payload del trigger se inyecta por override (nunca mutando el nodo compartido).
    const nodeParamOverrides = new Map<string, Record<string, any>>();
    for (const node of workflow.nodes) {
      if (node.type === 'trigger') nodeParamOverrides.set(node.id, { payload: initialPayload });
    }

    const wfId = (workflow as any).id;
    return {
      workflow,
      nodeResults: {},
      context: {},
      httpResponse: undefined,
      nodeMap,
      incomingMap,
      outgoingMap,
      loopBodies,
      enclosingLoop,
      nodeParamOverrides,
      mainNodeIds,
      execDepth: execMeta.depth ?? 0,
      execStack: execMeta.stack ?? (wfId ? [wfId] : []),
      execExecutionId: execMeta.executionId,
      execOwnerId: execMeta.ownerId ?? null,     // F2b: dueño del flujo en ejecución
      execIsAdmin: execMeta.isAdmin ?? false,
      usePinData: execMeta.usePinData ?? false,
      resume,
      MAX_STEPS: Math.max(10, Number(process.env.LF_MAX_EXECUTION_STEPS) || 100000),
      steps: 0,
      startTime: new Date(),
      genToken: () => 'rsm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9),
    };
  }

  /** directBody(L) = nodos cuyo loop envolvente más interno es L (los loops anidados se incluyen,
   * pero su contenido no — recursionan aparte). */
  private directBody(ctx: RunCtx, loopId: string): Set<string> {
    const s = new Set<string>();
    for (const node of ctx.workflow.nodes) {
      if (node.id !== loopId && ctx.enclosingLoop.get(node.id) === loopId) s.add(node.id);
    }
    return s;
  }

  /** Ejecuta un nodo NO-loop (con retry / continueOnFail / inputs de merge). */
  private async runNode(
    ctx: RunCtx,
    node: WorkflowNode,
    incomingInputs: Record<string, any>
  ): Promise<{ output: any; ok: boolean }> {
    const settings = node.parameters?.settings || {};
    const continueOnFail = !!settings.continueOnFail;
    const retryOnFail = !!settings.retryOnFail;
    const maxRetries = retryOnFail ? Math.min(5, Math.max(1, Number(settings.maxRetries) || 3)) : 0;
    const retryDelayMs = Math.max(100, Number(settings.retryDelayMs) || 1000);

    const startedAt = new Date();
    let output: any;
    let lastError: any;
    let ok = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`[Engine] Retrying node "${node.name}" (${node.type}) - attempt ${attempt}/${maxRetries} after error: ${lastError?.message}`);
          await new Promise(r => setTimeout(r, retryDelayMs));
        }
        output = await executeNode(
          node,
          ctx.context,
          incomingInputs,
          { depth: ctx.execDepth, stack: ctx.execStack, executionId: ctx.execExecutionId, ownerId: ctx.execOwnerId, isAdmin: ctx.execIsAdmin },
          ctx.nodeParamOverrides.get(node.id)
        );
        ok = true;
        break;
      } catch (err: any) {
        // Una señal de suspend no es un fallo — nunca se reintenta/continueOnFail; burbujea
        // con el id de este nodo estampado para que execute() persista el punto de resume.
        if (err instanceof WorkflowSuspendError) {
          err.waitNodeId = node.id;
          if (!err.token) err.token = ctx.genToken();
          throw err;
        }
        lastError = err;
      }
    }

    const endedAt = new Date();

    if (!ok) {
      if (continueOnFail) {
        console.log(`[Engine] Node "${node.name}" failed, but continuing execution due to continueOnFail.`);
        output = { success: false, error: lastError?.message || 'Unknown error during execution' };
        ctx.nodeResults[node.id] = {
          nodeId: node.id, nodeName: node.name, status: 'success', output,
          startTime: startedAt.toISOString(), endTime: endedAt.toISOString(),
          durationMs: endedAt.getTime() - startedAt.getTime()
        };
      } else {
        // Un WorkflowValidationError (p.ej. de un sub-flujo) debe abortar toda la ejecución.
        if (lastError instanceof WorkflowValidationError) throw lastError;
        ctx.nodeResults[node.id] = {
          nodeId: node.id, nodeName: node.name, status: 'failed',
          error: lastError?.message,
          startTime: startedAt.toISOString(), endTime: endedAt.toISOString(),
          durationMs: endedAt.getTime() - startedAt.getTime()
        };
        ctx.context[node.name] = { output: undefined };
        return { output: undefined, ok: false };
      }
    } else {
      ctx.nodeResults[node.id] = {
        nodeId: node.id, nodeName: node.name, status: 'success', output,
        startTime: startedAt.toISOString(), endTime: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime()
      };
    }

    ctx.context[node.name] = { output };
    return { output, ok: true };
  }

  /** Resuelve los items de un loop (parsea string→JSON; no-array → []) y el batchSize (≥1). */
  private resolveLoopItems(ctx: RunCtx, node: WorkflowNode): { items: any[]; batchSize: number } {
    const resolved = resolveValue(node.parameters, ctx.context);
    let items = resolved.items;
    if (typeof items === 'string') {
      try { items = JSON.parse(items); } catch { items = []; }
    }
    if (!Array.isArray(items)) items = [];
    const batchSize = Math.max(1, Math.floor(Number(resolved.batchSize) || 1));
    return { items, batchSize };
  }

  /** Marca como skipped los nodos del cuerpo que nunca corrieron (p.ej. loop vacío). */
  private markUnrunBodyAsSkipped(ctx: RunCtx, bodyIds: Set<string>): void {
    for (const bId of bodyIds) {
      if (ctx.nodeResults[bId]) continue;
      const bNode = ctx.nodeMap.get(bId);
      if (!bNode) continue;
      ctx.nodeResults[bId] = {
        nodeId: bId, nodeName: bNode.name, status: 'skipped',
        startTime: new Date().toISOString(), endTime: new Date().toISOString(), durationMs: 0
      };
    }
  }

  /** Ejecuta un loop: itera su cuerpo directo como sub-grafo una vez por item (o por lote). */
  private async runLoop(ctx: RunCtx, node: WorkflowNode): Promise<any> {
    // batchSize > 1: itera en LOTES (el cuerpo recibe `items` = el trozo) en vez de uno a uno.
    // Por defecto 1 → clásico item-a-item (`item`/`index`/`isLast`).
    const { items, batchSize } = this.resolveLoopItems(ctx, node);
    const bodyIds = this.directBody(ctx, node.id);

    // El nodo de feedback es el del cuerpo conectado de vuelta al loop.
    const fullBody = ctx.loopBodies.get(node.id)!;
    let feedbackNodeId: string | undefined;
    for (const conn of ctx.incomingMap.get(node.id) || []) {
      if (fullBody.has(conn.source)) { feedbackNodeId = conn.source; break; }
    }

    const results: any[] = [];
    const runIteration = async (output: any) => {
      ctx.context[node.name] = { output };
      await this.runSubgraph(ctx, bodyIds);
      if (feedbackNodeId) {
        const fb = ctx.nodeMap.get(feedbackNodeId);
        if (fb && ctx.context[fb.name]) results.push(ctx.context[fb.name].output);
      }
    };

    if (batchSize <= 1) {
      for (let index = 0; index < items.length; index++) {
        await runIteration({ done: false, item: items[index], index, isLast: index === items.length - 1 });
      }
    } else {
      const batches = Math.ceil(items.length / batchSize);
      for (let b = 0; b < batches; b++) {
        const chunk = items.slice(b * batchSize, (b + 1) * batchSize);
        await runIteration({ done: false, items: chunk, index: b, batchSize: chunk.length, isLast: b === batches - 1 });
      }
    }

    this.markUnrunBodyAsSkipped(ctx, bodyIds);

    const output = { done: true, results };
    ctx.context[node.name] = { output };
    ctx.nodeResults[node.id] = {
      nodeId: node.id, nodeName: node.name, status: 'success', output,
      startTime: new Date().toISOString(), endTime: new Date().toISOString(), durationMs: 0
    };
    return output;
  }

  /** Nº de aristas entrantes a `id` cuyo origen está dentro de este sub-grafo. */
  private internalIncomingCount(ctx: RunCtx, sub: SubgraphState, id: string): number {
    return (ctx.incomingMap.get(id) || []).filter(c => sub.nodeIds.has(c.source)).length;
  }

  /** Propaga el estado de un camino al nodo destino; cuando todos sus caminos internos están
   * resueltos, lo encola para ejecutar (si alguno fue success) o skip. */
  private propagate(ctx: RunCtx, sub: SubgraphState, conn: Connection, pathStatus: 'success' | 'skipped') {
    if (!sub.nodeIds.has(conn.target)) return; // la arista sale del sub-grafo
    const res = sub.resolvedPaths.get(conn.target)!;
    res.set(conn, pathStatus);
    if (res.size === this.internalIncomingCount(ctx, sub, conn.target)) {
      const anySuccess = Array.from(res.values()).includes('success');
      sub.queue.push({ nodeId: conn.target, status: anySuccess ? 'execute' : 'skip' });
    }
  }

  /** Estado del camino de una arista saliente según el routing del nodo (if/switch). */
  private pathStatusFor(node: WorkflowNode, output: any, conn: Connection): 'success' | 'skipped' {
    if (node.type === 'if') {
      const r = output?.result;
      if (conn.sourceHandle === 'true' && !r) return 'skipped';
      if (conn.sourceHandle === 'false' && r) return 'skipped';
    } else if (node.type === 'switch') {
      if (conn.sourceHandle !== output?.matched) return 'skipped';
    }
    return 'success';
  }

  /** Inputs de un nodo merge: acumula por handle para no perder aristas del mismo handle. */
  private buildMergeInputs(ctx: RunCtx, node: WorkflowNode): Record<string, any> {
    const handleArrays: Record<string, any[]> = {};
    for (const conn of ctx.incomingMap.get(node.id) || []) {
      const src = ctx.nodeMap.get(conn.source);
      if (src) {
        const handle = conn.targetHandle || 'input1';
        (handleArrays[handle] ||= []).push(ctx.context[src.name]?.output);
      }
    }
    const incomingInputs: Record<string, any> = {};
    for (const h of Object.keys(handleArrays)) {
      incomingInputs[h] = handleArrays[h].length === 1 ? handleArrays[h][0] : handleArrays[h];
    }
    return incomingInputs;
  }

  /**
   * Replay de resume: no re-ejecuta el trabajo hecho antes del suspend. El nodo `wait` "devuelve"
   * el payload de resume; el resto reutiliza sus salidas cacheadas. Devuelve true si lo manejó.
   */
  private replayResumed(ctx: RunCtx, sub: SubgraphState, node: WorkflowNode): boolean {
    const resume = ctx.resume!;
    if (node.id === resume.waitNodeId) {
      const now = new Date().toISOString();
      const output = resume.resumePayload;
      ctx.context[node.name] = { output };
      ctx.nodeResults[node.id] = { nodeId: node.id, nodeName: node.name, status: 'success', output, startTime: now, endTime: now, durationMs: 0 };
      for (const conn of ctx.outgoingMap.get(node.id) || []) this.propagate(ctx, sub, conn, 'success');
      return true;
    }
    const prior = resume.priorResults[node.id];
    if (!prior) return false;

    ctx.nodeResults[node.id] = prior;
    if (node.type === 'respond' && prior.status === 'success' && prior.output?._lfHttpResponse) {
      ctx.httpResponse = prior.output._lfHttpResponse;
    }
    if (prior.status === 'skipped') {
      for (const conn of ctx.outgoingMap.get(node.id) || []) this.propagate(ctx, sub, conn, 'skipped');
    } else {
      ctx.context[node.name] = { output: prior.output };
      for (const conn of ctx.outgoingMap.get(node.id) || []) {
        this.propagate(ctx, sub, conn, this.pathStatusFor(node, prior.output, conn));
      }
    }
    return true;
  }

  /** Datos pinneados (solo runs manuales): usa la salida guardada en vez de ejecutar el nodo. */
  private emitPinned(ctx: RunCtx, sub: SubgraphState, node: WorkflowNode) {
    const now = new Date().toISOString();
    const output = node.pinData;
    ctx.context[node.name] = { output };
    ctx.nodeResults[node.id] = { nodeId: node.id, nodeName: node.name, status: 'success', output, pinned: true, startTime: now, endTime: now, durationMs: 0 };
    for (const conn of ctx.outgoingMap.get(node.id) || []) {
      this.propagate(ctx, sub, conn, this.pathStatusFor(node, output, conn));
    }
  }

  /** Propaga las salidas de un nodo ya ejecutado (respeta routing if/switch y el fallo). */
  private propagateAfterRun(ctx: RunCtx, sub: SubgraphState, node: WorkflowNode, output: any, ok: boolean) {
    for (const conn of ctx.outgoingMap.get(node.id) || []) {
      // Un nodo (de rama o no) que falló sin continueOnFail → omite aguas abajo.
      if (!ok) {
        this.propagate(ctx, sub, conn, 'skipped');
        continue;
      }
      this.propagate(ctx, sub, conn, this.pathStatusFor(node, output, conn));
    }
  }

  /** Procesa un nodo desencolado del sub-grafo (resume / skip / pin / loop / merge / ejecución). */
  private async processSubgraphNode(ctx: RunCtx, sub: SubgraphState, node: WorkflowNode, status: 'execute' | 'skip') {
    // Replay de resume: reutiliza salidas previas al suspend.
    if (ctx.resume && this.replayResumed(ctx, sub, node)) return;

    if (status === 'skip') {
      const at = new Date().toISOString();
      ctx.nodeResults[node.id] = { nodeId: node.id, nodeName: node.name, status: 'skipped', startTime: at, endTime: at, durationMs: 0 };
      for (const conn of ctx.outgoingMap.get(node.id) || []) this.propagate(ctx, sub, conn, 'skipped');
      return;
    }

    if (ctx.usePinData && node.type !== 'loop' && node.pinData !== undefined) {
      this.emitPinned(ctx, sub, node);
      return;
    }

    if (node.type === 'loop') {
      await this.runLoopNode(ctx, sub, node);
      return;
    }

    const incomingInputs = node.type === 'merge' ? this.buildMergeInputs(ctx, node) : {};
    const { output, ok } = await this.runNode(ctx, node, incomingInputs);
    this.captureRespond(ctx, node, output, ok);
    this.propagateAfterRun(ctx, sub, node, output, ok);
  }

  /** Ejecuta un nodo loop y propaga sus salidas (la rama 'loop'/cuerpo se queda dentro de runLoop). */
  private async runLoopNode(ctx: RunCtx, sub: SubgraphState, node: WorkflowNode) {
    await this.runLoop(ctx, node);
    for (const conn of ctx.outgoingMap.get(node.id) || []) {
      if (conn.sourceHandle === 'loop') continue;
      this.propagate(ctx, sub, conn, 'success');
    }
  }

  /** Un nodo `respond` declara la respuesta HTTP síncrona para la ruta del webhook. */
  private captureRespond(ctx: RunCtx, node: WorkflowNode, output: any, ok: boolean) {
    if (ok && node.type === 'respond' && output && output._lfHttpResponse) {
      ctx.httpResponse = output._lfHttpResponse;
    }
  }

  /**
   * Ejecuta un sub-grafo acíclico (el grafo principal o una iteración de loop). Solo procesa
   * nodos en `nodeIds`; las aristas hacia/desde fuera se ignoran para el conteo de joins.
   */
  private async runSubgraph(ctx: RunCtx, nodeIds: Set<string>): Promise<void> {
    const sub: SubgraphState = { nodeIds, processed: new Set(), resolvedPaths: new Map(), queue: [] };
    for (const id of nodeIds) sub.resolvedPaths.set(id, new Map());
    for (const id of nodeIds) {
      if (this.internalIncomingCount(ctx, sub, id) === 0) sub.queue.push({ nodeId: id, status: 'execute' });
    }

    while (sub.queue.length > 0) {
      if (++ctx.steps > ctx.MAX_STEPS) {
        throw new WorkflowValidationError(
          `Workflow execution exceeded the maximum step limit (${ctx.MAX_STEPS}). ` +
          `This usually indicates an infinite loop in the workflow graph.`
        );
      }
      const { nodeId, status } = sub.queue.shift()!;
      if (sub.processed.has(nodeId)) continue;
      sub.processed.add(nodeId);
      const node = ctx.nodeMap.get(nodeId);
      if (!node) continue;
      await this.processSubgraphNode(ctx, sub, node, status);
    }
  }

  /**
   * Reconcilia nodos que nunca produjeron resultado: dentro del cuerpo de un loop que no corrió
   * → skipped; en el grafo principal sin camino → unreachable/ciclo → failed.
   */
  private reconcileUnrunNodes(ctx: RunCtx): void {
    for (const node of ctx.workflow.nodes) {
      if (ctx.nodeResults[node.id]) continue;
      const inLoopBody = ctx.enclosingLoop.get(node.id) !== null;
      const at = ctx.startTime.toISOString();
      ctx.nodeResults[node.id] = inLoopBody
        ? { nodeId: node.id, nodeName: node.name, status: 'skipped', startTime: at, endTime: at, durationMs: 0 }
        : {
            nodeId: node.id, nodeName: node.name, status: 'failed',
            error: 'Workflow node was not executed. This could be due to a cyclic dependency in your workflow.',
            startTime: at, endTime: at, durationMs: 0
          };
    }
  }
}
