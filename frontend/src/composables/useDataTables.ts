import { ref } from 'vue';
import { apiGetJson } from '../api';

// Lista + carga de tablas de datos. El detalle (filas, edición inline, CRUD) se queda en App.vue
// (acoplado a sus modales/estado de edición); aquí solo viven la lista y su fetch.
export function useDataTables() {
  const dataTablesList = ref<any[]>([]);

  const fetchDataTables = async () => {
    try {
      dataTablesList.value = await apiGetJson('/api/data-tables');
    } catch (err) {
      console.error('Error fetching data tables:', err);
    }
  };

  return { dataTablesList, fetchDataTables };
}
