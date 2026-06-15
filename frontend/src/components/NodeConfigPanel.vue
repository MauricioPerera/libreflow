<template>
  <div v-if="node" class="config-drawer">
    <div class="config-header">
      <div>
        <h3 class="config-title">{{ node.data?.name || node.id }}</h3>
        <span class="node-subtitle">Tipo: {{ node.type }}</span>
      </div>
      <button @click="$emit('close')" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;">
        Cerrar
      </button>
    </div>

    <div class="config-body">
      <!-- Preview Mode Warning Banner -->
      <div v-if="readOnly" class="config-preview-banner" style="background: hsla(var(--color-primary-text) / 0.1); border: 1px solid hsl(var(--color-primary-text)); color: hsl(var(--color-primary-text)); padding: 8px 12px; border-radius: var(--rounded-sm); font-size: 12px; margin-bottom: 16px; display: flex; align-items: center; gap: 8px;">
        <span>⚠️</span> <span><strong>Modo Lectura:</strong> Previsualizando versión histórica.</span>
      </div>

      <!-- Node Name Configuration -->
      <div class="config-group">
        <label class="config-label">Nombre del Nodo</label>
        <input
          v-model="localName"
          @input="emit('update-name', localName)"
          type="text"
          class="config-input"
          placeholder="Nombre del nodo"
          :disabled="readOnly"
        />
      </div>

      <!-- Dynamic SDK Parameter Form Fields -->
      <div v-if="nodeDef" class="node-config-form">
        <div
          v-for="param in nodeDef.parameters"
          :key="param.name"
          v-show="isParamVisible(param)"
          class="config-group"
        >
          <label class="config-label">{{ param.label }}</label>
          
          <!-- Render dropdown options -->
          <div v-if="param.type === 'options'">
            <!-- Special case: Credential ID -->
            <select 
              v-if="param.name === 'credentialId'"
              v-model="localParams[param.name]"
              class="config-select"
              :disabled="readOnly"
              @change="emitUpdate"
            >
              <option value="">-- Ninguna --</option>
              <option 
                v-for="cred in credentialsList" 
                :key="cred.id" 
                :value="cred.id"
              >
                🔑 {{ cred.name }} ({{ cred.type === 'basicAuth' ? 'Basic' : 'API Key' }})
              </option>
            </select>

            <!-- Special case: Target Workflow ID -->
            <select 
              v-else-if="param.name === 'targetWorkflowId'"
              v-model="localParams[param.name]"
              class="config-select"
              :disabled="readOnly"
              @change="emitUpdate"
            >
              <option value="" disabled>Selecciona un flujo de trabajo...</option>
              <option 
                v-for="flow in (workflowsList || []).filter(w => w.id !== workflowId)" 
                :key="flow.id" 
                :value="flow.id"
              >
                📂 {{ flow.name }}
              </option>
            </select>

            <!-- Standard options dropdown -->
            <select 
              v-else
              v-model="localParams[param.name]"
              class="config-select"
              :disabled="readOnly"
              @change="emitUpdate"
            >
              <option 
                v-for="opt in getParamOptions(param)" 
                :key="opt.value" 
                :value="opt.value"
              >
                {{ opt.label }}
              </option>
            </select>
            <span v-if="param.name === 'toolName' && isFetchingTools" style="font-size: 12px; color: hsl(var(--color-primary-text)); display: block; margin-top: 4px;">
              ⏳ Cargando herramientas del servidor MCP...
            </span>
          </div>

          <!-- Render code / json textareas -->
          <div v-else-if="param.type === 'code' || param.type === 'json'" class="input-with-expression" style="width: 100%;">
            <textarea 
              v-model="localParams[param.name]" 
              :placeholder="param.placeholder || ''" 
              class="config-textarea"
              :style="{ minHeight: param.minHeight || '120px' }"
              :disabled="readOnly"
              @change="emitUpdate"
            ></textarea>
            <button 
              v-if="!readOnly"
              type="button" 
              class="btn-expression" 
              style="bottom: 8px; top: auto; right: 8px;"
              title="Abrir editor de expresiones"
              @click="openExpression(param.name, param.label, localParams[param.name] || '')"
            >
              fx
            </button>
            <span
              v-if="param.type === 'json' && jsonFieldError(param.name)"
              class="field-error"
              style="color: hsl(var(--color-danger)); font-size: 12px; display: block; margin-top: 4px;"
            >
              ⚠ {{ jsonFieldError(param.name) }}
            </span>
          </div>

          <!-- Render key-value pairs list -->
          <div v-else-if="param.type === 'keyvalue'" class="keyvalue-list">
            <div 
              v-for="(item, idx) in localParams[param.name]" 
              :key="idx" 
              style="display: flex; gap: 8px; margin-bottom: 8px; align-items: center;"
            >
              <input 
                v-model="item.key" 
                placeholder="Clave/Key" 
                class="config-input" 
                style="flex: 1;" 
                :disabled="readOnly"
                @change="emitUpdate"
              />
              <div class="input-with-expression" style="flex: 1.5; margin: 0;">
                <input 
                  v-model="item.value" 
                  placeholder="Valor/Value" 
                  class="config-input" 
                  style="width: 100%; margin: 0;"
                  :disabled="readOnly"
                  @change="emitUpdate"
                />
                <button 
                  v-if="!readOnly"
                  type="button" 
                  class="btn-expression" 
                  title="Abrir editor de expresiones"
                  @click="openExpression(`${param.name}.${idx}.value`, `${param.label} - Item ${idx + 1}`, item.value || '')"
                >
                  fx
                </button>
              </div>
              <button 
                v-if="!readOnly"
                type="button" 
                class="btn btn-danger" 
                style="padding: 8px 12px; margin: 0; min-height: auto;"
                @click="removeKeyValue(param.name, idx)"
              >
                ✕
              </button>
            </div>
            <button 
              v-if="!readOnly"
              type="button" 
              class="btn btn-secondary" 
              style="padding: 6px 12px; font-size: 12px; min-height: auto;"
              @click="addKeyValue(param.name)"
            >
              ＋ Añadir
            </button>
          </div>

          <!-- Standard string / number fields -->
          <div v-else class="input-with-expression" style="width: 100%;">
            <input 
              v-model="localParams[param.name]" 
              :type="param.type === 'number' ? 'number' : 'text'" 
              :placeholder="param.placeholder || ''"
              class="config-input" 
              style="width: 100%; margin: 0;"
              :disabled="readOnly"
              @change="emitUpdate"
            />
            <button 
              v-if="!readOnly"
              type="button" 
              class="btn-expression" 
              title="Abrir editor de expresiones"
              @click="openExpression(param.name, param.label, localParams[param.name] || '')"
            >
              fx
            </button>
          </div>

          <span
            v-if="param.name === 'cronExpression' && localParams.triggerMode === 'cron' && cronFieldError()"
            class="field-error"
            style="color: hsl(var(--color-danger)); font-size: 12px; display: block; margin-top: 4px;"
          >
            ⚠ {{ cronFieldError() }}
          </span>

          <span v-if="param.description" style="font-size: 12px; color: hsl(var(--text-muted)); margin-top: 4px; display: block; line-height: 1.4;">
            {{ param.description }}
          </span>
        </div>

        <!-- Special Dynamic Helper Info for Loop -->
        <div v-if="node.type === 'loop'" class="config-info-box" style="background: hsl(var(--bg-main)); border: 1px dashed hsl(var(--border-color)); padding: 12px; border-radius: 6px; margin-top: 16px;">
          <h5 style="margin: 0 0 6px 0; font-size: 13px; color: hsl(var(--text-main)); display: flex; align-items: center; gap: 6px;">
            💡 Estructura de Salida
          </h5>
          <span style="font-size: 12px; color: hsl(var(--text-muted)); line-height: 1.4; display: block;">
            Durante cada iteración, el nodo expone las siguientes propiedades:
            <ul style="margin: 6px 0 0 16px; padding: 0;">
              <li><strong>item</strong>: El elemento actual en curso.</li>
              <li><strong>index</strong>: El índice numérico (0-indexed).</li>
              <li><strong>isLast</strong>: Indica si es el último elemento (true/false).</li>
            </ul>
            <span style="display: block; margin-top: 6px;">
              Puedes referenciarlas usando: <code style="background: hsl(var(--bg-surface)); padding: 1px 4px; border-radius: 4px; color: hsl(var(--color-primary-text)); font-family: monospace; font-size: 12px;">{{ '{{ $node.' + node.data?.name + '.output.item }' + '}' }}</code>
            </span>
          </span>
        </div>
      </div>

      <!-- Node Settings (Continue on fail / Retry) -->
      <div class="config-section-separator" style="margin-top: 24px; border-top: 1px solid hsl(var(--border-color)); padding-top: 20px;">
        <h4 class="config-label" style="margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
          ⚙️ Ajustes de Resiliencia
        </h4>

        <!-- Continue on Fail Toggle -->
        <div class="config-group" style="display: flex; flex-direction: row; align-items: center; justify-content: space-between; margin-bottom: 12px;">
          <div style="flex: 1; padding-right: 12px;">
            <label class="config-label" style="font-size: 13px; text-transform: none; letter-spacing: 0;">Continuar si Falla</label>
            <span style="font-size: 12px; color: hsl(var(--text-muted)); display: block; line-height: 1.3;">
              El flujo continúa ejecutándose aunque este nodo lance un error.
            </span>
          </div>
          <label class="switch" style="flex-shrink: 0;">
            <input type="checkbox" v-model="localParams.settings.continueOnFail" :disabled="readOnly" @change="emitUpdate">
            <span class="slider round"></span>
          </label>
        </div>

        <!-- Retry on Fail Toggle -->
        <div class="config-group" style="display: flex; flex-direction: row; align-items: center; justify-content: space-between; margin-bottom: 12px;">
          <div style="flex: 1; padding-right: 12px;">
            <label class="config-label" style="font-size: 13px; text-transform: none; letter-spacing: 0;">Reintentar si Falla</label>
            <span style="font-size: 12px; color: hsl(var(--text-muted)); display: block; line-height: 1.3;">
              Vuelve a intentar la ejecución del nodo si falla por un error.
            </span>
          </div>
          <label class="switch" style="flex-shrink: 0;">
            <input type="checkbox" v-model="localParams.settings.retryOnFail" :disabled="readOnly" @change="emitUpdate">
            <span class="slider round"></span>
          </label>
        </div>

        <!-- Retry details -->
        <div v-if="localParams.settings.retryOnFail" class="config-group" style="padding-left: 12px; border-left: 2px solid hsl(var(--color-primary-text)); gap: 12px; margin-top: 8px; margin-bottom: 16px;">
          <div class="config-group">
            <label class="config-label" style="font-size: 12px;">MÁXIMO DE INTENTOS</label>
            <input 
              v-model.number="localParams.settings.maxRetries" 
              type="number" 
              min="1" 
              max="5" 
              class="config-input"
              :disabled="readOnly"
              @change="emitUpdate"
            />
          </div>
          <div class="config-group">
            <label class="config-label" style="font-size: 12px;">DEMORA ENTRE REINTENTOS (MS)</label>
            <input 
              v-model.number="localParams.settings.retryDelayMs" 
              type="number" 
              min="100" 
              max="10000"
              step="500"
              class="config-input"
              :disabled="readOnly"
              @change="emitUpdate"
            />
          </div>
        </div>
      </div>

      <!-- Results / Logs from Execution -->
      <div v-if="result" class="results-section">
        <h4 class="config-label" style="margin-bottom: 8px;">Bitácora de Ejecución</h4>
        
        <div :class="['results-badge', result.status]">
          <span v-if="result.status === 'success'">● Completado con éxito</span>
          <span v-else-if="result.status === 'failed'">● Error en la ejecución</span>
          <span v-else>● Omitido (No ejecutado)</span>
        </div>

        <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">
          <div v-if="result.durationMs !== undefined">Duración: {{ result.durationMs }}ms</div>
          <div v-if="result.startTime">Ejecutado: {{ formatTime(result.startTime) }}</div>
        </div>

        <!-- Success Payload -->
        <div v-if="result.output">
          <label class="config-label" style="font-size: var(--font-xs); margin-bottom: 4px;">Datos de Salida</label>
          <pre class="results-code">{{ formatJson(result.output) }}</pre>
        </div>

        <!-- Failure message -->
        <div v-if="result.error">
          <label class="config-label" style="font-size: var(--font-xs); margin-bottom: 4px; color: hsl(var(--color-danger));">Error</label>
          <pre class="results-code" style="border-color: hsl(var(--color-danger) / 0.3); color: hsl(var(--color-danger));">{{ result.error }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, inject, Ref, onUnmounted } from 'vue';

