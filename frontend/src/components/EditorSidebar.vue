<script setup lang="ts">
// Panel derecho del editor: pestañas Parámetros (NodeConfigPanel o ajustes del flujo) / Historial
// de ejecuciones / Historial de versiones, más el botón de colapsar. Presentacional: re-emite los
// eventos de NodeConfigPanel y los del historial/versiones; App.vue mantiene el estado y los fetch.
import NodeConfigPanel from './NodeConfigPanel.vue';
import { formatFullDate } from '../utils';

defineProps<{
  collapsed: boolean;
  activeTab: 'config' | 'history' | 'versions';
  selectedNode: any | null;
  panelUpdateKey: number;
  nodeResult: any;
  workflowId: string | null;
  credentialsList: any[];
  workflowsList: any[];
  readOnly: boolean;
  onErrorWorkflowId: string;
  executions: any[];
  activeExecutionId: string | null;
  versions: any[];
  previewedVersion: number | null;
}>();

const emit = defineEmits<{
  (e: 'update:collapsed', v: boolean): void;
  (e: 'change-tab', tab: 'config' | 'history' | 'versions'): void;
  (e: 'update:onErrorWorkflowId', v: string): void;
  (e: 'update-params', params: any): void;
  (e: 'update-name', name: string): void;
  (e: 'set-pin', payload: any): void;
  (e: 'rerun', payload: any): void;
  (e: 'close'): void;
  (e: 'open-expression-editor', field: string, label: string, val: string): void;
  (e: 'load-past-execution', id: string): void;
  (e: 'preview-version', version: number): void;
  (e: 'cancel-preview'): void;
  (e: 'restore-version', version: number): void;
}>();
</script>

