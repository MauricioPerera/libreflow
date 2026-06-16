<template>
  <div class="subview-container">
    <div class="subview-header">
      <div>
        <h2 class="subview-title">Credenciales</h2>
        <p class="subview-desc">Administra tus accesos seguros para APIs de forma cifrada.</p>
      </div>
      <button @click="emit('create')" class="btn btn-primary">
        + Crear Credencial
      </button>
    </div>

    <div class="table-container">
      <table class="dashboard-table">
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Tipo de Conexión</th>
            <th>Creada el</th>
            <th>Última Modificación</th>
            <th style="text-align: right;">Acciones</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="cred in credentials" :key="cred.id">
            <td class="flow-name-cell" @click="emit('edit', cred.id)">
              🔑 {{ cred.name }}
            </td>
            <td>
              <span class="status-badge" style="background: hsla(var(--color-primary) / 0.12); color: hsl(var(--color-primary-text));">
                {{ credentialTypeLabel(cred.type) }}
              </span>
            </td>
            <td>{{ formatFullDate(cred.created_at) }}</td>
            <td>{{ formatFullDate(cred.updated_at) }}</td>
            <td style="text-align: right;">
              <div class="table-actions">
                <button @click="emit('edit', cred.id)" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;">
                  Editar
                </button>
                <button @click="emit('delete', cred.id)" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px; border-color: hsla(var(--color-danger) / 0.3); color: hsl(var(--color-danger));">
                  Eliminar
                </button>
              </div>
            </td>
          </tr>
          <tr v-if="!loaded">
            <td colspan="5" class="empty-table-message">Cargando credenciales…</td>
          </tr>
          <tr v-else-if="credentials.length === 0">
            <td colspan="5" class="empty-table-message">
              No tienes credenciales guardadas. Haz clic en "+ Crear Credencial" para empezar.
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { formatFullDate, credentialTypeLabel } from '../utils';

defineProps<{
  credentials: any[];
  loaded: boolean;
}>();

const emit = defineEmits<{
  (e: 'create'): void;
  (e: 'edit', id: string): void;
  (e: 'delete', id: string): void;
}>();
</script>