interface NodeParameterSchema {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'options' | 'code' | 'json' | 'expression' | 'keyvalue';
  default?: any;
  placeholder?: string;
  description?: string;
  options?: { label: string; value: any }[];
  minHeight?: string;
}

interface NodeDef {
  type: string;
  displayName: string;
  icon: string;
  parameters: NodeParameterSchema[];
  ui?: {
    subtitle?: string;
  };
}

const props = withDefaults(
  defineProps<{
    node: any;
    workflowsList?: any[];
    workflowId?: string | null;
    credentialsList?: any[];
    readOnly?: boolean;
    result?: any;
  }>(),
  {
    workflowsList: () => [],
    workflowId: null,
    credentialsList: () => [],
    readOnly: false,
    result: null
  }
);

const emit = defineEmits<{
  (e: 'update-params', params: any): void;
  (e: 'update-name', name: string): void;
  (e: 'open-expression-editor', targetField: string, displayName: string, expression: string): void;
  (e: 'close'): void;
}>();

const localParams = ref<Record<string, any>>({ settings: {} });
const localName = ref<string>('');

const nodeTypesList = inject<Ref<NodeDef[]>>('nodeTypesList');

const nodeDef = computed(() => {
  return nodeTypesList?.value.find(n => n.type === props.node?.type);
});

