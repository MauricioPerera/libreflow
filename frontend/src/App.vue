<template>
  <!-- DASHBOARD VIEW -->
  <div v-if="currentView === 'dashboard'" class="dashboard-layout">
    <!-- Left Navigation Sidebar -->
    <aside class="dashboard-sidebar">
      <div class="sidebar-brand">
        <span class="brand-logo">⚡ LibreFlow</span>
      </div>
      <nav class="sidebar-menu">
        <button 
          @click="activeSubView = 'workflows'" 
          :class="['menu-btn', { active: activeSubView === 'workflows' }]"
        >
          📂 Flujos de Trabajo
        </button>
        <button 
          @click="activeSubView = 'executions'; fetchGlobalExecutions()" 
          :class="['menu-btn', { active: activeSubView === 'executions' }]"
        >
          ⏳ Ejecuciones
        </button>
        <button 
          @click="activeSubView = 'credentials'; fetchCredentials()" 
          :class="['menu-btn', { active: activeSubView === 'credentials' }]"
        >
          🔑 Credenciales
        </button>
        <button
          @click="activeSubView = 'datatables'; fetchDataTables()"
          :class="['menu-btn', { active: activeSubView === 'datatables' }]"
        >
          📊 Tablas de Datos
        </button>
        <button
          @click="activeSubView = 'mcpservers'; fetchMcpServers(); fetchSavedWorkflows()"
          :class="['menu-btn', { active: activeSubView === 'mcpservers' }]"
        >
          🔌 Servidores MCP
        </button>
      </nav>
    </aside>

    <!-- Main Content Panel -->
    <main class="dashboard-content">
      <!-- WORKFLOWS SUBVIEW -->
      <FlowsView
        v-if="activeSubView === 'workflows'"
        :workflows="savedWorkflowsList"
        :loaded="dashboardLoaded"
        @validate="openBatchValidate"
        @create="createNewWorkflow"
        @edit="loadWorkflowForEdit"
        @delete="deleteWorkflowFromDb"
      />

      <!-- CREDENTIALS SUBVIEW -->
      <CredentialsView
        v-if="activeSubView === 'credentials'"
        :credentials="credentialsList"
        :loaded="dashboardLoaded"
        @create="openCreateCredential"
        @edit="openEditCredential"
        @delete="deleteCredentialFromDb"
      />

      <!-- GLOBAL EXECUTIONS SUBVIEW -->
      <ExecutionsView
        v-if="activeSubView === 'executions'"
        :executions="globalExecutionsList"
        :loaded="dashboardLoaded"
        @open="loadPastExecutionFromDashboard"
        @ai-context="openAiContext"
      />

      <!-- DATA TABLES SUBVIEW -->
      <div v-if="activeSubView === 'datatables'" class="subview-container">
        <!-- Table Details (Spreadsheet) -->
        <DataTableDetail
          v-if="selectedTable"
          :table="selectedTable"
          :rows="selectedTableRows"
          :editing-row-id="editingRowId"
          :editing-row-data="editingRowData"
          @back="selectedTable = null"
          @add-row="openAddRowModal"
          @edit-schema="openEditTableSchemaModal"
          @start-edit="startInlineRowEdit"
          @cancel-edit="editingRowId = null"
          @save-edit="saveInlineRowEdit"
          @delete-row="deleteRowFromTable"
        />

        <!-- Tables List -->
        <DataTablesList
          v-else
          :tables="dataTablesList"
          :loaded="dashboardLoaded"
          @create="openCreateTableModal"
          @select="loadTableDetails"
          @delete="deleteTableFromDb"
        />
      </div>

      <!-- MCP SERVERS SUBVIEW -->
      <McpServersView
        v-if="activeSubView === 'mcpservers'"
        :servers="mcpServersList"
        :loaded="dashboardLoaded"
        @create="openCreateMcpServerModal"
        @edit="openEditMcpServerModal"
        @delete="deleteMcpServerFromDb"
        @copy="copyMcpText"
      />
    </main>
  </div>

  <!-- EDITOR VIEW -->
  <div v-else-if="currentView === 'editor'" class="libreflow-layout">
    <!-- Editor Header -->
    <header class="libreflow-header">
      <div class="brand-section">
        <button @click="exitEditor" class="btn btn-secondary" style="padding: 8px 14px;">
          ← Volver
        </button>
        <div class="editor-title-container">
          <input 
            v-model="activeWorkflowName" 
            type="text" 
            class="editor-title-input" 
            placeholder="Flujo sin Nombre"
            :disabled="isPreviewMode"
          />
        </div>
      </div>

      <div class="action-buttons" style="display: flex; align-items: center; gap: 12px;">
        <!-- Active Toggle Switch (Only if workflow is saved/has ID) -->
        <div v-if="activeWorkflowId" class="workflow-active-toggle-container">
          <span class="active-toggle-label">{{ isActiveWorkflow ? 'Activo' : 'Inactivo' }}</span>
          <label class="switch">
            <input type="checkbox" v-model="isActiveWorkflow" :disabled="isPreviewMode" @change="toggleWorkflowActiveState">
            <span class="slider round"></span>
          </label>
        </div>

        <button @click="promptSaveWorkflow" :disabled="isPreviewMode" class="btn btn-secondary" style="border-color: hsla(var(--color-primary) / 0.4); color: hsl(var(--color-primary)); margin: 0;">
          💾 Guardar
        </button>
        <button
          @click="runWorkflow()"
          :disabled="isRunning || isPreviewMode"
          class="btn btn-primary"
          style="margin: 0;"
        >
          <span v-if="isRunning">Ejecutando...</span>
          <span v-else>▶ Ejecutar Flujo</span>
        </button>
      </div>
    </header>

    <!-- Preview Mode Banner -->
    <div v-if="isPreviewMode" class="preview-mode-banner" style="background: hsla(var(--accent-amber) / 0.15); border-bottom: 1px solid hsl(var(--accent-amber)); padding: 10px 24px; display: flex; align-items: center; justify-content: space-between; font-size: 13px; color: hsl(var(--text-primary)); z-index: 100;">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="color: hsl(var(--accent-amber)); font-size: 16px;">⚠️</span>
        <span>Estás previsualizando la <strong>Versión #{{ previewedVersionNumber }}</strong> (Modo Lectura). Las modificaciones en el lienzo están deshabilitadas.</span>
      </div>
      <div style="display: flex; gap: 12px;">
        <button @click="restoreWorkflowVersion(previewedVersionNumber!)" class="btn btn-primary" style="margin: 0; padding: 6px 14px; font-size: 12px; background: hsl(var(--color-primary));">
          Restaurar esta Versión
        </button>
        <button @click="cancelPreview" class="btn btn-secondary" style="margin: 0; padding: 6px 14px; font-size: 12px; border-color: hsl(var(--text-muted)); color: hsl(var(--text-secondary));">
          Volver al Editor
        </button>
      </div>
    </div>

    <!-- Editor Workspace -->
    <main class="libreflow-workspace">
      <!-- Floating Node Selector (Left Panel) -->
      <aside v-if="!isPreviewMode" :class="['node-selector', 'editor-floating-left', { collapsed: isNodeSelectorCollapsed }]">
        <div class="node-selector-header">
          <h4 class="node-selector-title">Agregar Nodos</h4>
          <button @click="isNodeSelectorCollapsed = true" class="sidebar-close-btn" title="Ocultar panel">✕</button>
        </div>
        <button 
          v-for="nodeDef in nodeTypesList" 
          :key="nodeDef.type" 
          @click="addNode(nodeDef.type)" 
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

      <!-- Floating Toggle Button to re-open Node Selector (Only when collapsed) -->
      <button 
        v-if="isNodeSelectorCollapsed && !isPreviewMode" 
        @click="isNodeSelectorCollapsed = false" 
        class="floating-node-selector-toggle"
        title="Mostrar panel de nodos"
      >
        ＋ Agregar Nodo
      </button>

      <!-- Vue Flow Canvas -->
      <section class="canvas-container">
        <!-- Validador de coherencia: resultado del último guardado -->
        <div v-if="showValidationBanner && validationIssues.length" class="validation-banner" role="status">
          <div class="validation-banner-head">
            <strong>
              {{ validationErrorCount > 0 ? '⚠️ Problemas de coherencia' : 'ℹ️ Avisos de coherencia' }}
              ({{ validationErrorCount }} error{{ validationErrorCount === 1 ? '' : 'es' }},
              {{ validationIssues.length - validationErrorCount }} aviso{{ (validationIssues.length - validationErrorCount) === 1 ? '' : 's' }})
            </strong>
            <button class="validation-banner-close" @click="showValidationBanner = false" aria-label="Cerrar">✕</button>
          </div>
          <ul class="validation-banner-list">
            <li
              v-for="(issue, i) in validationIssues"
              :key="i"
              :class="['validation-issue', issue.level, { clickable: !!issue.nodeId }]"
              @click="issue.nodeId && focusIssueNode(issue.nodeId)"
            >
              <span class="validation-dot" :class="issue.level"></span>
              {{ issue.message }}
            </li>
          </ul>
        </div>
        <VueFlow
          v-model:nodes="nodes"
          v-model:edges="edges"
          @connect="onConnect"
          @node-click="onNodeClick"
          @pane-click="onPaneClick"
          :fit-view-on-init="true"
          :nodes-draggable="!isPreviewMode"
          :nodes-connectable="!isPreviewMode"
          :edges-updatable="!isPreviewMode"
          :delete-key-path="isPreviewMode ? null : 'Delete'"
          :node-types="nodeTypes"
        >
          <Background pattern-color="#555" :gap="16" />
          <Controls />
        </VueFlow>
      </section>

      <!-- Right Panel: Configurations or Execution History -->
      <aside :class="['right-sidebar', { collapsed: isRightSidebarCollapsed }]">
        <!-- Floating tab-toggle button sticking out of the sidebar to collapse/expand it -->
        <button 
          @click="isRightSidebarCollapsed = !isRightSidebarCollapsed" 
          :class="['sidebar-toggle-btn', { collapsed: isRightSidebarCollapsed }]"
          :title="isRightSidebarCollapsed ? 'Mostrar parámetros' : 'Ocultar parámetros'"
        >
          <span v-if="isRightSidebarCollapsed">◀</span>
          <span v-else>▶</span>
        </button>

        <div class="right-sidebar-content">
          <!-- Tab Headers -->
          <div class="sidebar-tabs">
            <button 
              @click="activeTab = 'config'" 
              :class="['tab-btn', { active: activeTab === 'config' }]"
            >
              🔧 Parámetros
            </button>
            <button 
              @click="activeTab = 'history'" 
              :class="['tab-btn', { active: activeTab === 'history' }]"
              :disabled="!activeWorkflowId"
            >
              ⏳ Historial
            </button>
            <button 
              @click="activeTab = 'versions'; fetchWorkflowVersions(activeWorkflowId)" 
              :class="['tab-btn', { active: activeTab === 'versions' }]"
              :disabled="!activeWorkflowId"
            >
              📜 Versiones
            </button>
          </div>

          <!-- Tab Content: Property Panel -->
          <div v-show="activeTab === 'config'" class="tab-content-container">
            <NodeConfigPanel
              v-if="selectedNode"
              :key="selectedNode.id + '-' + panelUpdateKey"
              :node="selectedNode"
              :result="getExecutionResultForNode(selectedNode.id)"
              :workflowId="activeWorkflowId"
              :credentialsList="credentialsList"
              :workflowsList="savedWorkflowsList"
              :readOnly="isPreviewMode"
              @update-params="updateNodeParams"
              @update-name="updateNodeName"
              @set-pin="setNodePin"
              @rerun="rerunFromNode"
              @close="selectedNode = null"
              @open-expression-editor="handleOpenExpressionEditor"
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
                  <select v-model="onErrorWorkflowId" class="config-select" style="width: 100%;">
                    <option value="">-- Ninguno --</option>
                    <option 
                      v-for="flow in savedWorkflowsList.filter(w => w.id !== activeWorkflowId)" 
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

          <!-- Tab Content: Execution History -->
          <div v-show="activeTab === 'history'" class="tab-content-container execution-history-list">
            <div class="config-header" style="border-bottom: none; padding-bottom: 0;">
              <h3 class="config-title">Historial de Ejecuciones</h3>
            </div>
            
            <div class="history-list-body">
              <div 
                v-for="exec in workflowExecutionsList" 
                :key="exec.id" 
                @click="loadPastExecution(exec.id)"
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
              
              <div v-if="workflowExecutionsList.length === 0" class="empty-history-message">
                No hay ejecuciones registradas para este flujo. Ejecuta el flujo para ver los reportes.
              </div>
            </div>
          </div>

          <!-- Tab Content: Version History -->
          <div v-show="activeTab === 'versions'" class="tab-content-container execution-history-list">
            <div class="config-header" style="border-bottom: none; padding-bottom: 0;">
              <h3 class="config-title">Historial de Versiones</h3>
            </div>
            
            <div class="history-list-body">
              <div 
                v-for="ver in workflowVersionsList" 
                :key="ver.id" 
                :class="['history-item', { active: previewedVersionNumber === ver.version }]"
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
                    v-if="previewedVersionNumber !== ver.version"
                    @click="previewWorkflowVersion(ver.version)"
                    class="btn btn-secondary" 
                    style="flex: 1; padding: 6px; font-size: 12px; text-align: center; margin: 0;"
                  >
                    Previsualizar
                  </button>
                  <button 
                    v-else
                    @click="cancelPreview"
                    class="btn btn-secondary" 
                    style="flex: 1; padding: 6px; font-size: 12px; text-align: center; border-color: hsl(var(--text-muted)); color: hsl(var(--text-secondary)); margin: 0;"
                  >
                    Volver
                  </button>
                  <button 
                    @click="restoreWorkflowVersion(ver.version)"
                    class="btn btn-primary" 
                    style="flex: 1; padding: 6px; font-size: 12px; text-align: center; background: hsl(var(--color-primary)); margin: 0;"
                  >
                    Restaurar
                  </button>
                </div>
              </div>
              
              <div v-if="workflowVersionsList.length === 0" class="empty-history-message">
                No hay versiones registradas para este flujo. Se creará una versión automáticamente al guardar.
              </div>
            </div>
          </div>
        </div>
      </aside>
    </main>
  </div>

  <!-- Save Workflow Name Modal -->
    <SaveWorkflowModal
      v-if="showSaveModal"
      v-model:name="newWorkflowName"
      v-model:description="workflowDescription"
      @close="showSaveModal = false"
      @save="saveWorkflowToDb"
    />

    <!-- Create/Edit Credential Modal -->
    <CredentialModal
      v-if="showCredentialModal"
      :edit-id="credentialEditId"
      @saved="fetchCredentials"
      @close="showCredentialModal = false"
    />

    <!-- Expression Editor Modal -->
    <ExpressionEditor
      v-if="showExpressionModal && expressionTarget"
      :fieldName="expressionTarget.label"
      :value="expressionTarget.value"
      :nodes="nodes"
      :edges="edges"
      :currentNodeId="expressionTarget.nodeId"
      :executionReport="executionReport"
      @confirm="handleConfirmExpression"
      @close="showExpressionModal = false; expressionTarget = null"
    />

    <!-- Create/Edit Data Table Modal -->
    <DataTableModal
      v-if="showDataTableModal"
      :editing-table-id="editingTableId"
      v-model:name="dataTableName"
      v-model:key-column="dataTableKeyColumn"
      :columns="dataTableColumns"
      @add-column="addColumnToSchema"
      @remove-column="removeColumnFromSchema"
      @close="showDataTableModal = false"
      @save="saveDataTableToDb"
    />

    <!-- Add/Edit Row Modal -->
    <AddRowModal
      v-if="showRowModal && selectedTable"
      :columns="selectedTable.columns"
      :row-data="rowFormData"
      @close="showRowModal = false"
      @save="addRowToSelectedTable"
    />

    <!-- Create/Edit MCP Server Modal -->
    <McpServerModal
      v-if="showMcpServerModal"
      :editing-mcp-server-id="editingMcpServerId"
      v-model:name="mcpServerName"
      v-model:require-auth="mcpServerRequireAuth"
      v-model:expose-system="mcpServerExposeSystem"
      :workflows="savedWorkflowsList"
      :selected-workflow-ids="mcpServerWorkflowIds"
      @toggle-workflow="toggleMcpWorkflow"
      @close="showMcpServerModal = false"
      @save="saveMcpServerToDb"
    />

    <!-- BATCH VALIDATION MODAL -->
    <BatchValidateModal
      v-if="showBatchValidateModal"
      v-model:contains="batchContains"
      :validating="batchValidating"
      :result="batchResult"
      @validate="runBatchValidate"
      @open-flow="(id) => { loadWorkflowForEdit(id); closeAllModals(); }"
      @close="closeAllModals"
    />

    <!-- AI ERROR CONTEXT MODAL -->
    <AiContextModal
      v-if="showAiContextModal"
      :loading="aiContextLoading"
      :text="aiContextText"
      :copied="aiContextCopied"
      @copy="copyAiContext"
      @close="closeAllModals"
    />