<template>
  <aside :class="['right-sidebar', { collapsed }]">
    <!-- Botón flotante para colapsar/expandir el panel -->
    <button
      @click="emit('update:collapsed', !collapsed)"
      :class="['sidebar-toggle-btn', { collapsed }]"
      :title="collapsed ? 'Mostrar parámetros' : 'Ocultar parámetros'"
    >
      <span v-if="collapsed">◀</span>
      <span v-else>▶</span>
    </button>

    <div class="right-sidebar-content">
      <!-- Cabeceras de pestañas -->
      <div class="sidebar-tabs">
        <button @click="emit('change-tab', 'config')" :class="['tab-btn', { active: activeTab === 'config' }]">
          🔧 Parámetros
        </button>
        <button @click="emit('change-tab', 'history')" :class="['tab-btn', { active: activeTab === 'history' }]" :disabled="!workflowId">
          ⏳ Historial
        </button>
        <button @click="emit('change-tab', 'versions')" :class="['tab-btn', { active: activeTab === 'versions' }]" :disabled="!workflowId">
          📜 Versiones
        </button>
      </div>

      <!-- Pestaña: Parámetros -->
      <div v-show="activeTab === 'config'" class="tab-content-container">
        <NodeConfigPanel
          v-if="selectedNode"
          :key="selectedNode.id + '-' + panelUpdateKey"
          :node="selectedNode"
          :result="nodeResult"
          :workflowId="workflowId"
          :credentialsList="credentialsList"
          :workflowsList="workflowsList"
          :readOnly="readOnly"
          @update-params="emit('update-params', $event)"
          @update-name="emit('update-name', $event)"
          @set-pin="emit('set-pin', $event)"
          @rerun="emit('rerun', $event)"
          @close="emit('close')"
          @open-expression-editor="(f: string, l: string, v: string) => emit('open-expression-editor', f, l, v)"
        />
        <div v-else class="workflow-settings-container" style="display: flex; flex-direction: column; height: 100%;">
          <div class="config-header">
            <div>
              <h3 class="config-title">⚙️ Ajustes del Flujo</h3>
              <span class="node-subtitle">Opciones globales del flujo</span>
            </div>
          </div>
          <div class="config-body" style="padding: 16px; display: flex; flex-direction: column; gap: 16px;">
            <div class="config-group">
              <label class="config-label">Flujo de Error (Global)</label>
              <p class="config-desc" style="margin-top: 4px; margin-bottom: 8px; font-size: 12px; color: hsl(var(--text-muted)); line-height: 1.4;">
                Selecciona un flujo de contingencia que se ejecutará automáticamente si la ejecución de este flujo falla.
              </p>
              <select
                :value="onErrorWorkflowId"
                @change="emit('update:onErrorWorkflowId', ($event.target as HTMLSelectElement).value)"
                class="config-select"
                style="width: 100%;"
              >
                <option value="">-- Ninguno --</option>
                <option
                  v-for="flow in workflowsList.filter(w => w.id !== workflowId)"
                  :key="flow.id"
                  :value="flow.id"
                >
                  {{ flow.name }}
                </option>
              </select>
            </div>
            <div class="config-info-box" style="margin-top: 8px; background: hsla(var(--text-primary) / 0.03); border: 1px solid hsl(var(--border-color)); padding: 12px; border-radius: var(--rounded-md);">
              <div style="font-size: 12px; color: hsl(var(--text-secondary)); font-weight: 500; display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
                <span>ℹ️</span> Payload del Error
              </div>
              <p style="font-size: 12px; color: hsl(var(--text-muted)); margin: 0; line-height: 1.4;">
                El flujo de contingencia recibirá un payload inicial conteniendo: <code>executionId</code>, <code>workflowId</code>, <code>workflowName</code>, <code>error</code> y <code>failedNodeName</code>.
              </p>
            </div>
          </div>
          <div class="empty-sidebar-message" style="height: auto; padding: 20px 40px; border-top: 1px dashed hsl(var(--border-color)); margin-top: auto; flex-grow: 1;">
            Selecciona un nodo del lienzo para configurar sus parámetros individuales.
          </div>
        </div>
      </div>

      <!-- Pestaña: Historial de Ejecuciones -->
      <div v-show="activeTab === 'history'" class="tab-content-container execution-history-list">
        <div class="config-header" style="border-bottom: none; padding-bottom: 0;">
          <h3 class="config-title">Historial de Ejecuciones</h3>
        </div>
        <div class="history-list-body">
          <div
            v-for="exec in executions"
            :key="exec.id"
            @click="emit('load-past-execution', exec.id)"
            :class="['history-item', exec.status, { active: activeExecutionId === exec.id }]"
          >
            <div class="history-item-header">
              <span class="history-status-indicator">●</span>
              <span class="history-item-id">{{ exec.id }}</span>
            </div>
            <div class="history-item-time">
              {{ formatFullDate(exec.executed_at) }}
            </div>
          </div>
          <div v-if="executions.length === 0" class="empty-history-message">
            No hay ejecuciones registradas para este flujo. Ejecuta el flujo para ver los reportes.
          </div>
        </div>
      </div>

      <!-- Pestaña: Historial de Versiones -->
      <div v-show="activeTab === 'versions'" class="tab-content-container execution-history-list">
        <div class="config-header" style="border-bottom: none; padding-bottom: 0;">
          <h3 class="config-title">Historial de Versiones</h3>
        </div>
        <div class="history-list-body">
          <div
            v-for="ver in versions"
            :key="ver.id"
            :class="['history-item', { active: previewedVersion === ver.version }]"
            style="cursor: default; display: flex; flex-direction: column; gap: 8px; padding: 12px; border-bottom: 1px solid hsl(var(--border-color));"
          >
            <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
              <span style="font-weight: 600; color: hsl(var(--text-primary)); font-size: 13px;">
                Versión #{{ ver.version }}
              </span>
              <span style="font-size: 12px; color: hsl(var(--text-muted));">
                {{ formatFullDate(ver.created_at) }}
              </span>
            </div>
            <div style="display: flex; gap: 8px; margin-top: 4px; width: 100%;">
              <button
                v-if="previewedVersion !== ver.version"
                @click="emit('preview-version', ver.version)"
                class="btn btn-secondary"
                style="flex: 1; padding: 6px; font-size: 12px; text-align: center; margin: 0;"
              >
                Previsualizar
              </button>
              <button
                v-else
                @click="emit('cancel-preview')"
                class="btn btn-secondary"
                style="flex: 1; padding: 6px; font-size: 12px; text-align: center; border-color: hsl(var(--text-muted)); color: hsl(var(--text-secondary)); margin: 0;"
              >
                Volver
              </button>
              <button
                @click="emit('restore-version', ver.version)"
                class="btn btn-primary"
                style="flex: 1; padding: 6px; font-size: 12px; text-align: center; background: hsl(var(--color-primary)); margin: 0;"
              >
                Restaurar
              </button>
            </div>
          </div>
          <div v-if="versions.length === 0" class="empty-history-message">
            No hay versiones registradas para este flujo. Se creará una versión automáticamente al guardar.
          </div>
        </div>
      </div>
    </div>
  </aside>
</template>