// Initialize params reactively
const initializeParams = () => {
  if (!props.node) return;

  localName.value = props.node.data?.name || '';
  const current = JSON.parse(JSON.stringify(props.node.data?.parameters || {}));
  
  if (nodeDef.value) {
    for (const param of nodeDef.value.parameters) {
      if (current[param.name] === undefined) {
        current[param.name] = param.default !== undefined ? JSON.parse(JSON.stringify(param.default)) : '';
      }
    }
  }

  // Ensure settings exists
  if (!current.settings) {
    current.settings = {
      continueOnFail: false,
      retryOnFail: false,
      maxRetries: 3,
      retryDelayMs: 1000
    };
  }
  
  localParams.value = current;
};

// Re-initialize parameters when node changes or dynamic definition loads
watch([() => props.node?.id, () => nodeDef.value], initializeParams, { immediate: true });

// Emit changes up to parent
const emitUpdate = () => {
  emit('update-params', JSON.parse(JSON.stringify(localParams.value)));
};

// Inline validation: returns an error string (or '') for JSON / cron fields.
const jsonFieldError = (name: string): string => {
  const v = localParams.value[name];
  if (v == null || v === '') return '';
  if (typeof v !== 'string') return ''; // already structured
  try {
    JSON.parse(v);
    return '';
  } catch (e: any) {
    return `JSON inválido: ${e.message}`;
  }
};