</template>

<script setup lang="ts">
import { ref, onMounted, provide, computed } from 'vue';
import { VueFlow, useVueFlow } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import NodeConfigPanel from './components/NodeConfigPanel.vue';
import ExpressionEditor from './components/ExpressionEditor.vue';
import CustomNode from './components/CustomNode.vue';
import CredentialsView from './components/CredentialsView.vue';
import FlowsView from './components/FlowsView.vue';
import ExecutionsView from './components/ExecutionsView.vue';
import DataTablesList from './components/DataTablesList.vue';
import DataTableDetail from './components/DataTableDetail.vue';
import SaveWorkflowModal from './components/SaveWorkflowModal.vue';
import AddRowModal from './components/AddRowModal.vue';
import DataTableModal from './components/DataTableModal.vue';
import McpServerModal from './components/McpServerModal.vue';
import BatchValidateModal from './components/BatchValidateModal.vue';
import AiContextModal from './components/AiContextModal.vue';
import CredentialModal from './components/CredentialModal.vue';
import McpServersView from './components/McpServersView.vue';
import { statusLabel, formatFullDate, setNestedValue, parseJsonColumns, coerceRowByColumns } from './utils';

// Screen Routing states
const currentView = ref<'dashboard' | 'editor'>('dashboard');
const activeSubView = ref<'workflows' | 'executions' | 'credentials' | 'datatables' | 'mcpservers'>('workflows');

