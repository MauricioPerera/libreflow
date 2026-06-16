<template>
  <div class="subview-container">
    <div class="subview-header">
      <div>
        <h2 class="subview-title">Flujos de Trabajo</h2>
        <p class="subview-desc">Crea y administra tus automatizaciones de procesos.</p>
      </div>
      <div style="display: flex; gap: 10px;">
        <button @click="emit('validate')" class="btn btn-secondary">
          🔍 Validar coherencia
        </button>
        <button @click="emit('import')" class="btn btn-secondary">
          ⬆️ Importar
        </button>
        <button @click="emit('create')" class="btn btn-primary">
          + Crear Flujo
        </button>
      </div>
    </div>

    <div class="table-container">
      <table class="dashboard-table">
        <thead>
          <tr>
            <th>Nombre del Flujo</th>
            <th>Estado</th>
            <th>Creado el</th>
            <th>Última Modificación</th>
            <th style="text-align: right;">Acciones</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="flow in workflows" :key="flow.id">
            <td class="flow-name-cell" @click="emit('edit', flow.id)">
              📂 {{ flow.name }}
            </td>
            <td>
              <span :class="['status-badge', flow.active ? 'success' : 'inactive']">
                {{ flow.active ? 'Activo' : 'Inactivo' }}
              </span>
            </td>
            <td>{{ formatFullDate(flow.created_at) }}</td>
            <td>{{ formatFullDate(flow.updated_at) }}</td>
            <td style="text-align: right;">
              <div class="table-actions">
                <button @click="emit('edit', flow.id)" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;">
                  Editar
                </button>
                <button @click="emit('export', flow.id)" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;" title="Descargar el flujo como JSON">
                  Exportar
                </button>
                <button @click="emit('delete', flow.id)" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px; border-color: hsla(var(--color-danger) / 0.3); color: hsl(var(--color-danger));">
                  Eliminar
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="!loaded">
            <td colspan="5" class="empty-table-message">Cargando flujos…</td>
          </tr>
          <tr v-else-if="workflows.length === 0">
            <td colspan="5" class="empty-table-message">
              No tienes flujos de trabajo guardados. Haz clic en "+ Crear Flujo" para empezar.
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { formatFullDate } from '../utils';

defineProps<{
  workflows: any[];
  loaded: boolean;
}>();

const emit = defineEmits<{
  (e: 'validate'): void;
  (e: 'create'): void;
  (e: 'import'): void;
  (e: 'export', id: string): void;
  (e: 'edit', id: string): void;
  (e: 'delete', id: string): void;
}>();
</script>
