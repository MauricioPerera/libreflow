import { ref } from 'vue';
import { apiGetJson } from '../api';

// Estado + carga de credenciales (lista para el dashboard y para el panel del editor).
// Composable: agrupa el ref y su fetch fuera de App.vue sin cambiar la conducta.
export function useCredentials() {
  const credentialsList = ref<any[]>([]);

  const fetchCredentials = async () => {
    try {
      credentialsList.value = await apiGetJson('/api/credentials');
    } catch (err) {
      console.error('Error fetching credentials:', err);
    }
  };

  return { credentialsList, fetchCredentials };
}