// MCP servers state
const mcpServersList = ref<any[]>([]);
const showMcpServerModal = ref(false);
const editingMcpServerId = ref<string | null>(null);
const mcpServerName = ref('');
const mcpServerWorkflowIds = ref<string[]>([]);
const mcpServerRequireAuth = ref(true);
const mcpServerExposeSystem = ref(false);

// Data Tables state
const dataTablesList = ref<any[]>([]);
const selectedTable = ref<any>(null);
const selectedTableRows = ref<any[]>([]);
const showDataTableModal = ref(false);
const editingTableId = ref<string | null>(null);
const dataTableName = ref('');
const dataTableColumns = ref<{ name: string; type: 'string' | 'number' | 'boolean' }[]>([]);
const dataTableKeyColumn = ref('');
const showRowModal = ref(false);
const rowFormData = ref<Record<string, any>>({});
const editingRowId = ref<string | null>(null);
const editingRowData = ref<Record<string, any>>({});

// State definition
const nodes = ref<any[]>([]);
const edges = ref<any[]>([]);
const selectedNode = ref<any | null>(null);
const activeTab = ref<'config' | 'history' | 'versions'>('config');
const isRunning = ref(false);
const isSaving = ref(false);
const isDirty = ref(false); // tracks unsaved canvas changes
const dashboardLoaded = ref(false); // false until the initial dashboard fetches finish

// Sidebar collapse states
const isNodeSelectorCollapsed = ref(false);
const isRightSidebarCollapsed = ref(false);
const isActiveWorkflow = ref(false);
const onErrorWorkflowId = ref('');

// Versioning states
const isPreviewMode = ref(false);
const previewedVersionNumber = ref<number | null>(null);
const tempWorkflowState = ref<any | null>(null);
const workflowVersionsList = ref<any[]>([]);

// Database / Persistence States
const savedWorkflowsList = ref<any[]>([]);
const globalExecutionsList = ref<any[]>([]);
const activeWorkflowId = ref<string | null>(null);
const activeWorkflowName = ref<string>('');
const workflowExecutionsList = ref<any[]>([]);
const activeExecutionId = ref<string | null>(null);

// Expression editor states
const panelUpdateKey = ref(0);
const showExpressionModal = ref(false);
const expressionTarget = ref<any | null>(null);

// Credentials states
const credentialsList = ref<any[]>([]);
const showCredentialModal = ref(false);
// Id de la credencial a editar (null = crear). El formulario y toda la lógica OAuth viven
// ahora en CredentialModal.vue.
const credentialEditId = ref<string | null>(null);
const openCreateCredential = () => { credentialEditId.value = null; showCredentialModal.value = true; };
const openEditCredential = (id: string) => { credentialEditId.value = id; showCredentialModal.value = true; };

