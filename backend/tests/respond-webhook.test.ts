import { describe, it, expect } from 'vitest';
import { WorkflowEngine } from '../src/engine.js';
import { NodeRegistry } from '../src/registry.js';

// Fase 1: respuesta HTTP a medida. El nodo `respond` declara la respuesta síncrona del
// webhook; el motor la captura en `report.httpResponse` y la ruta /hooks la emite.

describe('Respond node + httpResponse capture', () => {
  const engine = new WorkflowEngine();

  it('expone el nodo respond en el registro', () => {
    const def = NodeRegistry.getNodeType('respond');
    expect(def).toBeDefined();
    expect(def!.category).toBe('Flow');
  });

  it('execute() acota el estado y filtra cabeceras peligrosas', async () => {
    const def = NodeRegistry.getNodeType('respond')!;
    const out = await def.execute({
      responseStatus: '999',           // fuera de rango → se acota a 599
      responseContentType: 'text/html',
      responseHeaders: [
        { key: 'X-Custom', value: 'abc' },
        { key: '__proto__', value: 'evil' }, // clave peligrosa → descartada
      ],
      responseBody: '<h1>hola</h1>',
    }, {}, undefined, undefined);

    expect(out._lfHttpResponse.status).toBe(599);
    expect(out._lfHttpResponse.contentType).toBe('text/html');
    expect(out._lfHttpResponse.headers).toEqual({ 'X-Custom': 'abc' });
    expect(out._lfHttpResponse.body).toBe('<h1>hola</h1>');
  });

  it('estado por defecto = 200 cuando no es numérico', async () => {
    const def = NodeRegistry.getNodeType('respond')!;
    const out = await def.execute({ responseStatus: 'abc', responseBody: 'x' }, {}, undefined, undefined);
    expect(out._lfHttpResponse.status).toBe(200);
  });

  it('captura httpResponse del nodo respond ejecutado, con expresión resuelta en el cuerpo', async () => {
    const wf = {
      id: 'wf-respond',
      nodes: [
        { id: 't', type: 'trigger', name: 'Start', parameters: {} },
        { id: 's', type: 'set', name: 'Datos', parameters: { values: [{ key: 'nombre', value: 'Ada' }] } },
        { id: 'r', type: 'respond', name: 'Responder', parameters: {
          responseStatus: '201',
          responseContentType: 'application/json',
          responseHeaders: [{ key: 'X-Flow', value: 'libreflow' }],
          responseBody: 'Hola {{ $node.Datos.output.nombre }}',
        } },
      ],
      connections: [
        { source: 't', target: 's' },
        { source: 's', target: 'r' },
      ],
    };

    const report = await engine.execute(wf as any);
    expect(report.success).toBe(true);
    expect(report.httpResponse).toBeDefined();
    expect(report.httpResponse!.status).toBe(201);
    expect(report.httpResponse!.contentType).toBe('application/json');
    expect(report.httpResponse!.headers).toEqual({ 'X-Flow': 'libreflow' });
    expect(report.httpResponse!.body).toBe('Hola Ada');
  });

  it('NO captura httpResponse si el respond está en una rama IF no tomada', async () => {
    const wf = {
      id: 'wf-respond-skip',
      nodes: [
        { id: 't', type: 'trigger', name: 'Start', parameters: {} },
        { id: 'if', type: 'if', name: 'Cond', parameters: { value1: '1', operator: 'equal', value2: '2' } },
        { id: 'r', type: 'respond', name: 'Responder', parameters: { responseStatus: '200', responseBody: 'no debería' } },
      ],
      connections: [
        { source: 't', target: 'if' },
        { source: 'if', target: 'r', sourceHandle: 'true' }, // rama true: no se toma (1 != 2)
      ],
    };

    const report = await engine.execute(wf as any);
    expect(report.httpResponse).toBeUndefined();
    expect(report.nodeResults['r'].status).toBe('skipped');
  });

  it('con varios respond, gana el último ejecutado', async () => {
    const wf = {
      id: 'wf-respond-multi',
      nodes: [
        { id: 't', type: 'trigger', name: 'Start', parameters: {} },
        { id: 'r1', type: 'respond', name: 'R1', parameters: { responseStatus: '201', responseBody: 'uno' } },
        { id: 'r2', type: 'respond', name: 'R2', parameters: { responseStatus: '202', responseBody: 'dos' } },
      ],
      connections: [
        { source: 't', target: 'r1' },
        { source: 'r1', target: 'r2' },
      ],
    };

    const report = await engine.execute(wf as any);
    expect(report.httpResponse!.status).toBe(202);
    expect(report.httpResponse!.body).toBe('dos');
  });
});