const cronFieldError = (): string => {
  const v = localParams.value['cronExpression'];
  if (!v) return '';
  const parts = String(v).trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) {
    return 'Expresión cron inválida (se esperan 5 o 6 campos).';
  }
  return '';
};

// Generic Key-Value Helpers
const addKeyValue = (paramName: string) => {
  if (!localParams.value[paramName]) {
    localParams.value[paramName] = [];
  }
  localParams.value[paramName].push({ key: '', value: '' });
  emitUpdate();
};

const removeKeyValue = (paramName: string, index: number) => {
  localParams.value[paramName].splice(index, 1);
  emitUpdate();
};

// Expression modal hook
const openExpression = (field: string, label: string, val: string) => {
  emit('open-expression-editor', field, label, val);
};

// Formatting helpers
const formatJson = (val: any) => {
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
};

const formatTime = (timeStr: string) => {
  try {
    return new Date(timeStr).toLocaleTimeString();
  } catch {
    return timeStr;
  }
};

// Dynamic MCP Tool Options Resolution
const dynamicOptions = ref<Record<string, { label: string; value: any }[]>>({});
const isFetchingTools = ref(false);

const getParamOptions = (param: NodeParameterSchema) => {
  if (props.node?.type === 'mcpToolCall' && param.name === 'toolName') {
    return dynamicOptions.value['toolName'] || [];
  }
  if ((props.node?.type === 'dataTable' || props.node?.type === 'trigger') && param.name === 'tableId') {
    return dynamicOptions.value['tableId'] || [];
  }
  if (props.node?.type === 'aiAgent' && param.name === 'mcpServerId') {
    return dynamicOptions.value['mcpServerId'] || [];
  }
  return param.options || [];
};