// Modal states
const showSaveModal = ref(false);
const newWorkflowName = ref('');
const workflowDescription = ref('');

// Closes every modal (used by Escape key and click-on-overlay for accessibility).
const closeAllModals = () => {
  showSaveModal.value = false;
  showCredentialModal.value = false;
  showDataTableModal.value = false;
  showRowModal.value = false;
  showExpressionModal.value = false;
  showMcpServerModal.value = false;
  showAiContextModal.value = false;
  showBatchValidateModal.value = false;
  expressionTarget.value = null;
};

// --- Validación en lote (POST /api/workflows/validate-batch) ---
const showBatchValidateModal = ref(false);
const batchContains = ref('');
const batchValidating = ref(false);
const batchResult = ref<any | null>(null);

const openBatchValidate = () => {
  batchResult.value = null;
  batchContains.value = '';
  showBatchValidateModal.value = true;
};

const runBatchValidate = async () => {
  if (batchValidating.value) return;
  batchValidating.value = true;
  try {
    const body = batchContains.value.trim() ? { contains: batchContains.value.trim() } : {};
    const res = await fetch('/api/workflows/validate-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    batchResult.value = await res.json();
  } catch (err) {
    console.error('Error validando en lote:', err);
    alert('No se pudo validar en lote. Revisa la conexión.');
  } finally {
    batchValidating.value = false;
  }
};

// --- AI error-context (pre-armed LLM prompt from a failed execution) ---
const showAiContextModal = ref(false);
const aiContextLoading = ref(false);
const aiContextText = ref('');
const aiContextCopied = ref(false);


const openAiContext = async (execId: string) => {
  showAiContextModal.value = true;
  aiContextLoading.value = true;
  aiContextCopied.value = false;
  aiContextText.value = '';
  try {
    const ctx = await apiGetJson<{ prompt: string }>(`/api/executions/${execId}/llm-context`);
    aiContextText.value = ctx.prompt;
  } catch (err: any) {
    aiContextText.value = `No se pudo generar el contexto: ${err?.message || err}`;
  } finally {
    aiContextLoading.value = false;
  }
};

const copyAiContext = async () => {
  try {
    await navigator.clipboard.writeText(aiContextText.value);
    aiContextCopied.value = true;
    setTimeout(() => { aiContextCopied.value = false; }, 2000);
  } catch {
    // Clipboard bloqueado (http/permisos): el textarea permite copiar a mano.
    aiContextCopied.value = false;
  }
};

// Stores reports from the backend
const executionReport = ref<any | null>(null);
const nodeStatuses = ref<Record<string, 'success' | 'failed' | 'skipped' | 'running'>>({});
const nodeTypesList = ref<any[]>([]);

provide('nodeTypesList', nodeTypesList);
provide('nodeStatuses', nodeStatuses);

const nodeTypes = computed(() => {
  const typesMap: Record<string, any> = {};
  for (const nt of nodeTypesList.value) {
    typesMap[nt.type] = CustomNode;
  }
  return typesMap;
});

// Generate human-friendly names dynamically
const nodeCounters = ref<Record<string, number>>({});

const getNextName = (type: string) => {
  if (nodeCounters.value[type] === undefined) {
    nodeCounters.value[type] = 0;
  }
  nodeCounters.value[type]++;
  const index = nodeCounters.value[type];
  
  const nodeDef = nodeTypesList.value.find(n => n.type === type);
  const displayName = nodeDef ? nodeDef.displayName.replace(/\s*\(.*?\)\s*/g, '').trim() : type;
  const cleanName = displayName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/[^a-zA-Z0-9]/g, "");   // remove non-alphanumeric
  
  return `${cleanName}_${index}`;
};

const initializeNodeCounters = () => {
  nodeCounters.value = {};
  for (const node of nodes.value) {
    const type = node.type;
    const name = node.data?.name || '';
    const match = name.match(/_(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (nodeCounters.value[type] === undefined || num > nodeCounters.value[type]) {
        nodeCounters.value[type] = num;
      }
    }
  }
};

// Spawn nodes in canvas center
const addNode = (type: string) => {
  const id = `node-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const name = getNextName(type);
  
  // Initialize default parameters from SDK schema
  const parameters: Record<string, any> = {};
  const nodeDef = nodeTypesList.value.find(n => n.type === type);
  if (nodeDef && nodeDef.parameters) {
    for (const param of nodeDef.parameters) {
      parameters[param.name] = param.default !== undefined ? JSON.parse(JSON.stringify(param.default)) : '';
    }
  }

  const newNode = {
    id,
    type,
    position: { x: 300 + Math.random() * 50, y: 150 + Math.random() * 50 },
    data: { 
      name, 
      parameters
    }
  };
  nodes.value.push(newNode);
  isDirty.value = true;
};

// Vue Flow events
const onConnect = (params: any) => {
  edges.value.push({
    ...params,
    id: `edge-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    class: ''
  });
  isDirty.value = true;
};

const onNodeClick = (event: any) => {
  selectedNode.value = event.node;
  activeTab.value = 'config'; 
};

const onPaneClick = () => {
  selectedNode.value = null;
};

// --- Validador de coherencia (resultado del guardado) ---
interface FlowIssue { level: 'error' | 'warning'; code: string; nodeId?: string; nodeName?: string; message: string }
const validationIssues = ref<FlowIssue[]>([]);
const showValidationBanner = ref(false);
const validationErrorCount = computed(() => validationIssues.value.filter(i => i.level === 'error').length);

// Selecciona en el canvas el nodo señalado por un issue (abre su panel de configuración).
const focusIssueNode = (nodeId: string) => {
  const node = nodes.value.find(n => n.id === nodeId);
  if (node) {
    selectedNode.value = node;
    activeTab.value = 'config';
  }
};

const updateNodeParams = (params: any) => {
  if (selectedNode.value) {
    selectedNode.value.data.parameters = params;
    isDirty.value = true;
  }
};

const updateNodeName = (name: string) => {
  if (selectedNode.value) {
    selectedNode.value.data.name = name;
    isDirty.value = true;
  }
};

// Re-ejecuta el flujo desde un nodo, reusando las salidas cacheadas aguas arriba.
const rerunFromNode = (nodeId: string) => {
  if (isRunning.value) return;
  runWorkflow(nodeId);
};

// Fija (o quita) la salida de un nodo (pin data). value=null quita el pin.
const setNodePin = (value: any) => {
  if (!selectedNode.value) return;
  if (value === null) {
    delete selectedNode.value.data.pinData;
  } else {
    selectedNode.value.data.pinData = value;
  }
  isDirty.value = true;
};

// Nested value setter utility for expression updates
const handleOpenExpressionEditor = (field: string, label: string, val: string) => {
  if (selectedNode.value) {
    expressionTarget.value = {
      nodeId: selectedNode.value.id,
      path: field,
      label: label,
      value: val
    };
    showExpressionModal.value = true;
  }
};

