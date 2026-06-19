<script setup lang="ts">
// Paleta de nodos del editor (panel flotante izquierdo) + su botón para reabrir cuando está
// colapsada. Presentacional: recibe los tipos de nodo y el estado, emite `add` y el cambio de
// colapsado (v-model:collapsed). Los estilos viven en index.css (clases globales).
defineProps<{
  nodeTypes: any[];
  collapsed: boolean;
  previewMode: boolean;
}>();

const emit = defineEmits<{
  (e: 'add', type: string): void;
  (e: 'update:collapsed', value: boolean): void;
}>();
</script>

<template>
  <!-- Panel de nodos (oculto en preview o cuando está colapsado) -->
  <aside v-if="!previewMode" :class="['node-selector', 'editor-floating-left', { collapsed }]">
    <div class="node-selector-header">
      <h4 class="node-selector-title">Agregar Nodos</h4>
      <button @click="emit('update:collapsed', true)" class="sidebar-close-btn" title="Ocultar panel">✕</button>
    </div>
    <button
      v-for="nodeDef in nodeTypes"
      :key="nodeDef.type"
      @click="emit('add', nodeDef.type)"
      class="node-drag-item"
    >
      <span
        class="node-icon"
        :style="{ background: nodeDef.ui?.gradient || 'var(--color-primary)' }"
      >
        {{ nodeDef.icon }}
      </span>
      {{ nodeDef.displayName }}
    </button>
  </aside>

  <!-- Botón flotante para reabrir la paleta (solo cuando está colapsada) -->
  <button
    v-if="collapsed && !previewMode"
    @click="emit('update:collapsed', false)"
    class="floating-node-selector-toggle"
    title="Mostrar panel de nodos"
  >
    ＋ Agregar Nodo
  </button>
</template>
