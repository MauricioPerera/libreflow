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
import { mcpServerUrl } from '../utils';

defineProps<{
  servers: any[];
  loaded: boolean;
}>();

const emit = defineEmits<{
  (e: 'create'): void;
  (e: 'edit', server: any): void;
  (e: 'delete', id: string): void;
  (e: 'copy', text: string): void;
}>();
</script>