const handleConfirmExpression = (expression: string) => {
  if (selectedNode.value && expressionTarget.value) {
    const { path } = expressionTarget.value;
    
    if (!selectedNode.value.data) selectedNode.value.data = {};
    if (!selectedNode.value.data.parameters) selectedNode.value.data.parameters = {};
    
    setNestedValue(selectedNode.value.data.parameters, path, expression);
    isDirty.value = true;

    // Force update NodeConfigPanel with new values
    panelUpdateKey.value++;
    
    // Trigger reactivity update in Vue Flow
    selectedNode.value = { ...selectedNode.value };
  }
  showExpressionModal.value = false;
  expressionTarget.value = null;
};

// Execution mapping utilities
const getNodeStatusClass = (nodeId: string) => {
  return nodeStatuses.value[nodeId] || '';
};

// Applies a report's per-node results to node statuses and edge classes.
// Shared by live runs and historical/version previews to avoid divergent logic.
const applyExecutionResults = (results: Record<string, any>) => {
  for (const n of nodes.value) {
    nodeStatuses.value[n.id] = results[n.id] ? results[n.id].status : 'skipped';
  }
  edges.value = edges.value.map(edge => {
    const sourceRes = results[edge.source];
    let edgeClass = '';
    if (sourceRes && sourceRes.status === 'success') {
      const nodeType = nodes.value.find(n => n.id === edge.source)?.type;
      if (nodeType === 'if') {
        const ifResult = sourceRes.output?.result;
        if (edge.sourceHandle === 'true' && ifResult) edgeClass = 'success';
        else if (edge.sourceHandle === 'false' && !ifResult) edgeClass = 'success';
        else edgeClass = 'skipped';
      } else {
        edgeClass = 'success';
      }
    } else if (sourceRes && (sourceRes.status === 'skipped' || sourceRes.status === 'failed')) {
      edgeClass = 'skipped';
    }
    return { ...edge, class: edgeClass };
  });
};

const getExecutionResultForNode = (nodeId: string) => {
  if (!executionReport.value || !executionReport.value.nodeResults) return null;
  return executionReport.value.nodeResults[nodeId] || null;
};

const clearWorkflow = () => {
  nodes.value = [];
  edges.value = [];
  selectedNode.value = null;
  executionReport.value = null;
  nodeStatuses.value = {};
  activeWorkflowId.value = null;
  activeWorkflowName.value = '';
  workflowDescription.value = '';
  workflowExecutionsList.value = [];
  activeExecutionId.value = null;
  activeTab.value = 'config';
  isNodeSelectorCollapsed.value = false;
  isRightSidebarCollapsed.value = false;
  isActiveWorkflow.value = false;
  onErrorWorkflowId.value = '';
  isPreviewMode.value = false;
  previewedVersionNumber.value = null;
  tempWorkflowState.value = null;
  workflowVersionsList.value = [];
  nodeCounters.value = {};
};

// MULTI-SCREEN NAVIGATION TRIGGERS

// Returns true if it's safe to discard the current canvas (no unsaved changes,
// or the user confirmed). Centralizes the "lose your work" guard.
const confirmDiscardIfDirty = (): boolean => {
  if (!isDirty.value) return true;
  return confirm('Tienes cambios sin guardar. ¿Descartarlos?');
};

const createNewWorkflow = () => {
  if (!confirmDiscardIfDirty()) return;
  clearWorkflow();
  activeWorkflowName.value = 'Mi Nuevo Flujo';
  currentView.value = 'editor';
};

const loadWorkflowForEdit = async (workflowId: string) => {
  if (!confirmDiscardIfDirty()) return;
  try {
    const res = await fetch(`/api/workflows/${workflowId}`);
    if (res.status === 404) return;
    if (!res.ok) {
      alert(`No se pudo cargar el flujo (HTTP ${res.status})`);
      return;
    }

    const workflow = await res.json();
    
    // Map the database nodes array back into the format Vue Flow expects
    nodes.value = (workflow.nodes || []).map((n: any, idx: number) => ({
      id: n.id,
      type: n.type,
      position: n.position && typeof n.position.x === 'number' && typeof n.position.y === 'number'
        ? n.position
        : { x: 280 + idx * 240, y: 220 },
      data: {
        name: n.name,
        parameters: n.parameters || {},
        ...(n.pinData !== undefined ? { pinData: n.pinData } : {})
      }
    }));

    edges.value = (workflow.connections || []).map((c: any, idx: number) => ({
      id: c.id || `e-${c.source}-${c.target}-${idx}`,
      source: c.source,
      target: c.target,
      sourceHandle: c.sourceHandle,
      targetHandle: c.targetHandle
    }));
    
    initializeNodeCounters();
    
    activeWorkflowId.value = workflow.id;
    activeWorkflowName.value = workflow.name;
    workflowDescription.value = workflow.description || '';
    isActiveWorkflow.value = workflow.active === 1 || workflow.active === true;
    onErrorWorkflowId.value = workflow.onErrorWorkflowId || '';
    selectedNode.value = null;
    executionReport.value = null;
    isPreviewMode.value = false;
    previewedVersionNumber.value = null;
    tempWorkflowState.value = null;
    isDirty.value = false; // freshly loaded — no unsaved changes

    await fetchWorkflowExecutions(workflowId);
    await fetchWorkflowVersions(workflowId);
    currentView.value = 'editor';
    activeTab.value = 'config';
  } catch (err) {
    console.error('Error loading workflow:', err);
  }
};

const loadPastExecutionFromDashboard = async (execId: string, workflowId: string) => {
  // First load the editor view for the workflow
  await loadWorkflowForEdit(workflowId);
  // Then load and apply that specific execution log
  await loadPastExecution(execId);
  // Switch to history tab to show active execution details
  activeTab.value = 'history';
};

const exitEditor = async () => {
  if (!confirmDiscardIfDirty()) return;
  isDirty.value = false;
  currentView.value = 'dashboard';
  await fetchSavedWorkflows();
  await fetchGlobalExecutions();
};

// PERSISTENCE LOGIC (CRUD)

// Central GET helper: verifies res.ok so a 4xx/5xx is never parsed as valid data.
const apiGetJson = async <T,>(url: string): Promise<T> => {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error || ''; } catch { /* ignore */ }
    throw new Error(`HTTP ${res.status} ${url}${detail ? ': ' + detail : ''}`);
  }
  return res.json();
};

const fetchSavedWorkflows = async () => {
  try {
    savedWorkflowsList.value = await apiGetJson('/api/workflows');
  } catch (err) {
    console.error('Error fetching workflows:', err);
    savedWorkflowsList.value = [];
  }
};

const fetchGlobalExecutions = async () => {
  try {
    globalExecutionsList.value = await apiGetJson('/api/executions');
  } catch (err) {
    console.error('Error fetching global executions:', err);
    globalExecutionsList.value = [];
  }
};

const fetchWorkflowExecutions = async (workflowId: string) => {
  try {
    workflowExecutionsList.value = await apiGetJson(`/api/workflows/${workflowId}/executions`);
  } catch (err) {
    console.error('Error fetching executions:', err);
    workflowExecutionsList.value = [];
  }
};

const deleteWorkflowFromDb = async (workflowId: string) => {
  if (!confirm('¿Estás seguro de que deseas eliminar este flujo de trabajo de forma permanente?')) return;
  try {
    const res = await fetch(`/api/workflows/${workflowId}`, {
      method: 'DELETE'
    });
    if (res.ok) {
      await fetchSavedWorkflows();
      await fetchGlobalExecutions();
    }
  } catch (err) {
    console.error('Error deleting workflow:', err);
  }
};

