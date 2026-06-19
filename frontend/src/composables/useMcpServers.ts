import { ref } from 'vue';
import { apiGetJson } from '../api';

// Lista + carga de servidores MCP nombrados. El CRUD (crear/editar/borrar) se queda en App.vue
// (acoplado a sus modales); aquí solo viven el estado de la lista y su fetch.
export function useMcpServers() {
  const mcpServersList = ref<any[]>([]);

  const fetchMcpServers = async () => {
    try {
      mcpServersList.value = await apiGetJson('/api/mcp-servers');
    } catch (err) {
      console.error('Error fetching MCP servers:', err);
    }
  };

  return { mcpServersList, fetchMcpServers };
}
