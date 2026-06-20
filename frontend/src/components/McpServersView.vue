<template>
  <div class="subview-container">
    <div class="subview-header">
      <div>
        <h2 class="subview-title">Servidores MCP</h2>
        <p class="subview-desc">Publica un grupo concreto de flujos como herramientas MCP en una URL propia, conectable desde clientes como Claude Desktop.</p>
      </div>
      <button @click="emit('create')" class="btn btn-primary">
        + Crear Servidor MCP
      </button>
    </div>

    <!-- Servidor MCP global: punto de entrada para que un agente cree/ejecute flujos. -->
    <div class="mcp-global-card">
      <div class="mcp-global-head">
        <h3 class="mcp-global-title">🌐 Servidor MCP global</h3>
        <span class="status-badge success">Siempre activo · acotado a tu usuario</span>
      </div>
      <p class="subview-desc" style="margin: 0 0 12px;">
        Punto de entrada principal para conectar un agente que <strong>cree, valide y ejecute flujos</strong>.
        Expone las herramientas de sistema (<code>libreflow_*</code>) y los recursos (data tables y definiciones
        de flujo), todo acotado a tu usuario.
      </p>

      <div class="mcp-global-row">
        <span class="mcp-global-label">URL</span>
        <code class="code-font">{{ globalUrl }}</code>
        <button @click="emit('copy', globalUrl)" class="btn btn-secondary" style="padding: 2px 8px; font-size: 11px;">Copiar</button>
      </div>
      <div class="mcp-global-row">
        <span class="mcp-global-label">Transporte</span>
        <code class="code-font">Streamable HTTP (JSON-RPC)</code>
      </div>
      <div class="mcp-global-row">
        <span class="mcp-global-label">Auth</span>
        <code class="code-font">Authorization: Bearer &lt;token&gt;</code>
        <span class="mcp-global-hint">— en modo dev (sin <code>LF_API_KEY</code>) no requiere token</span>
      </div>

      <div class="mcp-global-row">
        <span class="mcp-global-label">Token</span>
        <template v-if="userToken">
          <code class="code-font mcp-token">{{ showToken ? userToken : '•'.repeat(24) }}</code>
          <button @click="showToken = !showToken" class="btn btn-secondary" style="padding: 2px 8px; font-size: 11px;">{{ showToken ? 'Ocultar' : 'Mostrar' }}</button>
          <button @click="emit('copy', userToken)" class="btn btn-secondary" style="padding: 2px 8px; font-size: 11px;">Copiar</button>
          <button @click="emit('regenerate-token')" class="btn btn-secondary" style="padding: 2px 8px; font-size: 11px; border-color: hsla(var(--color-danger) / 0.3); color: hsl(var(--color-danger));">Regenerar</button>
        </template>
        <span v-else class="mcp-global-hint">Inicia sesión como usuario real para obtener un token (en dev no hay usuario persistente al que asignarlo).</span>
      </div>

      <details class="mcp-global-tools">
        <summary>Herramientas de sistema (<code>libreflow_*</code>)</summary>
        <ul>
          <li><strong>Flujos:</strong> list_node_types · list_workflows · get_workflow · <strong>save_workflow</strong> (crear/actualizar) · validate_workflow · run_workflow · set_workflow_active · delete_workflow</li>
          <li><strong>Ejecuciones:</strong> list_executions · get_execution</li>
          <li><strong>Data tables:</strong> create_data_table · list_data_tables · query/get/add/update/delete rows · upsert · increment · delete_data_table</li>
        </ul>
        <p class="mcp-global-hint" style="margin: 6px 0 0;">
          Flujo típico de un agente: <code>list_node_types</code> → <code>save_workflow</code> → <code>validate_workflow</code> → <code>run_workflow</code>.
        </p>
      </details>
    </div>

    <div class="table-container">
      <table class="dashboard-table">
        <thead>
          <tr>
            <th>Nombre</th>
            <th>URL (MCP)</th>
            <th>Flujos</th>
            <th>Acceso</th>
            <th style="text-align: right;">Acciones</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="server in servers" :key="server.id">
            <td class="flow-name-cell" @click="emit('edit', server)">
              🔌 {{ server.name }}
            </td>
            <td class="code-font" style="font-size: 12px;">
              {{ mcpServerUrl(server.id) }}
              <button @click="emit('copy', mcpServerUrl(server.id))" class="btn btn-secondary" style="padding: 2px 6px; font-size: 11px; margin-left: 6px;">Copiar</button>
            </td>
            <td>{{ (server.workflow_ids || []).length }}</td>
            <td>
              <span :class="['status-badge', server.require_auth ? 'success' : 'inactive']">
                {{ server.require_auth ? 'Token' : 'Público' }}
              </span>
            </td>
            <td style="text-align: right;">
              <div class="table-actions">
                <button v-if="server.require_auth" @click="emit('copy', server.token)" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;">
                  Copiar token
                </button>
                <button @click="emit('edit', server)" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;">
                  Editar
                </button>
                <button @click="emit('delete', server.id)" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px; border-color: hsla(var(--color-danger) / 0.3); color: hsl(var(--color-danger));">
                  Eliminar
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="!loaded">
            <td colspan="5" class="empty-table-message">Cargando servidores…</td>
          </tr>
          <tr v-else-if="servers.length === 0">
            <td colspan="5" class="empty-table-message">
              No tienes servidores MCP. Haz clic en "+ Crear Servidor MCP" para empezar.
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { mcpServerUrl } from '../utils';

defineProps<{
  servers: any[];
  loaded: boolean;
  userToken?: string | null;
}>();

const emit = defineEmits<{
  (e: 'create'): void;
  (e: 'edit', server: any): void;
  (e: 'delete', id: string): void;
  (e: 'copy', text: string): void;
  (e: 'regenerate-token'): void;
}>();

const showToken = ref(false);

// URL del servidor MCP global (mismo origen + /api/mcp). En dev el frontend (:5173) proxya /api
// al backend; un agente externo debe usar el origen del backend (:3000).
const globalUrl = `${window.location.origin}/api/mcp`;
</script>

<style scoped>
.mcp-global-card {
  border: 1px solid hsl(var(--border-color));
  border-radius: var(--radius-md);
  background: hsla(var(--color-primary) / 0.04);
  padding: 16px 18px;
  margin-bottom: 20px;
}
.mcp-global-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.mcp-global-title { margin: 0; font-size: 15px; }
.mcp-global-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 4px 0; }
.mcp-global-label { display: inline-block; min-width: 86px; font-size: 12px; font-weight: 600; color: hsl(var(--text-secondary)); text-transform: uppercase; letter-spacing: 0.4px; }
.mcp-global-hint { font-size: 12px; color: hsl(var(--text-secondary)); }
.mcp-token { word-break: break-all; }
.mcp-global-tools { margin-top: 12px; font-size: 13px; }
.mcp-global-tools summary { cursor: pointer; font-weight: 600; color: hsl(var(--text-secondary)); }
.mcp-global-tools ul { margin: 8px 0 0; padding-left: 18px; }
.mcp-global-tools li { margin-bottom: 4px; }
</style>