// CREDENTIALS CRUD LOGIC
const fetchCredentials = async () => {
  try {
    const res = await fetch('/api/credentials');
    credentialsList.value = await res.json();
  } catch (err) {
    console.error('Error fetching credentials:', err);
  }
};

const deleteCredentialFromDb = async (id: string) => {
  if (!confirm('¿Estás seguro de que deseas eliminar esta credencial de forma permanente?')) return;
  try {
    const res = await fetch(`/api/credentials/${id}`, {
      method: 'DELETE'
    });
    if (res.ok) {
      await fetchCredentials();
    }
  } catch (err) {
    console.error('Error deleting credential:', err);
  }
};

const promptSaveWorkflow = () => {
  if (activeWorkflowId.value) {
    saveWorkflowToDb();
  } else {
    newWorkflowName.value = activeWorkflowName.value || 'Mi Nuevo Flujo';
    showSaveModal.value = true;
  }
};

const saveWorkflowToDb = async () => {
  if (isSaving.value) return; // prevent duplicate submissions (double-click)
  isSaving.value = true;
  const id = activeWorkflowId.value || `flow-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const name = activeWorkflowId.value ? activeWorkflowName.value : newWorkflowName.value;

  const payload = {
    id,
    name,
    description: workflowDescription.value || null,
    onErrorWorkflowId: onErrorWorkflowId.value || null,
    nodes: nodes.value.map(n => ({
      id: n.id,
      type: n.type,
      name: n.data.name,
      parameters: n.data.parameters,
      position: n.position, // Save node position coordinates
      ...(n.data.pinData !== undefined ? { pinData: n.data.pinData } : {})
    })),
    connections: edges.value.map(e => ({
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle || undefined,
      targetHandle: e.targetHandle || undefined
    }))
  };

  try {
    const res = await fetch('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      activeWorkflowId.value = id;
      activeWorkflowName.value = name;
      showSaveModal.value = false;
      isDirty.value = false; // saved — no unsaved changes
      // Surface the (non-blocking) coherence validation returned by the save.
      try {
        const data = await res.json();
        validationIssues.value = data?.validation?.issues || [];
        showValidationBanner.value = validationIssues.value.length > 0;
      } catch { validationIssues.value = []; showValidationBanner.value = false; }
      await fetchSavedWorkflows();
      await fetchWorkflowExecutions(id);
      await fetchWorkflowVersions(id);
    } else {
      let msg = `No se pudo guardar (HTTP ${res.status})`;
      try { msg = (await res.json())?.error || msg; } catch { /* ignore */ }
      alert(msg);
    }
  } catch (err) {
    console.error('Error saving workflow:', err);
    alert('No se pudo guardar el flujo. Revisa la conexión.');
  } finally {
    isSaving.value = false;
  }
};

// On error, re-read the authoritative active state from the server rather than
// blindly inverting (which corrupts state if the user toggled twice). (FE-13)
const syncActiveStateFromServer = async () => {
  if (!activeWorkflowId.value) return;
  try {
    const wf = await apiGetJson<any>(`/api/workflows/${activeWorkflowId.value}`);
    isActiveWorkflow.value = wf?.active === 1 || wf?.active === true;
  } catch (err) {
    console.error('Error syncing active state:', err);
  }
};

const toggleWorkflowActiveState = async () => {
  if (!activeWorkflowId.value) return;
  try {
    const res = await fetch(`/api/workflows/${activeWorkflowId.value}/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: isActiveWorkflow.value })
    });
    if (!res.ok) {
      let msg = 'Desconocido';
      try { msg = (await res.json())?.error || msg; } catch { /* ignore */ }
      await syncActiveStateFromServer();
      alert(`Error al cambiar estado: ${msg}`);
    } else {
      // Reload workflows list to update dashboard status
      await fetchSavedWorkflows();
    }
  } catch (err) {
    await syncActiveStateFromServer();
    console.error('Error toggling active state:', err);
    alert('Error de conexión al cambiar el estado del flujo.');
  }
};

const loadPastExecution = async (execId: string) => {
  try {
    const res = await fetch(`/api/executions/${execId}`);
    if (res.status === 404) return;
    
    const execution = await res.json();
    executionReport.value = execution.report;
    activeExecutionId.value = execId;

    const results = execution.report.nodeResults || {};
    applyExecutionResults(results);

    if (selectedNode.value) {
      selectedNode.value = { ...selectedNode.value };
    }
  } catch (err) {
    console.error('Error loading execution:', err);
  }
};

// Runner orchestrator
const runWorkflow = async (rerunFrom?: string) => {
  // Re-ejecutar desde un nodo: reusa las salidas de la última ejecución (capturadas antes de
  // limpiar el report) para todo salvo ese nodo y sus descendientes.
  const priorResults = rerunFrom ? executionReport.value?.nodeResults : undefined;

  isRunning.value = true;
  executionReport.value = null;
  activeExecutionId.value = null;

  // Set all to running
  for (const n of nodes.value) {
    nodeStatuses.value[n.id] = 'running';
  }

  // Prep payload
  const backendNodes = nodes.value.map(n => ({
    id: n.id,
    type: n.type,
    name: n.data.name,
    parameters: n.data.parameters,
    ...(n.data.pinData !== undefined ? { pinData: n.data.pinData } : {})
  }));

  const backendConnections = edges.value.map(e => ({
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle || undefined,
    targetHandle: e.targetHandle || undefined
  }));

  try {
    const response = await fetch('/api/workflows/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflow: {
          id: activeWorkflowId.value || undefined,
          onErrorWorkflowId: onErrorWorkflowId.value || undefined,
          nodes: backendNodes,
          connections: backendConnections
        },
        payload: {},
        ...(rerunFrom && priorResults ? { rerunFrom, priorResults } : {})
      })
    });

    const report = await response.json();

    // A non-2xx response is an error payload, not an execution report — surface it
    // instead of silently marking every node 'skipped'.
    if (!response.ok || !report || !report.nodeResults) {
      const msg = report?.error || `La ejecución falló (HTTP ${response.status})`;
      executionReport.value = null;
      for (const n of nodes.value) {
        nodeStatuses.value[n.id] = 'failed';
      }
      alert(msg);
      return;
    }

    executionReport.value = report;

    // Apply execution states back to frontend nodes + edges (shared helper).
    const results = report.nodeResults || {};
    applyExecutionResults(results);

    // Refresh execution history list
    if (activeWorkflowId.value) {
      await fetchWorkflowExecutions(activeWorkflowId.value);
    }

  } catch (err: any) {
    console.error('Error running workflow:', err);
    for (const n of nodes.value) {
      nodeStatuses.value[n.id] = 'failed';
    }
  } finally {
    isRunning.value = false;
  }
};

const fetchNodeTypes = async () => {
  try {
    const res = await fetch('/api/node-types');
    nodeTypesList.value = await res.json();
  } catch (err) {
    console.error('Error fetching node types:', err);
  }
};

