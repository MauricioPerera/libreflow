<template>
  <div class="modal-overlay" role="dialog" aria-modal="true" v-focus-trap @click.self="emit('close')">
    <div class="modal-content">
      <h3 class="modal-title">Guardar Flujo</h3>
      <p class="modal-desc">Asigna un nombre para guardar este flujo de trabajo en la base de datos.</p>
      <input
        v-model="nameModel"
        type="text"
        class="config-input"
        placeholder="Nombre del flujo (ej: Mi Flujo De Registro)"
        style="margin-bottom: 12px;"
      />
      <textarea
        v-model="descriptionModel"
        class="config-input"
        rows="2"
        placeholder="Descripción (opcional) — se usa como descripción de la tool MCP para que un agente la elija mejor"
        style="margin-bottom: 16px; resize: vertical;"
      />
      <div class="modal-actions">
        <button @click="emit('close')" class="btn btn-secondary">Cancelar</button>
        <button @click="emit('save')" class="btn btn-primary" :disabled="!name.trim()">Guardar</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  name: string;
  description: string;
}>();

const emit = defineEmits<{
  (e: 'update:name', value: string): void;
  (e: 'update:description', value: string): void;
  (e: 'close'): void;
  (e: 'save'): void;
}>();

const nameModel = computed({
  get: () => props.name,
  set: (v: string) => emit('update:name', v),
});
const descriptionModel = computed({
  get: () => props.description,
  set: (v: string) => emit('update:description', v),
});
</script>
