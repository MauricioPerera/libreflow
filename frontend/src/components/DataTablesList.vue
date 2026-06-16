<template>
  <div>
    <div class="subview-header">
      <div>
        <h2 class="subview-title">Tablas de Datos (Data Tables)</h2>
        <p class="subview-desc">Crea y administra tablas estructuradas para almacenar registros de tus automatizaciones.</p>
      </div>
      <button @click="emit('create')" class="btn btn-primary">
        + Crear Tabla
      </button>
    </div>

    <div class="table-container">
      <table class="dashboard-table">
        <thead>
          <tr>
            <th>Nombre de la Tabla</th>
            <th>ID</th>
            <th>Columnas</th>
            <th>Creada el</th>
            <th style="text-align: right;">Acciones</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="table in tables" :key="table.id">
            <td class="flow-name-cell" @click="emit('select', table)">
              📊 {{ table.name }}
            </td>
            <td class="code-font">{{ table.id }}</td>
            <td>
              <span v-for="col in parseJsonColumns(table.columns)" :key="col.name" class="status-badge" style="margin-right: 4px; background: hsla(var(--color-primary) / 0.1); color: hsl(var(--color-primary-text)); padding: 2px 6px; font-size: 12px;">
                {{ col.name }} ({{ col.type }})
              </span>
            </td>
            <td>{{ formatFullDate(table.created_at) }}</td>
            <td style="text-align: right;">
              <div class="table-actions">
                <button @click="emit('select', table)" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;">
                  Ver Datos
                </button>
                <button @click="emit('delete', table.id)" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px; border-color: hsla(var(--color-danger) / 0.3); color: hsl(var(--color-danger));">
                  Eliminar
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="!loaded">
            <td colspan="5" class="empty-table-message">Cargando tablas…</td>
          </tr>
          <tr v-else-if="tables.length === 0">
            <td colspan="5" class="empty-table-message">
              No tienes tablas de datos creadas. Haz clic en "+ Crear Tabla" para empezar.
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { formatFullDate, parseJsonColumns } from '../utils';

defineProps<{
  tables: any[];
  loaded: boolean;
}>();

const emit = defineEmits<{
  (e: 'create'): void;
  (e: 'select', table: any): void;
  (e: 'delete', id: string): void;
}>();
</script>
