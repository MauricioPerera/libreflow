import { ref } from 'vue';
import { apiGetJson } from '../api';

// Catálogo de tipos de nodo (del registry del backend). App.vue lo `provide` al árbol del editor.
export function useNodeTypes() {
  const nodeTypesList = ref<any[]>([]);

  const fetchNodeTypes = async () => {
    try {
      nodeTypesList.value = await apiGetJson('/api/node-types');
    } catch (err) {
      console.error('Error fetching node types:', err);
    }
  };

  return { nodeTypesList, fetchNodeTypes };
}
