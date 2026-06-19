import { ref } from 'vue';
import { apiGetJson } from '../api';

// Lista + carga de colecciones de vectores (RAG). El borrado lo hace App.vue (recarga tras).
export function useVectorStores() {
  const vectorStoresList = ref<any[]>([]);

  const fetchVectorStores = async () => {
    try {
      vectorStoresList.value = await apiGetJson('/api/vector-stores');
    } catch (err) {
      console.error('Error fetching vector stores:', err);
    }
  };

  return { vectorStoresList, fetchVectorStores };
}