// Hides trigger-mode-specific fields when their mode isn't selected (keeps the form clean).
const isParamVisible = (param: NodeParameterSchema) => {
  const mode = localParams.value?.triggerMode;
  if (param.name === 'cronExpression') return mode === 'cron';
  if (param.name === 'tableEvent') return mode === 'dataTable';
  if (param.name === 'tableId' && props.node?.type === 'trigger') return mode === 'dataTable';
  if (param.name === 'inputSchema') return mode !== 'dataTable';
  return true;
};

let debounceTimeout: any = null;
// Monotonic token so a slow response from a previous node/URL can't overwrite a newer one. (FE-6)
let mcpFetchToken = 0;

const fetchMcpTools = async (url: string) => {
  const token = ++mcpFetchToken;
  if (!url) {
    dynamicOptions.value['toolName'] = [];
    return;
  }

  // Syntax check
  try {
    new URL(url);
  } catch {
    dynamicOptions.value['toolName'] = [];
    return;
  }

  try {
    isFetchingTools.value = true;
    const res = await fetch(`/api/mcp/client/tools?serverUrl=${encodeURIComponent(url)}`);
    if (token !== mcpFetchToken) return; // a newer fetch superseded this one — discard
    if (res.ok) {
      const tools = await res.json();
      dynamicOptions.value['toolName'] = tools.map((t: any) => ({
        label: `${t.name} (${t.description || 'Sin descripción'})`,
        value: t.name
      }));
    } else {
      dynamicOptions.value['toolName'] = [];
    }
  } catch (err) {
    console.error('Error fetching MCP tools:', err);
    if (token === mcpFetchToken) dynamicOptions.value['toolName'] = [];
  } finally {
    if (token === mcpFetchToken) isFetchingTools.value = false;
  }
};

watch(() => localParams.value?.serverUrl, (newUrl) => {
  if (props.node?.type === 'mcpToolCall') {
    if (debounceTimeout) clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(() => {
      fetchMcpTools(newUrl);
    }, 500);
  }
}, { immediate: true });

const fetchDataTablesForDropdown = async () => {
  try {
    const res = await fetch('/api/data-tables');
    if (res.ok) {
      const list = await res.json();
      dynamicOptions.value['tableId'] = list.map((t: any) => ({
        label: t.name,
        value: t.id
      }));
    } else {
      dynamicOptions.value['tableId'] = [];
    }
  } catch (err) {
    console.error('Error fetching data tables for dropdown:', err);
    dynamicOptions.value['tableId'] = [];
  }
};

const fetchMcpServersForDropdown = async () => {
  try {
    const res = await fetch('/api/mcp-servers');
    const list = res.ok ? await res.json() : [];
    dynamicOptions.value['mcpServerId'] = [
      { label: 'Sin herramientas (solo LLM)', value: '' },
      ...list.map((s: any) => ({ label: `🔌 ${s.name} (${(s.workflow_ids || []).length} flujos)`, value: s.id })),
    ];
  } catch (err) {
    console.error('Error fetching MCP servers for dropdown:', err);
    dynamicOptions.value['mcpServerId'] = [{ label: 'Sin herramientas (solo LLM)', value: '' }];
  }
};

watch(() => props.node?.id, () => {
  if (props.node?.type === 'dataTable' || props.node?.type === 'trigger') {
    fetchDataTablesForDropdown();
  }
  if (props.node?.type === 'aiAgent') {
    fetchMcpServersForDropdown();
  }
}, { immediate: true });

onUnmounted(() => {
  if (debounceTimeout) clearTimeout(debounceTimeout);
});
</script>
