<template>
  <div class="modal-overlay" style="z-index: 150;" role="dialog" aria-modal="true" v-focus-trap @click.self="$emit('close')">
    <div class="modal-content expression-editor-modal">
      <div class="expression-editor-header">
        <div>
          <h3 class="modal-title">Editor de Expresiones</h3>
          <p class="modal-desc">Asigna valores dinámicos utilizando datos de los nodos predecesores.</p>
        </div>
        <button @click="$emit('close')" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;">
          ✕
        </button>
      </div>

      <div class="expression-editor-body">
        <!-- Left Panel: Variables Tree -->
        <div class="variables-panel">
          <div class="panel-header-title">SALIDAS DE NODOS PREDECESORES</div>
          
          <div class="variables-tree-container">
            <div 
              v-for="node in precedingNodes" 
              :key="node.id" 
              class="node-tree-group"
            >
              <div class="node-tree-header" @click="toggleNodeExpand(node.id)">
                <span class="node-tree-toggle-icon">
                  {{ expandedNodes[node.id] ? '▼' : '▶' }}
                </span>
                <span class="node-tree-icon">⚡</span>
                <span class="node-tree-name">{{ node.data?.name || node.id }}</span>
                <span class="node-tree-type">({{ node.type }})</span>
              </div>
              
              <div v-if="expandedNodes[node.id]" class="node-tree-content">
                <div v-if="getNodeOutput(node.id)" class="tree-root-wrapper">
                  <JsonTreeItem
                    label="output"
                    :value="getNodeOutput(node.id)"
                    path="output"
                    :nodeName="node.data?.name || node.id"
                    :depth="0"
                    @insert-variable="insertVariable"
                  />
                </div>
                <div v-else class="node-tree-empty-message">
                  No hay datos de ejecución. Ejecuta el flujo primero.
                </div>
              </div>
            </div>
            
            <div v-if="precedingNodes.length === 0" class="empty-variables-message">
              Este nodo no tiene nodos predecesores en el flujo de trabajo.
            </div>
          </div>
        </div>

        <!-- Right Panel: Editor & Preview -->
        <div class="work-panel">
          <!-- Textarea area -->
          <div class="editor-section">
            <div class="panel-header-title">EXPRESIÓN (PARÁMETRO: {{ fieldName.toUpperCase() }})</div>
            <textarea
              ref="textareaRef"
              v-model="expressionText"
              class="expression-textarea"
              placeholder="Ingresa texto o haz clic en variables del árbol izquierdo... (ej: Hola {{ $node.FiltroUsuario.output.rolRequerido }})"
            ></textarea>
          </div>

          <!-- Preview area -->
          <div class="preview-section">
            <div class="panel-header-title">VISTA PREVIA DEL RESULTADO EVALUADO</div>
            <div class="expression-preview-container">
              <pre v-if="expressionText" class="results-code preview-output-box">{{ evaluatedPreview }}</pre>
              <div v-else class="empty-preview-message">
                Escribe una expresión para previsualizar el resultado.
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-actions" style="margin-top: 16px; justify-content: flex-end; gap: 12px;">
        <button @click="$emit('close')" class="btn btn-secondary">Cancelar</button>
        <button @click="confirmExpression" class="btn btn-primary">Aplicar Expresión</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import JsonTreeItem from './JsonTreeItem.vue';

const props = defineProps<{
  fieldName: string;
  value: string;
  nodes: any[];
  edges: any[];
  currentNodeId: string;
  executionReport: any;
}>();

const emit = defineEmits<{
  (e: 'confirm', expression: string): void;
  (e: 'close'): void;
}>();

const expressionText = ref('');
const expandedNodes = ref<Record<string, boolean>>({});
const textareaRef = ref<HTMLTextAreaElement | null>(null);

// Initialize states
onMounted(() => {
  expressionText.value = props.value || '';
  // Expand preceding nodes by default if they have outputs
  precedingNodes.value.forEach(node => {
    expandedNodes.value[node.id] = getNodeOutput(node.id) !== null;
  });
});

// BFS backward traversal to find all ancestor nodes
const precedingNodes = computed(() => {
  const preceding = new Set<string>();
  const queue = [props.currentNodeId];
  
  while (queue.length > 0) {
    const current = queue.shift()!;
    // Find all incoming edges to the current node
    const parents = props.edges
      .filter(e => e.target === current)
      .map(e => e.source);
      
    for (const p of parents) {
      if (!preceding.has(p)) {
        preceding.add(p);
        queue.push(p);
      }
    }
  }
  
  // Return matching node objects
  return props.nodes.filter(n => preceding.has(n.id) && n.id !== props.currentNodeId);
});

const toggleNodeExpand = (nodeId: string) => {
  expandedNodes.value[nodeId] = !expandedNodes.value[nodeId];
};

const getNodeOutput = (nodeId: string) => {
  const results = props.executionReport?.nodeResults || {};
  const result = results[nodeId];
  if (result && result.status === 'success' && result.output) {
    return result.output;
  }
  return null;
};

// Injects variable string at current cursor position
const insertVariable = (expr: string) => {
  const textarea = textareaRef.value;
  if (!textarea) {
    expressionText.value += expr;
    return;
  }
  
  const startPos = textarea.selectionStart;
  const endPos = textarea.selectionEnd;
  const currentText = expressionText.value;
  
  expressionText.value = currentText.substring(0, startPos) + expr + currentText.substring(endPos);
  
  // Refocus and move cursor after the inserted expression
  setTimeout(() => {
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = startPos + expr.length;
  }, 50);
};

// Evaluate preview in real-time
const evaluatedPreview = computed(() => {
  if (!expressionText.value) return '';
  
  // Gather node results mapping names to output
  const context: Record<string, any> = {};
  props.nodes.forEach(node => {
    const output = getNodeOutput(node.id);
    if (output) {
      context[node.data?.name || node.id] = { output };
    }
  });

  // Check if expression is single full match: {{ $node.x.output.y }}
  const fullExpressionMatch = expressionText.value.trim().match(/^\{\{\s*(.*?)\s*\}\}$/);
  if (fullExpressionMatch) {
    const resolved = evaluateSingle(fullExpressionMatch[1], context);
    return formatPreviewResult(resolved);
  }

  // Otherwise interpolate multiple matches inside string
  const interpolated = expressionText.value.replace(/\{\{\s*(.*?)\s*\}\}/g, (_, expr) => {
    const resolved = evaluateSingle(expr, context);
    if (resolved === undefined || resolved === null) return '';
    return typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved);
  });
  
  return interpolated;
});

const evaluateSingle = (expr: string, context: Record<string, any>): any => {
  const trimmed = expr.trim();
  if (!trimmed.startsWith('$node.')) {
    return `[Error: Expresión debe comenzar con $node]`;
  }
  
  const parts = trimmed.split('.');
  if (parts.length < 3) {
    return `[Error: Ruta incompleta. Esperado: $node.NombreNodo.output.campo]`;
  }
  
  const nodeName = parts[1];
  const nodeContext = context[nodeName];
  if (!nodeContext) {
    return `[Sin datos para nodo: ${nodeName}]`;
  }
  
  // parts[2] should be "output"
  const path = parts.slice(2);
  let current = nodeContext;
  for (const p of path) {
    if (current === null || current === undefined) return undefined;
    current = current[p];
  }
  return current;
};

const formatPreviewResult = (val: any) => {
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (typeof val === 'object') {
    return JSON.stringify(val, null, 2);
  }
  return String(val);
};

const confirmExpression = () => {
  emit('confirm', expressionText.value);
};
</script>
