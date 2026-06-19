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
 * Computes a loop's body: nodes that are both reachable from the loop's 'loop' handle
 * and predecessors of the loop node (i.e. they feed back into it). The loop node itself
 * is included so callers can treat the body as a self-contained unit.
 */
export function getLoopBodyNodes(
  loopNodeId: string,
  outgoingConnectionsMap: Map<string, Connection[]>,
  incomingConnectionsMap: Map<string, Connection[]>
): Set<string> {
  // Forward reachability from the loop's 'loop' output. The loop node is a BOUNDARY:
  // we never traverse THROUGH it, so paths that exit via 'done'/feedback and re-enter
  // the loop (or other loops) don't leak into this body. This is essential for nesting.
  const reachable = new Set<string>();
  const queue: string[] = [];

  const outConns = outgoingConnectionsMap.get(loopNodeId) || [];
  for (const conn of outConns) {
    if (conn.sourceHandle === 'loop' && conn.target !== loopNodeId) {
      if (!reachable.has(conn.target)) {
        reachable.add(conn.target);
        queue.push(conn.target);
      }
    }
  }

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const conns = outgoingConnectionsMap.get(curr) || [];
    for (const conn of conns) {
      if (conn.target === loopNodeId) continue; // boundary: don't expand through the loop
      if (!reachable.has(conn.target)) {
        reachable.add(conn.target);
        queue.push(conn.target);
      }
    }
  }

  // Backward reachability from the loop's feedback inputs, with the same boundary rule.
  const predecessors = new Set<string>();
  const predQueue: string[] = [];

  const inConns = incomingConnectionsMap.get(loopNodeId) || [];
  for (const conn of inConns) {
    if (conn.source !== loopNodeId && !predecessors.has(conn.source)) {
      predecessors.add(conn.source);
      predQueue.push(conn.source);
    }
  }

  while (predQueue.length > 0) {
    const curr = predQueue.shift()!;
    const conns = incomingConnectionsMap.get(curr) || [];
    for (const conn of conns) {
      if (conn.source === loopNodeId) continue; // boundary
      if (!predecessors.has(conn.source)) {
        predecessors.add(conn.source);
        predQueue.push(conn.source);
      }
    }
  }

  const body = new Set<string>();
  for (const nodeId of reachable) {
    if (predecessors.has(nodeId)) {
      body.add(nodeId);
    }
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

export class WorkflowEngine {
  async execute(
    workflow: Workflow,
    initialPayload: Record<string, any> = {},
    execMeta: { depth?: number; stack?: string[]; executionId?: string; usePinData?: boolean; ownerId?: string | null; isAdmin?: boolean } = {},
    resume?: ResumeState
  ): Promise<WorkflowExecutionReport> {
    const genToken = () => 'rsm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
    const startTime = new Date();
    const nodeResults: Record<string, NodeExecutionResult> = {};
    const context: ExecutionContext = {};

    // Captured from a `respond` node when it runs (the webhook route emits it). Last one wins.
    let httpResponse: HttpResponseIntent | undefined;

    // Sub-workflow recursion guard metadata (threaded to executeWorkflow nodes).
    const execDepth = execMeta.depth ?? 0;
    const wfId = (workflow as any).id;
    const execStack = execMeta.stack ?? (wfId ? [wfId] : []);
    const execExecutionId = execMeta.executionId;
    const execOwnerId = execMeta.ownerId ?? null;     // F2b: dueño del flujo en ejecución
    const execIsAdmin = execMeta.isAdmin ?? false;
    const usePinData = execMeta.usePinData ?? false;

    // --- Build helper maps ---
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

    // --- Loop nesting model ---
    // Each loop's full body, then the *enclosing* (innermost) loop of every node.
    // Loops are executed by recursively running their "direct body" as an isolated
    // sub-graph per iteration; this collapses every loop to a single node in its
    // parent graph, so each sub-graph is acyclic and nesting works naturally.
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
        if (loopId === node.id) continue; // a loop is not enclosed by itself
        if (body.has(node.id) && body.size < bestSize) {
          best = loopId;
          bestSize = body.size;
        }
      }
      enclosingLoop.set(node.id, best);
    }

    // directBody(L) = nodes whose innermost enclosing loop is L (nested loop nodes are
    // included, but the contents of nested loops are not — they recurse separately).
    const directBody = (loopId: string): Set<string> => {
      const s = new Set<string>();
      for (const node of workflow.nodes) {
        if (node.id !== loopId && enclosingLoop.get(node.id) === loopId) s.add(node.id);
      }
      return s;
    };
    const mainNodeIds = new Set<string>(
      workflow.nodes.filter(n => enclosingLoop.get(n.id) === null).map(n => n.id)
    );

    // v1 limitation: a `wait` node must live in the main graph (suspend/resume does not
    // checkpoint mid-loop-iteration).
    for (const node of workflow.nodes) {
      if (node.type === 'wait' && enclosingLoop.get(node.id) !== null) {
        throw new WorkflowValidationError('A "wait" node cannot be placed inside a loop.');
      }
    }

    // Trigger payload is injected via override (never by mutating the shared node).
    const nodeParamOverrides = new Map<string, Record<string, any>>();
    for (const node of workflow.nodes) {
      if (node.type === 'trigger') {
        nodeParamOverrides.set(node.id, { payload: initialPayload });
      }
    }

    // Hard safety cap against runaway executions. Tunable via LF_MAX_EXECUTION_STEPS.
    const MAX_STEPS = Math.max(10, Number(process.env.LF_MAX_EXECUTION_STEPS) || 100000);
    let steps = 0;

    /** Executes a single non-loop node (with retry / continueOnFail / merge inputs). */
    const runNode = async (
      node: WorkflowNode,
      incomingInputs: Record<string, any>
    ): Promise<{ output: any; ok: boolean }> => {
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
            context,
            incomingInputs,
            { depth: execDepth, stack: execStack, executionId: execExecutionId, ownerId: execOwnerId, isAdmin: execIsAdmin },
            nodeParamOverrides.get(node.id)
          );
          ok = true;
          break;
        } catch (err: any) {
          // A suspend signal is not a failure — never retry/continueOnFail it; bubble up
          // with this node's id stamped so execute() can persist the resume point.
          if (err instanceof WorkflowSuspendError) {
            err.waitNodeId = node.id;
            if (!err.token) err.token = genToken();
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
          nodeResults[node.id] = {
            nodeId: node.id, nodeName: node.name, status: 'success', output,
            startTime: startedAt.toISOString(), endTime: endedAt.toISOString(),
            durationMs: endedAt.getTime() - startedAt.getTime()
          };
        } else {
          // A WorkflowValidationError (e.g. from a sub-workflow) must abort the whole run.
          if (lastError instanceof WorkflowValidationError) throw lastError;
          nodeResults[node.id] = {
            nodeId: node.id, nodeName: node.name, status: 'failed',
            error: lastError?.message,
            startTime: startedAt.toISOString(), endTime: endedAt.toISOString(),
            durationMs: endedAt.getTime() - startedAt.getTime()
          };
          context[node.name] = { output: undefined };
          return { output: undefined, ok: false };
        }
      } else {
        nodeResults[node.id] = {
          nodeId: node.id, nodeName: node.name, status: 'success', output,
          startTime: startedAt.toISOString(), endTime: endedAt.toISOString(),
          durationMs: endedAt.getTime() - startedAt.getTime()
        };
      }

      context[node.name] = { output };
      return { output, ok: true };
    };

    /** Runs a loop node: iterates its direct body sub-graph once per item. */
    const runLoop = async (node: WorkflowNode): Promise<any> => {
      const resolved = resolveValue(node.parameters, context);
      let items = resolved.items;
      if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch { items = []; }
      }
      if (!Array.isArray(items)) items = [];

      // batchSize > 1: itera en LOTES (el cuerpo recibe `items` = el trozo) en vez de uno a
      // uno. Patrón de datos grandes (menos iteraciones; combina con dataTable batch). Por
      // defecto 1 → comportamiento clásico item-a-item (`item`/`index`/`isLast`).
      const batchSize = Math.max(1, Math.floor(Number(resolved.batchSize) || 1));

      const bodyIds = directBody(node.id);

      // The feedback node is the body node connected back into the loop.
      const fullBody = loopBodies.get(node.id)!;
      let feedbackNodeId: string | undefined;
      for (const conn of incomingMap.get(node.id) || []) {
        if (fullBody.has(conn.source)) { feedbackNodeId = conn.source; break; }
      }

      const results: any[] = [];
      const runIteration = async (output: any) => {
        context[node.name] = { output };
        await runSubgraph(bodyIds);
        if (feedbackNodeId) {
          const fb = nodeMap.get(feedbackNodeId);
          if (fb && context[fb.name]) results.push(context[fb.name].output);
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

      // Body nodes that never ran (e.g. empty loop) are reported as skipped.
      for (const bId of bodyIds) {
        if (!nodeResults[bId]) {
          const bNode = nodeMap.get(bId);
          if (bNode) {
            nodeResults[bId] = {
              nodeId: bId, nodeName: bNode.name, status: 'skipped',
              startTime: new Date().toISOString(), endTime: new Date().toISOString(), durationMs: 0
            };
          }
        }
      }

      const output = { done: true, results };
      context[node.name] = { output };
      nodeResults[node.id] = {
        nodeId: node.id, nodeName: node.name, status: 'success', output,
        startTime: new Date().toISOString(), endTime: new Date().toISOString(), durationMs: 0
      };
      return output;
    };

    /**
     * Executes one acyclic sub-graph (the main graph, or a single loop body iteration).
     * Only nodes in `nodeIds` are processed; edges to/from outside are ignored for join
     * accounting (external sources already ran and count as satisfied).
     */
    const runSubgraph = async (nodeIds: Set<string>): Promise<void> => {
      const processed = new Set<string>();
      const resolvedPaths = new Map<string, Map<Connection, 'success' | 'skipped'>>();
      for (const id of nodeIds) resolvedPaths.set(id, new Map());

      // Count of incoming edges whose source is inside this sub-graph.
      const internalIncomingCount = (id: string): number =>
        (incomingMap.get(id) || []).filter(c => nodeIds.has(c.source)).length;

      const queue: { nodeId: string; status: 'execute' | 'skip' }[] = [];
      for (const id of nodeIds) {
        if (internalIncomingCount(id) === 0) queue.push({ nodeId: id, status: 'execute' });
      }

      const propagate = (conn: Connection, pathStatus: 'success' | 'skipped') => {
        if (!nodeIds.has(conn.target)) return; // edge leaves the sub-graph
        const res = resolvedPaths.get(conn.target)!;
        res.set(conn, pathStatus);
        if (res.size === internalIncomingCount(conn.target)) {
          const anySuccess = Array.from(res.values()).includes('success');
          queue.push({ nodeId: conn.target, status: anySuccess ? 'execute' : 'skip' });
        }
      };

      while (queue.length > 0) {
        if (++steps > MAX_STEPS) {
          throw new WorkflowValidationError(
            `Workflow execution exceeded the maximum step limit (${MAX_STEPS}). ` +
            `This usually indicates an infinite loop in the workflow graph.`
          );
        }

        const { nodeId, status } = queue.shift()!;
        if (processed.has(nodeId)) continue;
        processed.add(nodeId);

        const node = nodeMap.get(nodeId);
        if (!node) continue;

        // --- Resume replay: don't re-execute work done before the suspend ---
        if (resume) {
          if (nodeId === resume.waitNodeId) {
            // The wait node "returns" the resume payload; downstream reads it as its output.
            const now = new Date().toISOString();
            const output = resume.resumePayload;
            context[node.name] = { output };
            nodeResults[nodeId] = { nodeId, nodeName: node.name, status: 'success', output, startTime: now, endTime: now, durationMs: 0 };
            for (const conn of outgoingMap.get(nodeId) || []) propagate(conn, 'success');
            continue;
          }
          const prior = resume.priorResults[nodeId];
          if (prior) {
            nodeResults[nodeId] = prior;
            if (node.type === 'respond' && prior.status === 'success' && prior.output?._lfHttpResponse) {
              httpResponse = prior.output._lfHttpResponse;
            }
            if (prior.status === 'skipped') {
              for (const conn of outgoingMap.get(nodeId) || []) propagate(conn, 'skipped');
            } else {
              context[node.name] = { output: prior.output };
              for (const conn of outgoingMap.get(nodeId) || []) {
                let pathStatus: 'success' | 'skipped' = 'success';
                if (node.type === 'if') {
                  const r = prior.output?.result;
                  if (conn.sourceHandle === 'true' && !r) pathStatus = 'skipped';
                  else if (conn.sourceHandle === 'false' && r) pathStatus = 'skipped';
                } else if (node.type === 'switch') {
                  if (conn.sourceHandle !== prior.output?.matched) pathStatus = 'skipped';
                }
                propagate(conn, pathStatus);
              }
            }
            continue;
          }
        }

        if (status === 'skip') {
          const at = new Date().toISOString();
          nodeResults[nodeId] = { nodeId, nodeName: node.name, status: 'skipped', startTime: at, endTime: at, durationMs: 0 };
          for (const conn of outgoingMap.get(nodeId) || []) propagate(conn, 'skipped');
          continue;
        }

        // --- Pinned data (manual runs only): use the stored output instead of executing ---
        // Lets you iterate downstream without re-calling expensive/external nodes. Ignored in
        // production (triggered runs don't set usePinData). Mirrors the resume branch-routing.
        if (usePinData && node.type !== 'loop' && node.pinData !== undefined) {
          const now = new Date().toISOString();
          const output = node.pinData;
          context[node.name] = { output };
          nodeResults[nodeId] = { nodeId, nodeName: node.name, status: 'success', output, pinned: true, startTime: now, endTime: now, durationMs: 0 };
          for (const conn of outgoingMap.get(nodeId) || []) {
            let pathStatus: 'success' | 'skipped' = 'success';
            if (node.type === 'if') {
              const r = (output as any)?.result;
              if (conn.sourceHandle === 'true' && !r) pathStatus = 'skipped';
              else if (conn.sourceHandle === 'false' && r) pathStatus = 'skipped';
            } else if (node.type === 'switch') {
              if (conn.sourceHandle !== (output as any)?.matched) pathStatus = 'skipped';
            }
            propagate(conn, pathStatus);
          }
          continue;
        }

        if (node.type === 'loop') {
          const output = await runLoop(node);
          for (const conn of outgoingMap.get(nodeId) || []) {
            // 'done' branch continues; the 'loop' (body) branch stays inside runLoop.
            if (conn.sourceHandle === 'loop') continue;
            propagate(conn, 'success');
          }
          continue;
        }

        // Build merge inputs (accumulate per handle so same-handle edges aren't lost).
        let incomingInputs: Record<string, any> = {};
        if (node.type === 'merge') {
          const handleArrays: Record<string, any[]> = {};
          for (const conn of incomingMap.get(node.id) || []) {
            const src = nodeMap.get(conn.source);
            if (src) {
              const handle = conn.targetHandle || 'input1';
              (handleArrays[handle] ||= []).push(context[src.name]?.output);
            }
          }
          for (const h of Object.keys(handleArrays)) {
            incomingInputs[h] = handleArrays[h].length === 1 ? handleArrays[h][0] : handleArrays[h];
          }
        }

        const { output, ok } = await runNode(node, incomingInputs);

        // A `respond` node declares the synchronous HTTP response for the webhook route.
        if (ok && node.type === 'respond' && output && output._lfHttpResponse) {
          httpResponse = output._lfHttpResponse;
        }

        for (const conn of outgoingMap.get(nodeId) || []) {
          // A failed-but-continued branching node can't have its handles evaluated → skip.
          if (!ok && node.type === 'if') {
            propagate(conn, 'skipped');
            continue;
          }
          if (!ok) {
            // Non-branching node that genuinely failed (no continueOnFail) → skip downstream.
            propagate(conn, 'skipped');
            continue;
          }
          let pathStatus: 'success' | 'skipped' = 'success';
          if (node.type === 'if') {
            const ifResult = output?.result;
            if (conn.sourceHandle === 'true' && !ifResult) pathStatus = 'skipped';
            else if (conn.sourceHandle === 'false' && ifResult) pathStatus = 'skipped';
          } else if (node.type === 'switch') {
            // Solo continúa la salida que coincide con la rama elegida; el resto se omite.
            if (conn.sourceHandle !== output?.matched) pathStatus = 'skipped';
          }
          propagate(conn, pathStatus);
        }
      }
    };

    // --- Run the top-level graph ---
    try {
      await runSubgraph(mainNodeIds);
    } catch (err: any) {
      if (err instanceof WorkflowSuspendError) {
        const endTime = new Date();
        return {
          success: false,
          suspended: true,
          resumeToken: err.token,
          waitNodeId: err.waitNodeId,
          httpResponse,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          durationMs: endTime.getTime() - startTime.getTime(),
          nodeResults,
        };
      }
      throw err;
    }

    // Reconcile nodes that never produced a result:
    //  - inside a loop body whose loop never ran  → legitimately skipped
    //  - in the main graph with no path to it      → unreachable / cyclic dependency → failed
    for (const node of workflow.nodes) {
      if (!nodeResults[node.id]) {
        const inLoopBody = enclosingLoop.get(node.id) !== null;
        const at = startTime.toISOString();
        nodeResults[node.id] = inLoopBody
          ? { nodeId: node.id, nodeName: node.name, status: 'skipped', startTime: at, endTime: at, durationMs: 0 }
          : {
              nodeId: node.id, nodeName: node.name, status: 'failed',
              error: 'Workflow node was not executed. This could be due to a cyclic dependency in your workflow.',
              startTime: at, endTime: at, durationMs: 0
            };
      }
    }

    const endTime = new Date();
    const allSuccessful = Object.values(nodeResults).every(r => r.status !== 'failed');

    return {
      success: allSuccessful,
      httpResponse,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      durationMs: endTime.getTime() - startTime.getTime(),
      nodeResults
    };
  }
}
