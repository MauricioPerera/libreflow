<template>
  <div :class="['custom-node', nodeStatusClass, { selected }]">
    <div class="node-header">
      <span class="node-icon" :style="{ background: nodeDef?.ui?.gradient || 'var(--color-primary)' }">
        {{ nodeDef?.icon || '⚡' }}
      </span>
      <span>{{ data.name }}</span>
      <span v-if="data.pinData !== undefined" title="Salida fijada (pin): no se re-ejecuta en pruebas" style="margin-left: auto; font-size: 13px;">📌</span>
    </div>
    <div class="node-subtitle">{{ nodeDef?.ui?.subtitle || 'Nodo' }}</div>
    
    <!-- Render Inputs -->
    <Handle 
      v-for="input in inputs" 
      :key="input.id || 'main'" 
      type="target" 
      :id="input.id === 'main' ? undefined : input.id"
      :position="Position.Left" 
      :style="input.topPercent !== undefined ? { top: input.topPercent + '%' } : {}"
    >
      <span v-if="input.label" :class="['handle-label', input.id]">{{ input.label }}</span>
    </Handle>

    <!-- Render Outputs -->
    <Handle 
      v-for="output in outputs" 
      :key="output.id || 'main'" 
      type="source" 
      :id="output.id === 'main' ? undefined : output.id"
      :position="Position.Right" 
      :style="output.topPercent !== undefined ? { top: output.topPercent + '%' } : {}"
    >
      <span v-if="output.label" :class="['handle-label', output.id]">{{ output.label }}</span>
    </Handle>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, Ref } from 'vue';
import { Handle, Position } from '@vue-flow/core';

interface InputOutput {
  id?: string;
  label?: string;
  topPercent?: number;
}

interface NodeDef {
  type: string;
  displayName: string;
  icon: string;
  ui?: {
    subtitle?: string;
    inputs?: InputOutput[];
    outputs?: InputOutput[];
    gradient?: string;
  };
}

const props = defineProps<{
  id: string;
  data: { name: string; parameters: any; pinData?: any };
  type: string;
  selected?: boolean;
}>();

const nodeTypesList = inject<Ref<NodeDef[]>>('nodeTypesList');
const nodeStatuses = inject<Ref<Record<string, string>>>('nodeStatuses');

const nodeDef = computed(() => {
  return nodeTypesList?.value?.find(n => n.type === props.type);
});

const nodeStatusClass = computed(() => {
  return nodeStatuses?.value?.[props.id] || '';
});

const inputs = computed(() => {
  return nodeDef.value?.ui?.inputs || [{ id: 'main' }];
});

const outputs = computed(() => {
  return nodeDef.value?.ui?.outputs || [{ id: 'main' }];
});
</script>
