<template>
  <div class="modal-overlay" role="dialog" aria-modal="true" v-focus-trap @click.self="emit('close')">
    <div class="modal-content" style="width: 520px; max-width: 95%;">
      <h3 class="modal-title">{{ editingTableId ? 'Editar Columnas' : 'Crear Tabla de Datos' }}</h3>
      <p class="modal-desc">Define el nombre y las columnas de la tabla. Las columnas especifican el tipo de datos.</p>

      <div class="form-group" style="margin-top: 12px;">
        <label class="config-label">Nombre de la Tabla</label>
        <input
          v-model="nameModel"
          placeholder="ej: leads, clientes"
          class="config-input"
          :disabled="!!editingTableId"
        />
      </div>

      <div class="form-group" style="margin-top: 16px;">
        <label class="config-label" style="display: flex; justify-content: space-between; align-items: center;">
          <span>Columnas</span>
          <button @click="emit('add-column')" class="btn btn-secondary" style="padding: 2px 8px; font-size: 12px;">+ Añadir Columna</button>
        </label>

        <div style="max-height: 200px; overflow-y: auto; margin-top: 8px;">
          <div v-for="(col, index) in columns" :key="index" style="display: flex; gap: 8px; margin-bottom: 8px; align-items: center;">
            <input
              v-model="col.name"
              placeholder="Nombre de columna"
              class="config-input"
              style="flex-grow: 1; padding: 6px 10px; font-size: 13px;"
            />
            <select v-model="col.type" class="config-select" style="width: 120px; padding: 6px 10px; font-size: 13px;">
              <option value="string">Texto</option>
              <option value="number">Número</option>
              <option value="boolean">Booleano</option>
            </select>
            <button @click="emit('remove-column', index)" class="btn btn-secondary" style="padding: 6px 10px; font-size: 13px; border-color: transparent; color: hsl(var(--color-danger));">
              ✕
            </button>
          </div>
          <div v-if="columns.length === 0" style="font-size: 12px; color: hsl(var(--text-muted)); text-align: center; padding: 12px;">
            No hay columnas definidas. Añade al menos una.
          </div>
        </div>
      </div>

      <div class="form-group" style="margin-top: 16px;">
        <label class="config-label">Columna clave (única) — opcional</label>
        <select v-model="keyColumnModel" class="config-input">
          <option value="">Sin clave (tabla simple)</option>
          <option v-for="col in columns.filter(c => c.name.trim())" :key="col.name" :value="col.name">{{ col.name }}</option>
        </select>
        <p style="font-size: 12px; color: hsl(var(--text-muted)); margin-top: 4px;">
          Habilita upsert, incrementar contador, get-or-default e idempotencia (una fila por valor de clave).
        </p>
      </div>

      <div class="modal-actions" style="margin-top: 24px;">
        <button @click="emit('close')" class="btn btn-secondary">Cancelar</button>
        <button
          @click="emit('save')"
          class="btn btn-primary"
          :disabled="!name.trim() || columns.length === 0 || columns.some(c => !c.name.trim())"
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
  editingTableId: string | null;
  name: string;
  // Array compartido con el padre: el v-model de cada celda muta los objetos columna in situ;
  // añadir/quitar se delega al padre vía emits.
  columns: any[];
  keyColumn: string;
}>();

const emit = defineEmits<{
  (e: 'update:name', value: string): void;
  (e: 'update:keyColumn', value: string): void;
  (e: 'add-column'): void;
  (e: 'remove-column', index: number): void;
  (e: 'close'): void;
  (e: 'save'): void;
}>();

const nameModel = computed({ get: () => props.name, set: (v: string) => emit('update:name', v) });
const keyColumnModel = computed({ get: () => props.keyColumn, set: (v: string) => emit('update:keyColumn', v) });
</script>
