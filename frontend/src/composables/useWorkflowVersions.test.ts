import { describe, it, expect, vi, afterEach } from 'vitest';
import { useWorkflowVersions } from './useWorkflowVersions';

describe('useWorkflowVersions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('estado inicial + rellena la lista tras fetch', async () => {
    const vers = [{ id: 'v1', version: 1 }, { id: 'v2', version: 2 }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => vers })));
    const { workflowVersionsList, isPreviewMode, previewedVersionNumber, tempWorkflowState, fetchWorkflowVersions } = useWorkflowVersions();
    expect(workflowVersionsList.value).toEqual([]);
    expect(isPreviewMode.value).toBe(false);
    expect(previewedVersionNumber.value).toBeNull();
    expect(tempWorkflowState.value).toBeNull();
    await fetchWorkflowVersions('wf-1');
    expect(workflowVersionsList.value).toEqual(vers);
  });

  it('sin workflowId no llama a la API', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const { fetchWorkflowVersions } = useWorkflowVersions();
    await fetchWorkflowVersions(null);
    expect(f).not.toHaveBeenCalled();
  });
});
