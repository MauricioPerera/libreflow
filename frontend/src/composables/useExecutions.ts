import { ref } from 'vue';
import { apiGetJson } from '../api';

// Estado + carga de ejecuciones: la lista global del dashboard, la del flujo en el editor y el id
// de la ejecución activa (la que se está visualizando en el lienzo). Composable: agrupa los refs y
// sus fetch fuera de App.vue. `loadPastExecution` (aplica resultados al lienzo) sigue en App.vue
// porque está acoplado al estado del canvas; aquí solo viven datos y carga.
export function useExecutions() {
  const globalExecutionsList = ref<any[]>([]);
  const workflowExecutionsList = ref<any[]>([]);
  const activeExecutionId = ref<string | null>(null);

  const fetchGlobalExecutions = async () => {
    try {
      globalExecutionsList.value = await apiGetJson('/api/executions');
    } catch (err) {
      console.error('Error fetching global executions:', err);
      globalExecutionsList.value = [];
    }
  };

  const fetchWorkflowExecutions = async (workflowId: string) => {
    try {
      workflowExecutionsList.value = await apiGetJson(`/api/workflows/${workflowId}/executions`);
    } catch (err) {
      console.error('Error fetching executions:', err);
      workflowExecutionsList.value = [];
    }
  };

  return {
    globalExecutionsList, workflowExecutionsList, activeExecutionId,
    fetchGlobalExecutions, fetchWorkflowExecutions,
  };
}
