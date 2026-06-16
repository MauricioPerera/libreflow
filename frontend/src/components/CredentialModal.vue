<template>
  <div class="modal-overlay" role="dialog" aria-modal="true" v-focus-trap @click.self="emit('close')">
    <div class="modal-content" style="width: 480px; max-width: 90%;">
      <h3 class="modal-title">{{ editingCredentialId ? 'Editar Credencial' : 'Crear Credencial' }}</h3>
      <p class="modal-desc">Completa los datos de acceso que serán cifrados de manera segura.</p>

      <div class="config-group">
        <label class="config-label">NOMBRE DE LA CREDENCIAL</label>
        <input
          v-model="credentialName"
          type="text"
          class="config-input"
          placeholder="ej: Mi API de Slack / API Producción"
        />
      </div>

      <div class="config-group">
        <label class="config-label">TIPO DE CONEXIÓN</label>
        <select v-model="credentialType" class="config-input" :disabled="!!editingCredentialId">
          <option value="basicAuth">Basic Auth (Usuario / Contraseña)</option>
          <option value="apiKey">API Key (Token de Cabecera o Query)</option>
          <option value="oauth2">OAuth2 (token + refresh automático)</option>
        </select>
      </div>

      <!-- Inputs for basicAuth -->
      <div v-if="credentialType === 'basicAuth'">
        <div class="config-group">
          <label class="config-label">USUARIO</label>
          <input v-model="credUser" type="text" class="config-input" placeholder="Nombre de usuario o correo" />
        </div>
        <div class="config-group">
          <label class="config-label">CONTRASEÑA</label>
          <input v-model="credPassword" type="password" class="config-input" placeholder="Contraseña o Token de acceso" />
        </div>
      </div>

      <!-- Inputs for apiKey -->
      <div v-else-if="credentialType === 'apiKey'">
        <div class="config-group">
          <label class="config-label">NOMBRE DEL PARÁMETRO / CABECERA</label>
          <input v-model="credKeyName" type="text" class="config-input" placeholder="ej: Authorization, X-API-Key, api_key" />
        </div>
        <div class="config-group">
          <label class="config-label">VALOR DE LA CREDENCIAL</label>
          <input v-model="credKeyValue" type="password" class="config-input" placeholder="Ingresa el valor secreto" />
        </div>
        <div class="config-group">
          <label class="config-label">ENVIAR EN</label>
          <select v-model="credKeyIn" class="config-input">
            <option value="header">Cabecera HTTP (Header)</option>
            <option value="query">Parámetro de URL (Query Parameter)</option>
          </select>
        </div>
      </div>

      <!-- Inputs for oauth2 -->
      <div v-else-if="credentialType === 'oauth2'">
        <div class="config-group">
          <label class="config-label">TIPO DE GRANT</label>
          <select v-model="oauthGrantType" class="config-input">
            <option value="client_credentials">Client Credentials (machine-to-machine)</option>
            <option value="refresh_token">Refresh Token</option>
            <option value="authorization_code">Authorization Code (login del usuario + PKCE)</option>
          </select>
        </div>
        <div class="config-group" v-if="oauthGrantType === 'authorization_code'">
          <label class="config-label">AUTHORIZATION URL</label>
          <input v-model="oauthAuthUrl" type="text" class="config-input" placeholder="https://accounts.ejemplo.com/o/oauth2/v2/auth" />
        </div>
        <div class="config-group">
          <label class="config-label">TOKEN URL</label>
          <input v-model="oauthTokenUrl" type="text" class="config-input" placeholder="https://auth.ejemplo.com/oauth/token" />
        </div>
        <div class="config-group">
          <label class="config-label">CLIENT ID</label>
          <input v-model="oauthClientId" type="text" class="config-input" placeholder="ID de cliente" />
        </div>
        <div class="config-group">
          <label class="config-label">CLIENT SECRET</label>
          <input v-model="oauthClientSecret" type="password" class="config-input" placeholder="Secreto de cliente" />
        </div>
        <div class="config-group" v-if="oauthGrantType === 'refresh_token'">
          <label class="config-label">REFRESH TOKEN</label>
          <input v-model="oauthRefreshToken" type="password" class="config-input" placeholder="Refresh token inicial" />
        </div>
        <div class="config-group">
          <label class="config-label">SCOPE (opcional)</label>
          <input v-model="oauthScope" type="text" class="config-input" placeholder="ej: read write" />
        </div>
        <div class="config-group">
          <label class="config-label">AUTENTICACIÓN DEL CLIENTE</label>
          <select v-model="oauthClientAuth" class="config-input">
            <option value="header">Cabecera HTTP Basic (recomendado)</option>
            <option value="body">En el cuerpo (client_id / client_secret)</option>
          </select>
        </div>

        <!-- Flujo interactivo: registro del redirect + conexión -->
        <div v-if="oauthGrantType === 'authorization_code'">
          <label class="config-checkbox" style="display:flex;align-items:center;gap:8px;margin:8px 0;">
            <input type="checkbox" v-model="oauthUsePkce" /> Usar PKCE (S256, recomendado)
          </label>
          <label class="config-checkbox" style="display:flex;align-items:center;gap:8px;margin:8px 0;">
            <input type="checkbox" v-model="oauthOfflineAccess" /> Solicitar refresh token (access_type=offline)
          </label>
          <div class="config-group">
            <label class="config-label">REDIRECT URI (regístralo en la app del proveedor)</label>
            <input :value="oauthRedirectUri" readonly class="config-input" @focus="(e:any)=>e.target.select()" />
          </div>
          <div class="config-group">
            <p v-if="!editingCredentialId" style="font-size:12px;color:var(--color-text-muted);">
              Guarda la credencial primero; luego podrás conectarla.
            </p>
            <div v-else style="display:flex;align-items:center;gap:10px;">
              <button @click="connectOAuth" class="btn btn-secondary" :disabled="oauthConnecting">
                {{ oauthConnecting ? 'Conectando…' : (oauthConnected ? 'Reconectar' : 'Conectar') }}
              </button>
              <span v-if="oauthConnected" style="color:#16a34a;font-size:13px;">✅ Conectada</span>
              <span v-if="oauthConnectError" style="color:#dc2626;font-size:13px;">{{ oauthConnectError }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-actions" style="margin-top: 24px;">
        <button @click="emit('close')" class="btn btn-secondary">Cancelar</button>
        <button @click="save" class="btn btn-primary" :disabled="!canSaveCredential">
          Guardar
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';

const props = defineProps<{
  // id de la credencial a editar, o null para crear una nueva.
  editId: string | null;
}>();

const emit = defineEmits<{
  (e: 'saved'): void; // tras un POST correcto (el padre refresca la lista)
  (e: 'close'): void;
}>();

// Estado del formulario (antes vivía en App.vue).
const editingCredentialId = ref<string | null>(props.editId);
const credentialName = ref('');
const credentialType = ref<'basicAuth' | 'apiKey' | 'oauth2'>('basicAuth');
const credUser = ref('');
const credPassword = ref('');
const credKeyName = ref('');
const credKeyValue = ref('');
const credKeyIn = ref<'header' | 'query'>('header');
// OAuth2
const oauthGrantType = ref<'client_credentials' | 'refresh_token' | 'authorization_code'>('client_credentials');
const oauthAuthUrl = ref('');
const oauthTokenUrl = ref('');
const oauthClientId = ref('');
const oauthClientSecret = ref('');
const oauthRefreshToken = ref('');
const oauthScope = ref('');
const oauthClientAuth = ref<'header' | 'body'>('header');
const oauthUsePkce = ref(true);
const oauthOfflineAccess = ref(true);
const oauthRedirectUri = ref('');
const oauthConnecting = ref(false);
const oauthConnected = ref(false);
const oauthConnectError = ref('');

const canSaveCredential = computed(() => {
  if (!credentialName.value.trim()) return false;
  if (credentialType.value === 'basicAuth') return !!credUser.value.trim() && !!credPassword.value.trim();
  if (credentialType.value === 'apiKey') return !!credKeyName.value.trim() && !!credKeyValue.value.trim();
  if (credentialType.value === 'oauth2') {
    if (!oauthTokenUrl.value.trim() || !oauthClientId.value.trim()) return false;
    if (oauthGrantType.value === 'refresh_token' && !oauthRefreshToken.value.trim()) return false;
    if (oauthGrantType.value === 'authorization_code' && !oauthAuthUrl.value.trim()) return false;
    return true;
  }
  return false;
});

// Carga el redirect_uri que el usuario debe registrar en el proveedor.
const fetchOAuthRedirectUri = async () => {
  try {
    const res = await fetch('/api/oauth/redirect-uri');
    if (res.ok) oauthRedirectUri.value = (await res.json()).redirectUri || '';
  } catch { /* ignore */ }
};

// Origen esperado del mensaje del callback = origen del redirect URI (en dev el backend sirve
// el callback en otro puerto que la app), con fallback al origen actual.
const expectedOAuthOrigin = (): string => {
  try { return oauthRedirectUri.value ? new URL(oauthRedirectUri.value).origin : window.location.origin; }
  catch { return window.location.origin; }
};

// Listener activo del popup OAuth (lo limpiamos al recibir respuesta o al desmontar el modal).
let oauthListener: ((e: MessageEvent) => void) | null = null;
const clearOAuthListener = () => {
  if (oauthListener) { window.removeEventListener('message', oauthListener); oauthListener = null; }
};

// Inicia el flujo interactivo: abre un popup al proveedor y espera el postMessage del callback.
const connectOAuth = () => {
  if (!editingCredentialId.value) return;
  oauthConnectError.value = '';
  oauthConnecting.value = true;
  const id = editingCredentialId.value;

  clearOAuthListener(); // evita acumular listeners en reintentos
  const onMessage = (e: MessageEvent) => {
    if (e.origin !== expectedOAuthOrigin()) return; // solo nuestro propio callback
    if (!e.data || e.data.source !== 'libreflow-oauth') return;
    clearOAuthListener();
    oauthConnecting.value = false;
    if (e.data.ok) {
      oauthConnected.value = true;
    } else {
      oauthConnectError.value = e.data.detail || 'Error de conexión';
    }
  };
  oauthListener = onMessage;
  window.addEventListener('message', onMessage);

  (async () => {
    try {
      const res = await fetch(`/api/credentials/${id}/oauth/authorize`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error || 'No se pudo iniciar OAuth');
      const { url } = await res.json();
      const popup = window.open(url, 'libreflow-oauth', 'width=620,height=720');
      if (!popup) throw new Error('El navegador bloqueó el popup. Permítelo y reintenta.');
    } catch (err: any) {
      clearOAuthListener();
      oauthConnecting.value = false;
      oauthConnectError.value = err.message;
    }
  })();
};

const save = async () => {
  const id = editingCredentialId.value || `cred-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const data: Record<string, any> = {};

  if (credentialType.value === 'basicAuth') {
    data.user = credUser.value;
    data.password = credPassword.value;
  } else if (credentialType.value === 'apiKey') {
    data.name = credKeyName.value;
    data.value = credKeyValue.value;
    data.in = credKeyIn.value;
  } else if (credentialType.value === 'oauth2') {
    data.grantType = oauthGrantType.value;
    data.tokenUrl = oauthTokenUrl.value.trim();
    data.clientId = oauthClientId.value;
    data.clientSecret = oauthClientSecret.value;
    data.clientAuth = oauthClientAuth.value;
    if (oauthScope.value.trim()) data.scope = oauthScope.value.trim();
    if (oauthGrantType.value === 'refresh_token') data.refreshToken = oauthRefreshToken.value;
    if (oauthGrantType.value === 'authorization_code') {
      data.authUrl = oauthAuthUrl.value.trim();
      data.usePkce = oauthUsePkce.value;
      data.offlineAccess = oauthOfflineAccess.value;
    }
  }

  const payload = { id, name: credentialName.value, type: credentialType.value, data };

  try {
    const res = await fetch('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      emit('saved'); // el padre refresca la lista
      // OAuth2 interactivo: mantén el modal abierto tras guardar para poder "Conectar"
      // (el botón necesita un id ya persistido).
      if (credentialType.value === 'oauth2' && oauthGrantType.value === 'authorization_code') {
        editingCredentialId.value = id;
      } else {
        emit('close');
      }
    }
  } catch (err) {
    console.error('Error saving credential:', err);
  }
};

// Inicialización al montar: crear (editId null) o editar (carga metadatos del backend).
const initCreate = () => {
  editingCredentialId.value = null;
  credentialName.value = '';
  credentialType.value = 'basicAuth';
  credUser.value = '';
  credPassword.value = '';
  credKeyName.value = '';
  credKeyValue.value = '';
  credKeyIn.value = 'header';
  oauthGrantType.value = 'client_credentials';
  oauthAuthUrl.value = '';
  oauthTokenUrl.value = '';
  oauthClientId.value = '';
  oauthClientSecret.value = '';
  oauthRefreshToken.value = '';
  oauthScope.value = '';
  oauthClientAuth.value = 'header';
  oauthUsePkce.value = true;
  oauthOfflineAccess.value = true;
  oauthConnected.value = false;
  oauthConnectError.value = '';
  fetchOAuthRedirectUri();
};

const initEdit = async (id: string) => {
  try {
    const res = await fetch(`/api/credentials/${id}`);
    if (!res.ok) { emit('close'); return; }
    const cred = await res.json();
    editingCredentialId.value = cred.id;
    credentialName.value = cred.name;
    credentialType.value = cred.type;

    // El endpoint GET no devuelve el material secreto descifrado (solo metadatos), así
    // que los campos sensibles llegan vacíos y se vuelven a introducir al editar.
    const data = cred.data || {};
    if (cred.type === 'basicAuth') {
      credUser.value = data.user || '';
      credPassword.value = data.password || '';
    } else if (cred.type === 'apiKey') {
      credKeyName.value = data.name || '';
      credKeyValue.value = data.value || '';
      credKeyIn.value = data.in || 'header';
    } else if (cred.type === 'oauth2') {
      oauthGrantType.value = data.grantType || 'client_credentials';
      oauthAuthUrl.value = data.authUrl || '';
      oauthTokenUrl.value = data.tokenUrl || '';
      oauthClientId.value = data.clientId || '';
      oauthClientSecret.value = data.clientSecret || '';
      oauthRefreshToken.value = data.refreshToken || '';
      oauthScope.value = data.scope || '';
      oauthClientAuth.value = data.clientAuth || 'header';
      oauthUsePkce.value = data.usePkce !== false;
      oauthOfflineAccess.value = data.offlineAccess !== false;
      oauthConnected.value = !!cred.connected; // flag derivado del backend (no expone token)
      oauthConnectError.value = '';
      fetchOAuthRedirectUri();
    }
  } catch (err) {
    console.error('Error loading credential details:', err);
    emit('close');
  }
};

onMounted(() => {
  if (props.editId) initEdit(props.editId);
  else initCreate();
});

// Limpia el listener del popup OAuth si el modal se cierra antes de que el popup responda.
onUnmounted(clearOAuthListener);
</script>
