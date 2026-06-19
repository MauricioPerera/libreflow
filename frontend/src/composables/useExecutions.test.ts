import { describe, it, expect, vi, afterEach } from 'vitest';
import { useExecutions } from './useExecutions';

describe('useExecutions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('carga la lista global y la del flujo según la URL', async () => {
    const global = [{ id: 'e1' }];
    const wf = [{ id: 'e2' }];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (url === '/api/executions' ? global : wf),
    })));
    const { globalExecutionsList, workflowExecutionsList, activeExecutionId, fetchGlobalExecutions, fetchWorkflowExecutions } = useExecutions();
    expect(activeExecutionId.value).toBeNull();
    await fetchGlobalExecutions();
    expect(globalExecutionsList.value).toEqual(global);
    await fetchWorkflowExecutions('wf-1');
    expect(workflowExecutionsList.value).toEqual(wf);
  });

  it('ante error HTTP deja las listas vacías sin romper', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { globalExecutionsList, fetchGlobalExecutions } = useExecutions();
    await fetchGlobalExecutions();
    expect(globalExecutionsList.value).toEqual([]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
