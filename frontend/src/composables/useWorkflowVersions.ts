import { ref } from 'vue';
import { apiGetJson } from '../api';

// Estado de versionado de un flujo (lista de versiones + estado del modo preview) y su carga.
// Las acciones que MUTAN el lienzo (previsualizar/restaurar/cancelar) se quedan en App.vue
// porque están acopladas a nodes/edges; aquí viven solo el estado y el fetch.
export function useWorkflowVersions() {
  const workflowVersionsList = ref<any[]>([]);
  const isPreviewMode = ref(false);
  const previewedVersionNumber = ref<number | null>(null);
  const tempWorkflowState = ref<any | null>(null);

  const fetchWorkflowVersions = async (workflowId: string | null) => {
    if (!workflowId) return;
    try {
      workflowVersionsList.value = await apiGetJson(`/api/workflows/${workflowId}/versions`);
    } catch (err) {
      console.error('Error fetching workflow versions:', err);
    }
  };

  return { workflowVersionsList, isPreviewMode, previewedVersionNumber, tempWorkflowState, fetchWorkflowVersions };
}
