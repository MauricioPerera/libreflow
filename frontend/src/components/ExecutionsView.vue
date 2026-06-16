<template>
  <div class="subview-container">
    <div class="subview-header">
      <div>
        <h2 class="subview-title">Bitácora de Ejecuciones</h2>
        <p class="subview-desc">Historial completo de ejecuciones de todos tus flujos.</p>
      </div>
    </div>

    <div class="table-container">
      <table class="dashboard-table">
        <thead>
          <tr>
            <th>ID Ejecución</th>
            <th>Flujo</th>
            <th>Estado</th>
            <th>Fecha de Ejecución</th>
            <th style="text-align: right;">Acciones</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="exec in executions" :key="exec.id">
            <td class="code-font">{{ exec.id }}</td>
            <td class="flow-name-cell" @click="emit('open', exec.id, exec.workflow_id)">
              📂 {{ exec.workflow_name }}
            </td>
            <td>
              <span :class="['status-badge', exec.status]">
                {{ statusLabel(exec.status) }}
              </span>
            </td>
            <td>{{ formatFullDate(exec.executed_at) }}</td>
            <td style="text-align: right; white-space: nowrap;">
              <button
                v-if="exec.status === 'failed'"
                @click="emit('ai-context', exec.id)"
                class="btn btn-secondary"
                style="padding: 6px 12px; font-size: 12px; margin-right: 6px;"
                title="Copiar contexto del error para dárselo a una IA"
              >
                🤖 Contexto IA
              </button>
              <button @click="emit('open', exec.id, exec.workflow_id)" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;">
                Ver Ejecución
              </button>
            </td>
          </tr>
          <tr v-if="!loaded">
            <td colspan="5" class="empty-table-message">Cargando ejecuciones…</td>
          </tr>
          <tr v-else-if="executions.length === 0">
            <td colspan="5" class="empty-table-message">
              No hay ejecuciones registradas en el sistema.
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { formatFullDate, statusLabel } from '../utils';

defineProps<{
  executions: any[];
  loaded: boolean;
}>();

const emit = defineEmits<{
  (e: 'open', id: string, workflowId: string): void;
  (e: 'ai-context', id: string): void;
}>();
</script>
