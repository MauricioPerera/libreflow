import { describe, it, expect, vi, afterEach } from 'vitest';
import { mergeAnswers } from '../src/collections.js';
import { WorkflowEngine } from '../src/engine.js';

describe('mergeAnswers (consenso)', () => {
  it('majority: la respuesta más repetida + ratio de acuerdo', () => {
    expect(mergeAnswers(['sí', 'sí', 'no'], 'majority')).toEqual({ answer: 'sí', agreement: 2 / 3, strategy: 'majority' });
    expect(mergeAnswers(['a', 'b', 'c'], 'majority').agreement).toBe(1 / 3); // todos distintos
  });

  it('majority: normaliza espacios (trim) y empate -> primera aparición', () => {
    expect(mergeAnswers(['  x ', 'x', 'y'], 'majority').answer.trim()).toBe('x');
    expect(mergeAnswers(['p', 'q'], 'majority').answer).toBe('p'); // empate 1-1
  });

  it('first: la primera, agreement = fracción que coincide', () => {
    expect(mergeAnswers(['A', 'A', 'B'], 'first')).toEqual({ answer: 'A', agreement: 2 / 3, strategy: 'first' });
  });

  it('mostSimilar: elige el output más central por solapamiento de tokens', () => {
    const r = mergeAnswers([
      'el gato negro duerme en el sofa',
      'el gato negro duerme en la silla',
      'la economia global crecio un tres por ciento',
    ], 'mostSimilar');
    expect(r.answer).toContain('gato negro'); // el outlier económico no gana
    expect(r.agreement).toBeGreaterThan(0);
  });

  it('casos borde: vacío / una sola', () => {
    expect(mergeAnswers([], 'majority')).toEqual({ answer: '', agreement: 0, strategy: 'majority' });
    expect(mergeAnswers(['solo'], 'majority')).toEqual({ answer: 'solo', agreement: 1, strategy: 'majority' });
  });
});

describe('aiAgent multi-run (self-consistency) end-to-end', () => {
  const engine = new WorkflowEngine();
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  // Mock del endpoint OpenAI-compatible: devuelve respuestas de una secuencia, sin tool_calls.
  const mockLLM = (answers: string[]) => {
    let i = 0;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: answers[i++] ?? answers[answers.length - 1] } }] }),
    })) as any;
  };

  const wf = (runs: string, consensus = 'majority') => ({
    id: 'wf-ag',
    nodes: [
      { id: 't', type: 'trigger', name: 'Start', parameters: {} },
      { id: 'ag', type: 'aiAgent', name: 'Agent', parameters: { model: 'm', userMessage: 'q', runs, consensus, temperature: '0.7' } },
    ],
    connections: [{ source: 't', target: 'ag' }],
  });

  it('runs>1: ejecuta N veces y devuelve el consenso + agreement', async () => {
    mockLLM(['Madrid', 'Madrid', 'Barcelona']);
    const r = await engine.execute(wf('3') as any);
    expect(r.nodeResults['ag'].status).toBe('success');
    const out = r.nodeResults['ag'].output;
    expect(out.answer).toBe('Madrid');
    expect(out.agreement).toBeCloseTo(2 / 3);
    expect(out.consensus).toBe('majority');
    expect(out.runs).toHaveLength(3);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(3); // N llamadas al LLM
  });

  it('runs=1: comportamiento clásico (misma forma de salida, sin agreement)', async () => {
    mockLLM(['una respuesta']);
    const r = await engine.execute(wf('1') as any);
    const out = r.nodeResults['ag'].output;
    expect(out.answer).toBe('una respuesta');
    expect(out.agreement).toBeUndefined();
    expect(out).toHaveProperty('toolCalls');
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1);
  });
});
