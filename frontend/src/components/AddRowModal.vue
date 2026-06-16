<template>
  <div class="modal-overlay" role="dialog" aria-modal="true" v-focus-trap @click.self="emit('close')">
    <div class="modal-content" style="width: 460px; max-width: 90%;">
      <h3 class="modal-title">Añadir Fila</h3>
      <p class="modal-desc">Ingresa los datos para la nueva fila en la tabla.</p>

      <div v-for="col in columns" :key="col.name" class="form-group" style="margin-top: 12px;">
        <label class="config-label">{{ col.name }} <span style="font-size: 12px; opacity: 0.6;">({{ col.type }})</span></label>
        <input
          v-if="col.type === 'number'"
          v-model.number="rowData[col.name]"
          type="number"
          class="config-input"
        />
        <div v-else-if="col.type === 'boolean'" style="display: flex; align-items: center; gap: 8px; margin-top: 6px;">
          <input
            v-model="rowData[col.name]"
            type="checkbox"
            style="width: 16px; height: 16px;"
          />
          <span style="font-size: 13px; color: hsl(var(--text-primary));">Activo/Verdadero</span>
        </div>
        <input
          v-else
          v-model="rowData[col.name]"
          type="text"
          class="config-input"
        />
      </div>

      <div class="modal-actions" style="margin-top: 24px;">
        <button @click="emit('close')" class="btn btn-secondary">Cancelar</button>
        <button @click="emit('save')" class="btn btn-primary">
          Guardar
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  columns: any[];
  // Objeto compartido con el padre: el v-model de cada campo muta sus propiedades in situ.
  rowData: Record<string, any>;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'save'): void;
}>();
</script>
