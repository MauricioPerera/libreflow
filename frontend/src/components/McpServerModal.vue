<template>
  <div class="modal-overlay" role="dialog" aria-modal="true" v-focus-trap @click.self="emit('close')">
    <div class="modal-content" style="width: 560px; max-width: 95%;">
      <h3 class="modal-title">{{ editingMcpServerId ? 'Editar Servidor MCP' : 'Crear Servidor MCP' }}</h3>
      <p class="modal-desc">Selecciona los flujos que se expondrán como herramientas. El servidor tendrá su propia URL pública.</p>

      <div class="form-group" style="margin-top: 12px;">
        <label class="config-label">Nombre del Servidor</label>
        <input v-model="nameModel" placeholder="ej: Herramientas de Ventas" class="config-input" />
      </div>

      <div class="form-group" style="margin-top: 16px;">
        <label class="config-label">Flujos expuestos como tools</label>
        <div style="max-height: 220px; overflow-y: auto; margin-top: 8px; border: 1px solid hsla(var(--text-muted) / 0.2); border-radius: 8px; padding: 8px;">
          <label v-for="flow in workflows" :key="flow.id" style="display: flex; align-items: center; gap: 8px; padding: 6px 4px; cursor: pointer; font-size: 13px;">
            <input type="checkbox" :checked="selectedWorkflowIds.includes(flow.id)" @change="emit('toggle-workflow', flow.id)" style="width: 15px; height: 15px;" />
            <span>{{ flow.name }}</span>
          </label>
          <div v-if="workflows.length === 0" style="font-size: 12px; color: hsl(var(--text-muted)); text-align: center; padding: 12px;">
            No hay flujos guardados todavía.
          </div>
        </div>
      </div>

      <div class="form-group" style="margin-top: 16px; display: flex; align-items: center; gap: 8px;">
        <input id="mcp-require-auth" v-model="requireAuthModel" type="checkbox" style="width: 15px; height: 15px;" />
        <label for="mcp-require-auth" style="font-size: 13px; cursor: pointer;">Requerir token (Bearer) para conectarse</label>
      </div>
      <div class="form-group" style="margin-top: 8px; display: flex; align-items: center; gap: 8px;">
        <input id="mcp-system-tools" v-model="exposeSystemModel" type="checkbox" style="width: 15px; height: 15px;" />
        <label for="mcp-system-tools" style="font-size: 13px; cursor: pointer;">Exponer también las herramientas de sistema (libreflow_*)</label>
      </div>

      <div class="modal-actions" style="margin-top: 24px;">
        <button @click="emit('close')" class="btn btn-secondary">Cancelar</button>
        <button
          @click="emit('save')"
          class="btn btn-primary"
          :disabled="!name.trim() || selectedWorkflowIds.length === 0"
        >
          Guardar
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  editingMcpServerId: string | null;
  name: string;
  workflows: any[];
  selectedWorkflowIds: string[];
  requireAuth: boolean;
  exposeSystem: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:name', value: string): void;
  (e: 'update:requireAuth', value: boolean): void;
  (e: 'update:exposeSystem', value: boolean): void;
  (e: 'toggle-workflow', id: string): void;
  (e: 'close'): void;
  (e: 'save'): void;
}>();

const nameModel = computed({ get: () => props.name, set: (v: string) => emit('update:name', v) });
const requireAuthModel = computed({ get: () => props.requireAuth, set: (v: boolean) => emit('update:requireAuth', v) });
const exposeSystemModel = computed({ get: () => props.exposeSystem, set: (v: boolean) => emit('update:exposeSystem', v) });
</script>