const fetchDataTables = async () => {
  try {
    const res = await fetch('/api/data-tables');
    if (res.ok) {
      dataTablesList.value = await res.json();
    }
  } catch (err) {
    console.error('Error fetching data tables:', err);
  }
};

// MCP SERVERS CRUD LOGIC
const fetchMcpServers = async () => {
  try {
    const res = await fetch('/api/mcp-servers');
    if (res.ok) mcpServersList.value = await res.json();
  } catch (err) {
    console.error('Error fetching MCP servers:', err);
  }
};

const copyMcpText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard may be unavailable (insecure context); ignore silently.
  }
};

const openCreateMcpServerModal = () => {
  editingMcpServerId.value = null;
  mcpServerName.value = '';
  mcpServerWorkflowIds.value = [];
  mcpServerRequireAuth.value = true;
  mcpServerExposeSystem.value = false;
  showMcpServerModal.value = true;
};

const openEditMcpServerModal = (server: any) => {
  editingMcpServerId.value = server.id;
  mcpServerName.value = server.name;
  mcpServerWorkflowIds.value = [...(server.workflow_ids || [])];
  mcpServerRequireAuth.value = !!server.require_auth;
  mcpServerExposeSystem.value = !!server.expose_system_tools;
  showMcpServerModal.value = true;
};

const toggleMcpWorkflow = (id: string) => {
  const i = mcpServerWorkflowIds.value.indexOf(id);
  if (i === -1) mcpServerWorkflowIds.value.push(id);
  else mcpServerWorkflowIds.value.splice(i, 1);
};

const saveMcpServerToDb = async () => {
  try {
    const res = await fetch('/api/mcp-servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: editingMcpServerId.value || undefined,
        name: mcpServerName.value.trim(),
        workflowIds: mcpServerWorkflowIds.value,
        requireAuth: mcpServerRequireAuth.value,
        exposeSystemTools: mcpServerExposeSystem.value,
      }),
    });
    if (res.ok) {
      showMcpServerModal.value = false;
      await fetchMcpServers();
    } else {
      const detail = await res.json().catch(() => ({}));
      alert('Error al guardar el servidor MCP: ' + (detail.error || res.status));
    }
  } catch (err) {
    console.error('Error saving MCP server:', err);
  }
};

const deleteMcpServerFromDb = async (id: string) => {
  if (!confirm('¿Eliminar este servidor MCP de forma permanente?')) return;
  try {
    const res = await fetch(`/api/mcp-servers/${id}`, { method: 'DELETE' });
    if (res.ok) await fetchMcpServers();
  } catch (err) {
    console.error('Error deleting MCP server:', err);
  }
};

const openCreateTableModal = () => {
  editingTableId.value = null;
  dataTableName.value = '';
  dataTableColumns.value = [{ name: 'id', type: 'string' }];
  dataTableKeyColumn.value = '';
  showDataTableModal.value = true;
};

const openEditTableSchemaModal = () => {
  if (!selectedTable.value) return;
  editingTableId.value = selectedTable.value.id;
  dataTableName.value = selectedTable.value.name;
  dataTableColumns.value = parseJsonColumns(selectedTable.value.columns).map((c: any) => ({ ...c }));
  dataTableKeyColumn.value = selectedTable.value.key_column || '';
  showDataTableModal.value = true;
};

const addColumnToSchema = () => {
  dataTableColumns.value.push({ name: '', type: 'string' });
};

const removeColumnFromSchema = (idx: number) => {
  dataTableColumns.value.splice(idx, 1);
};

const saveDataTableToDb = async () => {
  const tId = editingTableId.value || `table-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  try {
    const res = await fetch('/api/data-tables', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: tId,
        name: dataTableName.value.trim(),
        columns: dataTableColumns.value,
        keyColumn: dataTableKeyColumn.value || null
      })
    });
    if (res.ok) {
      showDataTableModal.value = false;
      await fetchDataTables();
      if (selectedTable.value && selectedTable.value.id === tId) {
        selectedTable.value.name = dataTableName.value.trim();
        selectedTable.value.columns = dataTableColumns.value;
      }
    }
  } catch (err) {
    console.error('Error saving data table:', err);
  }
};

const deleteTableFromDb = async (id: string) => {
  if (!confirm('¿Estás seguro de que quieres eliminar esta Tabla de Datos? Se perderán todos sus registros.')) return;
  try {
    const res = await fetch(`/api/data-tables/${id}`, {
      method: 'DELETE'
    });
    if (res.ok) {
      await fetchDataTables();
      if (selectedTable.value && selectedTable.value.id === id) {
        selectedTable.value = null;
      }
    }
  } catch (err) {
    console.error('Error deleting data table:', err);
  }
};

const loadTableDetails = async (table: any) => {
  selectedTable.value = {
    ...table,
    columns: parseJsonColumns(table.columns)
  };
  await fetchSelectedTableRows();
};

const fetchSelectedTableRows = async () => {
  if (!selectedTable.value) return;
  try {
    const res = await fetch(`/api/data-tables/${selectedTable.value.id}/rows`);
    if (res.ok) {
      selectedTableRows.value = await res.json();
    }
  } catch (err) {
    console.error('Error fetching table rows:', err);
  }
};

const openAddRowModal = () => {
  rowFormData.value = {};
  if (selectedTable.value) {
    for (const col of selectedTable.value.columns) {
      if (col.type === 'boolean') {
        rowFormData.value[col.name] = false;
      } else if (col.type === 'number') {
        rowFormData.value[col.name] = 0;
      } else {
        rowFormData.value[col.name] = '';
      }
    }
  }
  showRowModal.value = true;
};

const addRowToSelectedTable = async () => {
  if (!selectedTable.value) return;
  try {
    const res = await fetch(`/api/data-tables/${selectedTable.value.id}/rows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: rowFormData.value
      })
    });
    if (res.ok) {
      showRowModal.value = false;
      await fetchSelectedTableRows();
    }
  } catch (err) {
    console.error('Error adding row to table:', err);
  }
};

// Coerces row values to match each column's declared type (number/boolean), so inline
// edits don't persist booleans/numbers as strings. (FE-16)
const startInlineRowEdit = (row: any) => {
  editingRowId.value = row.id;
  // Coerce on entry so checkbox/number inputs bind to the right primitive type.
  editingRowData.value = coerceRowByColumns(row.data, selectedTable.value?.columns || []);
};

