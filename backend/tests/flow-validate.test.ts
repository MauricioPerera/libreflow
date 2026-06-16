import { describe, it, expect } from 'vitest';
import { validateWorkflow } from '../src/flowValidate.js';
import { buildExecutionLlmContext } from '../src/errorContext.js';

describe('validateWorkflow', () => {
  it('un flujo correcto no tiene errores', () => {
    const r = validateWorkflow({
      nodes: [
        { id: 't', type: 'trigger', name: 'Start', parameters: {} },
        { id: 's', type: 'set', name: 'Datos', parameters: { values: [{ key: 'x', value: '1' }] } },
        { id: 'l', type: 'log', name: 'Log', parameters: { message: '{{ $node.Datos.output.x }}' } },
      ],
      connections: [
        { source: 't', target: 's' },
        { source: 's', target: 'l' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toBe(0);
  });

  it('detecta expresión que referencia un nodo inexistente (rename)', () => {
    const r = validateWorkflow({
      nodes: [
        { id: 't', type: 'trigger', name: 'Start', parameters: {} },
        { id: 'l', type: 'log', name: 'Log', parameters: { message: '{{ $node.NoExiste.output.x }}' } },
      ],
      connections: [{ source: 't', target: 'l' }],
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.code === 'BAD_EXPR_REF' && /NoExiste/.test(i.message))).toBe(true);
  });

  it('detecta tipo desconocido y conexión colgante', () => {
    const r = validateWorkflow({
      nodes: [{ id: 't', type: 'trigger', name: 'Start', parameters: {} }, { id: 'x', type: 'inventado', name: 'X', parameters: {} }],
      connections: [{ source: 't', target: 'fantasma' }],
    });
    expect(r.issues.some(i => i.code === 'UNKNOWN_TYPE')).toBe(true);
    expect(r.issues.some(i => i.code === 'CONN_BAD_TARGET')).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('avisa de handle de salida inválido', () => {
    const r = validateWorkflow({
      nodes: [
        { id: 't', type: 'trigger', name: 'Start', parameters: {} },
        { id: 'i', type: 'if', name: 'Cond', parameters: {} },
        { id: 'l', type: 'log', name: 'Log', parameters: {} },
      ],
      connections: [
        { source: 't', target: 'i' },
        { source: 'i', target: 'l', sourceHandle: 'noexiste' }, // if solo tiene true/false
      ],
    });
    expect(r.issues.some(i => i.code === 'BAD_HANDLE')).toBe(true);
    // handle inválido es warning, no bloquea
    expect(r.ok).toBe(true);
  });

  it('avisa de nombres duplicados y de ausencia de trigger', () => {
    const r = validateWorkflow({
      nodes: [
        { id: 'a', type: 'set', name: 'Dup', parameters: {} },
        { id: 'b', type: 'set', name: 'Dup', parameters: {} },
      ],
      connections: [],
    });
    expect(r.issues.some(i => i.code === 'DUP_NAME')).toBe(true);
    expect(r.issues.some(i => i.code === 'NO_TRIGGER')).toBe(true);
  });

  it('if con handles true/false es válido', () => {
    const r = validateWorkflow({
      nodes: [
        { id: 't', type: 'trigger', name: 'Start', parameters: {} },
        { id: 'i', type: 'if', name: 'Cond', parameters: {} },
        { id: 'a', type: 'log', name: 'A', parameters: {} },
        { id: 'b', type: 'log', name: 'B', parameters: {} },
      ],
      connections: [
        { source: 't', target: 'i' },
        { source: 'i', target: 'a', sourceHandle: 'true' },
        { source: 'i', target: 'b', sourceHandle: 'false' },
      ],
    });
    expect(r.issues.filter(i => i.level === 'error')).toEqual([]);
  });
});

describe('buildExecutionLlmContext', () => {
  const execution = {
    id: 'exec-99',
    workflow_id: 'wf-1',
    status: 'failed',
    executed_at: '2026-06-16 10:00:00',
    report: {
      success: false,
      nodeResults: {
        t: { nodeId: 't', nodeName: 'Start', status: 'success' },
        h: { nodeId: 'h', nodeName: 'Petición HTTP', status: 'failed', error: 'HTTP 500: boom' },
      },
    },
  };

  it('arma el contexto con el nodo fallido y la instrucción', () => {
    const ctx = buildExecutionLlmContext(execution, { workflowName: 'Mi Flujo', nodeTypeById: { h: 'httpRequest' } });
    expect(ctx.hasError).toBe(true);
    expect(ctx.failedNode).toEqual({ id: 'h', name: 'Petición HTTP', type: 'httpRequest', error: 'HTTP 500: boom' });
    expect(ctx.prompt).toContain('Mi Flujo');
    expect(ctx.prompt).toContain('exec-99');
    expect(ctx.prompt).toContain('Petición HTTP');
    expect(ctx.prompt).toContain('HTTP 500: boom');
    expect(ctx.prompt).toContain('httpRequest');
  });

  it('sin nodo fallido marca hasError según el report', () => {
    const ok = { id: 'e1', report: { success: true, nodeResults: { a: { nodeId: 'a', nodeName: 'A', status: 'success' } } } };
    const ctx = buildExecutionLlmContext(ok);
    expect(ctx.hasError).toBe(false);
    expect(ctx.failedNode).toBeUndefined();
  });
});
