<template>
  <div class="tree-item">
    <div
      class="tree-row"
      :style="{ paddingLeft: (depth * 16) + 'px' }"
      @click="handleClick"
    >
      <span v-if="isObject && !isBinary" class="tree-toggle">
        {{ isOpen ? '▼' : '▶' }}
      </span>
      <span v-else class="tree-leaf-bullet">{{ isBinary ? '📎' : '●' }}</span>
      <span class="tree-key">{{ label }}</span>
      <template v-if="isBinary">
        <span class="tree-val-preview" style="font-size: 12px;">
          : {{ value.fileName || 'binario' }} ({{ formatBytes(value.size) }})
          <a :href="`/api/binaries/${value._lfBinary}`" target="_blank" rel="noopener" @click.stop style="margin-left: 6px;">descargar</a>
        </span>
      </template>
      <span v-else-if="!isObject" class="tree-val-preview">: {{ formatValue(value) }}</span>
      <span v-else-if="isArray" class="tree-val-preview" style="color: hsl(var(--text-muted)); font-style: italic; font-size: 12px;">
        [ Array({{ value.length }}) ]
      </span>
      <span v-else class="tree-val-preview" style="color: hsl(var(--text-muted)); font-style: italic; font-size: 12px;">
        { Object }
      </span>
    </div>

    <div v-if="isObject && !isBinary && isOpen" class="tree-children">
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

// Referencia a binario: se muestra como un adjunto descargable, no como objeto expandible.
const isBinary = computed(() => {
  return isObject.value && typeof props.value._lfBinary === 'string' && typeof props.value.size === 'number';
});

const formatBytes = (n: number) => {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

const handleClick = () => {
  if (isBinary.value) {
    // Inserta la expresión que referencia el binario (útil para subirlo en otro nodo).
    emit('insert-variable', `{{ $node.${props.nodeName}.${props.path} }}`);
    return;
  }
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
