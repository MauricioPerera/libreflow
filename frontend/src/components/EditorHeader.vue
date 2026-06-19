<script setup lang="ts">
// Cabecera del editor (volver / nombre / toggle activo / guardar / ejecutar) + banner del modo
// preview de una versión. Presentacional: solo mover desde App.vue (props/emits), misma conducta.
// Estilos inline conservados tal cual; el resto son clases globales de index.css.
defineProps<{
  workflowName: string;
  workflowId: string | null;
  active: boolean;
  previewMode: boolean;
  running: boolean;
  previewedVersion: number | null;
}>();

const emit = defineEmits<{
  (e: 'exit'): void;
  (e: 'update:workflowName', value: string): void;
  (e: 'update:active', value: boolean): void;
  (e: 'toggle-active'): void;
  (e: 'save'): void;
  (e: 'run'): void;
  (e: 'restore', version: number): void;
  (e: 'cancel-preview'): void;
}>();

// El v-model del checkbox: actualiza el valor en el padre y luego dispara el toggle (que lee el
// estado ya actualizado), preservando el `v-model + @change` original.
function onActiveChange(ev: Event) {
  emit('update:active', (ev.target as HTMLInputElement).checked);
  emit('toggle-active');
}
</script>

<template>
  <header class="libreflow-header">
    <div class="brand-section">
      <button @click="emit('exit')" class="btn btn-secondary" style="padding: 8px 14px;">
        ← Volver
      </button>
      <div class="editor-title-container">
        <input
          :value="workflowName"
          @input="emit('update:workflowName', ($event.target as HTMLInputElement).value)"
          type="text"
          class="editor-title-input"
          placeholder="Flujo sin Nombre"
          :disabled="previewMode"
        />
      </div>
    </div>

    <div class="action-buttons" style="display: flex; align-items: center; gap: 12px;">
      <!-- Toggle de activo (solo si el flujo está guardado / tiene id) -->
      <div v-if="workflowId" class="workflow-active-toggle-container">
        <span class="active-toggle-label">{{ active ? 'Activo' : 'Inactivo' }}</span>
        <label class="switch">
          <input type="checkbox" :checked="active" :disabled="previewMode" @change="onActiveChange">
          <span class="slider round"></span>
        </label>
      </div>

      <button @click="emit('save')" :disabled="previewMode" class="btn btn-secondary" style="border-color: hsla(var(--color-primary) / 0.4); color: hsl(var(--color-primary)); margin: 0;">
        💾 Guardar
      </button>
      <button
        @click="emit('run')"
        :disabled="running || previewMode"
        class="btn btn-primary"
        style="margin: 0;"
      >
        <span v-if="running">Ejecutando...</span>
        <span v-else>▶ Ejecutar Flujo</span>
      </button>
    </div>
  </header>

  <!-- Banner del modo preview de una versión -->
  <div v-if="previewMode" class="preview-mode-banner" style="background: hsla(var(--accent-amber) / 0.15); border-bottom: 1px solid hsl(var(--accent-amber)); padding: 10px 24px; display: flex; align-items: center; justify-content: space-between; font-size: 13px; color: hsl(var(--text-primary)); z-index: 100;">
    <div style="display: flex; align-items: center; gap: 8px;">
      <span style="color: hsl(var(--accent-amber)); font-size: 16px;">⚠️</span>
      <span>Estás previsualizando la <strong>Versión #{{ previewedVersion }}</strong> (Modo Lectura). Las modificaciones en el lienzo están deshabilitadas.</span>
    </div>
    <div style="display: flex; gap: 12px;">
      <button @click="previewedVersion != null && emit('restore', previewedVersion)" class="btn btn-primary" style="margin: 0; padding: 6px 14px; font-size: 12px; background: hsl(var(--color-primary));">
        Restaurar esta Versión
      </button>
      <button @click="emit('cancel-preview')" class="btn btn-secondary" style="margin: 0; padding: 6px 14px; font-size: 12px; border-color: hsl(var(--text-muted)); color: hsl(var(--text-secondary));">
        Volver al Editor
      </button>
    </div>
  </div>
</template>