const saveInlineRowEdit = async (rowId: string) => {
  if (!selectedTable.value) return;
  try {
    const res = await fetch(`/api/data-tables/${selectedTable.value.id}/rows/${rowId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: coerceRowByColumns(editingRowData.value, selectedTable.value.columns || [])
      })
    });
    if (res.ok) {
      editingRowId.value = null;
      await fetchSelectedTableRows();
    }
  } catch (err) {
    console.error('Error saving inline row edit:', err);
  }
};

const deleteRowFromTable = async (rowId: string) => {
  if (!selectedTable.value) return;
  if (!confirm('¿Estás seguro de que quieres eliminar esta fila?')) return;
  try {
    const res = await fetch(`/api/data-tables/${selectedTable.value.id}/rows/${rowId}`, {
      method: 'DELETE'
    });
    if (res.ok) {
      await fetchSelectedTableRows();
    }
  } catch (err) {
    console.error('Error deleting row:', err);
  }
};

// Initial load
onMounted(async () => {
  await fetchNodeTypes();
  await fetchSavedWorkflows();
  await fetchGlobalExecutions();
  await fetchCredentials();
  await fetchDataTables();
  await fetchMcpServers();
  dashboardLoaded.value = true;

  // Warn before leaving/reloading the tab with unsaved canvas changes.
  window.addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
    if (isDirty.value) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Close any open modal with the Escape key (accessibility / keyboard navigation).
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeAllModals();
  });
});

// Sample loading demo
const loadSampleWorkflow = () => {
  clearWorkflow();

  const id1 = 'node-trigger';
  const id2 = 'node-set';
  const id3 = 'node-api';
  const id4 = 'node-js';
  const id5 = 'node-if';
  const id6 = 'node-success-log';
  const id7 = 'node-failure-log';

  nodes.value = [
    {
      id: id1,
      type: 'trigger',
      position: { x: 100, y: 200 },
      data: { name: 'Inicio_Manual', parameters: {} }
    },
    {
      id: id2,
      type: 'set',
      position: { x: 300, y: 200 },
      data: { 
        name: 'FiltroUsuario', 
        parameters: { 
          values: [
            { key: 'usuarioId', value: '1' },
            { key: 'rolRequerido', value: 'admin' }
          ] 
        } 
      }
    },
    {
      id: id3,
      type: 'httpRequest',
      position: { x: 500, y: 200 },
      data: { 
        name: 'ObtenerDetallesAPI', 
        parameters: { 
          method: 'GET',
          url: 'https://jsonplaceholder.typicode.com/users/{{ $node.FiltroUsuario.output.usuarioId }}',
          headers: []
        } 
      }
    },
    {
      id: id4,
      type: 'jsCode',
      position: { x: 720, y: 200 },
      data: { 
        name: 'TransformarRol', 
        parameters: { 
          code: '// Simulamos asignarle el rol configurado en FiltroUsuario al usuario de la API\nconst user = $node.ObtenerDetallesAPI.output.body;\nuser.rol = $node.FiltroUsuario.output.rolRequerido;\nreturn user;' 
        } 
      }
    },
    {
      id: id5,
      type: 'if',
      position: { x: 920, y: 200 },
      data: { 
        name: 'ValidarAdmin', 
        parameters: { 
          value1: '{{ $node.TransformarRol.output.rol }}',
          operator: 'equal',
          value2: 'admin'
        } 
      }
    },
    {
      id: id6,
      type: 'log',
      position: { x: 1180, y: 100 },
      data: { 
        name: 'LoggerExito', 
        parameters: { 
          message: '¡Éxito! Usuario {{ $node.TransformarRol.output.name }} es administrador.' 
        } 
      }
    },
    {
      id: id7,
      type: 'log',
      position: { x: 1180, y: 320 },
      data: { 
        name: 'LoggerFallo', 
        parameters: { 
          message: 'Error: El usuario no es admin.' 
        } 
      }
    }
  ];

  edges.value = [
    { id: 'e1', source: id1, target: id2 },
    { id: 'e2', source: id2, target: id3 },
    { id: 'e3', source: id3, target: id4 },
    { id: 'e4', source: id4, target: id5 },
    { id: 'e5', source: id5, target: id6, sourceHandle: 'true' },
    { id: 'e6', source: id5, target: id7, sourceHandle: 'false' }
  ];

  initializeNodeCounters();
  activeWorkflowName.value = 'Ejemplo de Integración n8n';
};

const fetchWorkflowVersions = async (workflowId: string | null) => {
  if (!workflowId) return;
  try {
    const res = await fetch(`/api/workflows/${workflowId}/versions`);
    workflowVersionsList.value = await res.json();
  } catch (err) {
    console.error('Error fetching workflow versions:', err);
  }
};

const previewWorkflowVersion = async (versionNum: number) => {
  if (!activeWorkflowId.value) return;
  try {
    const res = await fetch(`/api/workflows/${activeWorkflowId.value}/versions/${versionNum}`);
    if (!res.ok) return;
    const versionData = await res.json();

    // Store active editor state before entering preview mode (only if not already previewing)
    if (!isPreviewMode.value) {
      tempWorkflowState.value = {
        nodes: JSON.parse(JSON.stringify(nodes.value)),
        edges: JSON.parse(JSON.stringify(edges.value)),
        name: activeWorkflowName.value,
        onErrorWorkflowId: onErrorWorkflowId.value
      };
    }

    // Load version data into canvas
    nodes.value = (versionData.nodes || []).map((n: any, idx: number) => ({
      id: n.id,
      type: n.type,
      position: n.position && typeof n.position.x === 'number' && typeof n.position.y === 'number'
        ? n.position
        : { x: 280 + idx * 240, y: 220 },
      data: {
        name: n.name,
        parameters: n.parameters || {}
      }
    }));

    edges.value = (versionData.connections || []).map((c: any, idx: number) => ({
      id: c.id || `e-${c.source}-${c.target}-${idx}`,
      source: c.source,
      target: c.target,
      sourceHandle: c.sourceHandle,
      targetHandle: c.targetHandle
    }));

    initializeNodeCounters();

    activeWorkflowName.value = versionData.name;
    onErrorWorkflowId.value = versionData.onErrorWorkflowId || '';
    
    // Deselect selected node and reset execution preview states
    selectedNode.value = null;
    executionReport.value = null;
    nodeStatuses.value = {};
    activeExecutionId.value = null;

    isPreviewMode.value = true;
    previewedVersionNumber.value = versionNum;
  } catch (err) {
    console.error('Error previewing version:', err);
  }
};

const cancelPreview = () => {
  if (tempWorkflowState.value) {
    nodes.value = tempWorkflowState.value.nodes;
    edges.value = tempWorkflowState.value.edges;
    activeWorkflowName.value = tempWorkflowState.value.name;
    onErrorWorkflowId.value = tempWorkflowState.value.onErrorWorkflowId;
    tempWorkflowState.value = null;
  }
  isPreviewMode.value = false;
  previewedVersionNumber.value = null;
  selectedNode.value = null;
  executionReport.value = null;
  nodeStatuses.value = {};
  activeExecutionId.value = null;
  initializeNodeCounters();
};

const restoreWorkflowVersion = async (versionNum: number) => {
  if (!activeWorkflowId.value) return;
  if (!confirm(`¿Estás seguro de que deseas restaurar el flujo a la Versión #${versionNum}? Esto sobrescribirá los cambios actuales.`)) return;
  
  try {
    const res = await fetch(`/api/workflows/${activeWorkflowId.value}/versions/${versionNum}/restore`, {
      method: 'POST'
    });
    if (res.ok) {
      alert(`Flujo restaurado exitosamente a la Versión #${versionNum}`);
      await loadWorkflowForEdit(activeWorkflowId.value);
    } else {
      const data = await res.json();
      alert(`Error al restaurar versión: ${data.error || 'Desconocido'}`);
    }
  } catch (err) {
    console.error('Error restoring version:', err);
    alert('Error de conexión al restaurar la versión.');
  }
};
</script>
