<template>
  <div class="tree-item">
    <div 
      class="tree-row" 
      :style="{ paddingLeft: (depth * 16) + 'px' }" 
      @click="handleClick"
    >
      <span v-if="isObject" class="tree-toggle">
        {{ isOpen ? '▼' : '▶' }}
      </span>
      <span v-else class="tree-leaf-bullet">●</span>
      <span class="tree-key">{{ label }}</span>
      <span v-if="!isObject" class="tree-val-preview">: {{ formatValue(value) }}</span>
      <span v-else-if="isArray" class="tree-val-preview" style="color: hsl(var(--text-muted)); font-style: italic; font-size: 12px;">
        [ Array({{ value.length }}) ]
      </span>
      <span v-else class="tree-val-preview" style="color: hsl(var(--text-muted)); font-style: italic; font-size: 12px;">
        { Object }
      </span>
    </div>
    
    <div v-if="isObject && isOpen" class="tree-children">
      <!-- Recursive reference to itself -->
      <JsonTreeItem 
        v-for="(val, key) in value" 
        :key="key"
        :label="String(key)"
        :value="val"
        :path="path ? `${path}.${key}` : String(key)"
        :nodeName="nodeName"
        :depth="depth + 1"
        @insert-variable="emitInsert"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';

const props = defineProps<{
  label: string;
  value: any;
  path: string;
  nodeName: string;
  depth: number;
}>();

const emit = defineEmits<{
  (e: 'insert-variable', variable: string): void;
}>();

const isOpen = ref(true);

const isObject = computed(() => {
  return props.value !== null && typeof props.value === 'object';
});

const isArray = computed(() => {
  return Array.isArray(props.value);
});

const handleClick = () => {
  if (isObject.value) {
    isOpen.value = !isOpen.value;
  } else {
    // Leaf node: emit expression to be inserted
    const expression = `{{ $node.${props.nodeName}.${props.path} }}`;
    emit('insert-variable', expression);
  }
};

const emitInsert = (expr: string) => {
  emit('insert-variable', expr);
};

const formatValue = (val: any) => {
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (typeof val === 'string') {
    return val.length > 40 ? `"${val.slice(0, 37)}..."` : `"${val}"`;
  }
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  return String(val);
};
</script>
