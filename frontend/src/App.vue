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
        @create="openCreateCredentialModal"
        @edit="openEditCredentialModal"
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
        <div v-if="selectedTable" class="table-details-view">
          <div class="subview-header" style="margin-bottom: 16px;">
            <div>
              <div style="display: flex; align-items: center; gap: 12px;">
                <button @click="selectedTable = null" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;">
                  ← Volver
                </button>
                <h2 class="subview-title" style="margin: 0;">📊 {{ selectedTable.name }}</h2>
              </div>
              <p class="subview-desc" style="margin-top: 6px;">ID: <span class="code-font" style="font-size: 12px;">{{ selectedTable.id }}</span></p>
            </div>
            <div style="display: flex; gap: 8px;">
              <button @click="openAddRowModal" class="btn btn-primary">
                + Añadir Fila
              </button>
              <button @click="openEditTableSchemaModal" class="btn btn-secondary">
                ⚙️ Columnas
              </button>
            </div>
          </div>

          <div class="table-container" style="overflow-x: auto;">
            <table class="dashboard-table">
              <thead>
                <tr>
                  <th v-for="col in selectedTable.columns" :key="col.name">
                    {{ col.name }} <span style="font-size: 12px; opacity: 0.6; text-transform: lowercase;">({{ col.type }})</span>
                  </th>
                  <th style="width: 140px; text-align: right;">Acciones</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in selectedTableRows" :key="row.id">
                  <td v-for="col in selectedTable.columns" :key="col.name">
                    <input 
                      v-if="editingRowId === row.id"
                      v-model="editingRowData[col.name]"
                      :type="col.type === 'number' ? 'number' : col.type === 'boolean' ? 'checkbox' : 'text'"
                      class="config-input"
                      style="padding: 4px 8px; font-size: 13px; margin: 0;"
                    />
                    <span v-else>
                      {{ row.data[col.name] !== undefined ? row.data[col.name] : '-' }}
                    </span>
                  </td>
                  <td style="text-align: right;">
                    <div class="table-actions" style="justify-content: flex-end; gap: 4px;">
                      <template v-if="editingRowId === row.id">
                        <button @click="saveInlineRowEdit(row.id)" class="btn btn-primary" style="padding: 4px 8px; font-size: 12px;">
                          Guardar
                        </button>
                        <button @click="editingRowId = null" class="btn btn-secondary" style="padding: 4px 8px; font-size: 12px;">
                          Cancelar
                        </button>
                      </template>
                      <template v-else>
                        <button @click="startInlineRowEdit(row)" class="btn btn-secondary" style="padding: 4px 8px; font-size: 12px;">
                          Editar
                        </button>
                        <button @click="deleteRowFromTable(row.id)" class="btn btn-secondary" style="padding: 4px 8px; font-size: 12px; border-color: hsla(var(--color-danger) / 0.3); color: hsl(var(--color-danger));">
                          Borrar
                        </button>
                      </template>
                    </div>
                  </td>
                </tr>
                <tr v-if="selectedTableRows.length === 0">
                  <td :colspan="selectedTable.columns.length + 1" class="empty-table-message">
                    Esta tabla está vacía. Añade tu primera fila para comenzar.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Tables List -->
        <div v-else>
          <div class="subview-header">
            <div>
              <h2 class="subview-title">Tablas de Datos (Data Tables)</h2>
              <p class="subview-desc">Crea y administra tablas estructuradas para almacenar registros de tus automatizaciones.</p>
            </div>
            <button @click="openCreateTableModal" class="btn btn-primary">
              + Crear Tabla
            </button>
          </div>

          <div class="table-container">
            <table class="dashboard-table">
              <thead>
                <tr>
                  <th>Nombre de la Tabla</th>
                  <th>ID</th>
                  <th>Columnas</th>
                  <th>Creada el</th>
                  <th style="text-align: right;">Acciones</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="table in dataTablesList" :key="table.id">
                  <td class="flow-name-cell" @click="loadTableDetails(table)">
                    📊 {{ table.name }}
                  </td>
                  <td class="code-font">{{ table.id }}</td>
                  <td>
                    <span v-for="col in parseJsonColumns(table.columns)" :key="col.name" class="status-badge" style="margin-right: 4px; background: hsla(var(--color-primary) / 0.1); color: hsl(var(--color-primary-text)); padding: 2px 6px; font-size: 12px;">
                      {{ col.name }} ({{ col.type }})
                    </span>
                  </td>
                  <td>{{ formatFullDate(table.created_at) }}</td>
                  <td style="text-align: right;">
                    <div class="table-actions">
                      <button @click="loadTableDetails(table)" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;">
                        Ver Datos
                      </button>
                      <button @click="deleteTableFromDb(table.id)" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px; border-color: hsla(var(--color-danger) / 0.3); color: hsl(var(--color-danger));">
                        Eliminar
                      </button>
                    </div>
                  </td>
                </tr>
                <tr v-if="!dashboardLoaded">
                  <td colspan="5" class="empty-table-message">Cargando tablas…</td>
                </tr>
                <tr v-else-if="dataTablesList.length === 0">
                  <td colspan="5" class="empty-table-message">
                    No tienes tablas de datos creadas. Haz clic en "+ Crear Tabla" para empezar.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- MCP SERVERS SUBVIEW -->
      <div v-if="activeSubView === 'mcpservers'" class="subview-container">
        <div class="subview-header">
          <div>
            <h2 class="subview-title">Servidores MCP</h2>
            <p class="subview-desc">Publica un grupo concreto de flujos como herramientas MCP en una URL propia, conectable desde clientes como Claude Desktop.</p>
          </div>
          <button @click="openCreateMcpServerModal" class="btn btn-primary">
            + Crear Servidor MCP
          </button>
        </div>

        <div class="table-container">
          <table class="dashboard-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>URL (MCP)</th>
                <th>Flujos</th>
                <th>Acceso</th>
                <th style="text-align: right;">Acciones</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="server in mcpServersList" :key="server.id">
                <td class="flow-name-cell" @click="openEditMcpServerModal(server)">
                  🔌 {{ server.name }}
                </td>
                <td class="code-font" style="font-size: 12px;">
                  {{ mcpServerUrl(server.id) }}
                  <button @click="copyMcpText(mcpServerUrl(server.id))" class="btn btn-secondary" style="padding: 2px 6px; font-size: 11px; margin-left: 6px;">Copiar</button>
                </td>
                <td>{{ (server.workflow_ids || []).length }}</td>
                <td>
                  <span :class="['status-badge', server.require_auth ? 'success' : 'inactive']">
                    {{ server.require_auth ? 'Token' : 'Público' }}
                  </span>
                </td>
                <td style="text-align: right;">
                  <div class="table-actions">
                    <button v-if="server.require_auth" @click="copyMcpText(server.token)" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;">
                      Copiar token
                    </button>
                    <button @click="openEditMcpServerModal(server)" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;">
                      Editar
                    </button>
                    <button @click="deleteMcpServerFromDb(server.id)" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px; border-color: hsla(var(--color-danger) / 0.3); color: hsl(var(--color-danger));">
                      Eliminar
                    </button>
                  </div>
                </td>
              </tr>
              <tr v-if="!dashboardLoaded">
                <td colspan="5" class="empty-table-message">Cargando servidores…</td>
              </tr>
              <tr v-else-if="mcpServersList.length === 0">
                <td colspan="5" class="empty-table-message">
                  No tienes servidores MCP. Haz clic en "+ Crear Servidor MCP" para empezar.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
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
          @click="runWorkflow" 
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
    <div v-if="showSaveModal" class="modal-overlay" role="dialog" aria-modal="true" v-focus-trap @click.self="closeAllModals()">
      <div class="modal-content">
        <h3 class="modal-title">Guardar Flujo</h3>
        <p class="modal-desc">Asigna un nombre para guardar este flujo de trabajo en la base de datos.</p>
        <input
          v-model="newWorkflowName"
          type="text"
          class="config-input"
          placeholder="Nombre del flujo (ej: Mi Flujo De Registro)"
          style="margin-bottom: 12px;"
        />
        <textarea
          v-model="workflowDescription"
          class="config-input"
          rows="2"
          placeholder="Descripción (opcional) — se usa como descripción de la tool MCP para que un agente la elija mejor"
          style="margin-bottom: 16px; resize: vertical;"
        />
        <div class="modal-actions">
          <button @click="showSaveModal = false" class="btn btn-secondary">Cancelar</button>
          <button @click="saveWorkflowToDb" class="btn btn-primary" :disabled="!newWorkflowName.trim()">Guardar</button>
        </div>
      </div>
    </div>

    <!-- Create/Edit Credential Modal -->
    <div v-if="showCredentialModal" class="modal-overlay" role="dialog" aria-modal="true" v-focus-trap @click.self="closeAllModals()">
      <div class="modal-content" style="width: 480px; max-width: 90%;">
        <h3 class="modal-title">{{ editingCredentialId ? 'Editar Credencial' : 'Crear Credencial' }}</h3>
        <p class="modal-desc">Completa los datos de acceso que serán cifrados de manera segura.</p>
        
        <div class="config-group">
          <label class="config-label">NOMBRE DE LA CREDENCIAL</label>
          <input 
            v-model="credentialName" 
            type="text" 
            class="config-input" 
            placeholder="ej: Mi API de Slack / API Producción" 
          />
        </div>

        <div class="config-group">
          <label class="config-label">TIPO DE CONEXIÓN</label>
          <select v-model="credentialType" class="config-input" :disabled="!!editingCredentialId">
            <option value="basicAuth">Basic Auth (Usuario / Contraseña)</option>
            <option value="apiKey">API Key (Token de Cabecera o Query)</option>
            <option value="oauth2">OAuth2 (token + refresh automático)</option>
          </select>
        </div>

        <!-- Inputs for basicAuth -->
        <div v-if="credentialType === 'basicAuth'">
          <div class="config-group">
            <label class="config-label">USUARIO</label>
            <input 
              v-model="credUser" 
              type="text" 
              class="config-input" 
              placeholder="Nombre de usuario o correo" 
            />
          </div>
          <div class="config-group">
            <label class="config-label">CONTRASEÑA</label>
            <input 
              v-model="credPassword" 
              type="password" 
              class="config-input" 
              placeholder="Contraseña o Token de acceso" 
            />
          </div>
        </div>

        <!-- Inputs for apiKey -->
        <div v-else-if="credentialType === 'apiKey'">
          <div class="config-group">
            <label class="config-label">NOMBRE DEL PARÁMETRO / CABECERA</label>
            <input 
              v-model="credKeyName" 
              type="text" 
              class="config-input" 
              placeholder="ej: Authorization, X-API-Key, api_key" 
            />
          </div>
          <div class="config-group">
            <label class="config-label">VALOR DE LA CREDENCIAL</label>
            <input 
              v-model="credKeyValue" 
              type="password" 
              class="config-input" 
              placeholder="Ingresa el valor secreto" 
            />
          </div>
          <div class="config-group">
            <label class="config-label">ENVIAR EN</label>
            <select v-model="credKeyIn" class="config-input">
              <option value="header">Cabecera HTTP (Header)</option>
              <option value="query">Parámetro de URL (Query Parameter)</option>
            </select>
          </div>
        </div>

        <!-- Inputs for oauth2 -->
        <div v-else-if="credentialType === 'oauth2'">
          <div class="config-group">
            <label class="config-label">TIPO DE GRANT</label>
            <select v-model="oauthGrantType" class="config-input">
              <option value="client_credentials">Client Credentials (machine-to-machine)</option>
              <option value="refresh_token">Refresh Token</option>
              <option value="authorization_code">Authorization Code (login del usuario + PKCE)</option>
            </select>
          </div>
          <div class="config-group" v-if="oauthGrantType === 'authorization_code'">
            <label class="config-label">AUTHORIZATION URL</label>
            <input v-model="oauthAuthUrl" type="text" class="config-input" placeholder="https://accounts.ejemplo.com/o/oauth2/v2/auth" />
          </div>
          <div class="config-group">
            <label class="config-label">TOKEN URL</label>
            <input v-model="oauthTokenUrl" type="text" class="config-input" placeholder="https://auth.ejemplo.com/oauth/token" />
          </div>
          <div class="config-group">
            <label class="config-label">CLIENT ID</label>
            <input v-model="oauthClientId" type="text" class="config-input" placeholder="ID de cliente" />
          </div>
          <div class="config-group">
            <label class="config-label">CLIENT SECRET</label>
            <input v-model="oauthClientSecret" type="password" class="config-input" placeholder="Secreto de cliente" />
          </div>
          <div class="config-group" v-if="oauthGrantType === 'refresh_token'">
            <label class="config-label">REFRESH TOKEN</label>
            <input v-model="oauthRefreshToken" type="password" class="config-input" placeholder="Refresh token inicial" />
          </div>
          <div class="config-group">
            <label class="config-label">SCOPE (opcional)</label>
            <input v-model="oauthScope" type="text" class="config-input" placeholder="ej: read write" />
          </div>
          <div class="config-group">
            <label class="config-label">AUTENTICACIÓN DEL CLIENTE</label>
            <select v-model="oauthClientAuth" class="config-input">
              <option value="header">Cabecera HTTP Basic (recomendado)</option>
              <option value="body">En el cuerpo (client_id / client_secret)</option>
            </select>
          </div>

          <!-- Flujo interactivo: registro del redirect + conexión -->
          <div v-if="oauthGrantType === 'authorization_code'">
            <label class="config-checkbox" style="display:flex;align-items:center;gap:8px;margin:8px 0;">
              <input type="checkbox" v-model="oauthUsePkce" /> Usar PKCE (S256, recomendado)
            </label>
            <label class="config-checkbox" style="display:flex;align-items:center;gap:8px;margin:8px 0;">
              <input type="checkbox" v-model="oauthOfflineAccess" /> Solicitar refresh token (access_type=offline)
            </label>
            <div class="config-group">
              <label class="config-label">REDIRECT URI (regístralo en la app del proveedor)</label>
              <input :value="oauthRedirectUri" readonly class="config-input" @focus="(e:any)=>e.target.select()" />
            </div>
            <div class="config-group">
              <p v-if="!editingCredentialId" style="font-size:12px;color:var(--color-text-muted);">
                Guarda la credencial primero; luego podrás conectarla.
              </p>
              <div v-else style="display:flex;align-items:center;gap:10px;">
                <button @click="connectOAuth" class="btn btn-secondary" :disabled="oauthConnecting">
                  {{ oauthConnecting ? 'Conectando…' : (oauthConnected ? 'Reconectar' : 'Conectar') }}
                </button>
                <span v-if="oauthConnected" style="color:#16a34a;font-size:13px;">✅ Conectada</span>
                <span v-if="oauthConnectError" style="color:#dc2626;font-size:13px;">{{ oauthConnectError }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="modal-actions" style="margin-top: 24px;">
          <button @click="showCredentialModal = false" class="btn btn-secondary">Cancelar</button>
          <button
            @click="saveCredentialToDb"
            class="btn btn-primary"
            :disabled="!canSaveCredential"
          >
            Guardar
          </button>
        </div>
      </div>
    </div>

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
    <div v-if="showDataTableModal" class="modal-overlay" role="dialog" aria-modal="true" v-focus-trap @click.self="closeAllModals()">
      <div class="modal-content" style="width: 520px; max-width: 95%;">
        <h3 class="modal-title">{{ editingTableId ? 'Editar Columnas' : 'Crear Tabla de Datos' }}</h3>
        <p class="modal-desc">Define el nombre y las columnas de la tabla. Las columnas especifican el tipo de datos.</p>

        <div class="form-group" style="margin-top: 12px;">
          <label class="config-label">Nombre de la Tabla</label>
          <input 
            v-model="dataTableName" 
            placeholder="ej: leads, clientes" 
            class="config-input" 
            :disabled="!!editingTableId" 
          />
        </div>

        <div class="form-group" style="margin-top: 16px;">
          <label class="config-label" style="display: flex; justify-content: space-between; align-items: center;">
            <span>Columnas</span>
            <button @click="addColumnToSchema" class="btn btn-secondary" style="padding: 2px 8px; font-size: 12px;">+ Añadir Columna</button>
          </label>

          <div style="max-height: 200px; overflow-y: auto; margin-top: 8px;">
            <div v-for="(col, index) in dataTableColumns" :key="index" style="display: flex; gap: 8px; margin-bottom: 8px; align-items: center;">
              <input 
                v-model="col.name" 
                placeholder="Nombre de columna" 
                class="config-input" 
                style="flex-grow: 1; padding: 6px 10px; font-size: 13px;"
              />
              <select v-model="col.type" class="config-select" style="width: 120px; padding: 6px 10px; font-size: 13px;">
                <option value="string">Texto</option>
                <option value="number">Número</option>
                <option value="boolean">Booleano</option>
              </select>
              <button @click="removeColumnFromSchema(index)" class="btn btn-secondary" style="padding: 6px 10px; font-size: 13px; border-color: transparent; color: hsl(var(--color-danger));">
                ✕
              </button>
            </div>
            <div v-if="dataTableColumns.length === 0" style="font-size: 12px; color: hsl(var(--text-muted)); text-align: center; padding: 12px;">
              No hay columnas definidas. Añade al menos una.
            </div>
          </div>
        </div>

        <div class="form-group" style="margin-top: 16px;">
          <label class="config-label">Columna clave (única) — opcional</label>
          <select v-model="dataTableKeyColumn" class="config-input">
            <option value="">Sin clave (tabla simple)</option>
            <option v-for="col in dataTableColumns.filter(c => c.name.trim())" :key="col.name" :value="col.name">{{ col.name }}</option>
          </select>
          <p style="font-size: 12px; color: hsl(var(--text-muted)); margin-top: 4px;">
            Habilita upsert, incrementar contador, get-or-default e idempotencia (una fila por valor de clave).
          </p>
        </div>

        <div class="modal-actions" style="margin-top: 24px;">
          <button @click="showDataTableModal = false" class="btn btn-secondary">Cancelar</button>
          <button 
            @click="saveDataTableToDb" 
            class="btn btn-primary" 
            :disabled="!dataTableName.trim() || dataTableColumns.length === 0 || dataTableColumns.some(c => !c.name.trim())"
          >
            Guardar
          </button>
        </div>
      </div>
    </div>

    <!-- Add/Edit Row Modal -->
    <div v-if="showRowModal && selectedTable" class="modal-overlay" role="dialog" aria-modal="true" v-focus-trap @click.self="closeAllModals()">
      <div class="modal-content" style="width: 460px; max-width: 90%;">
        <h3 class="modal-title">Añadir Fila</h3>
        <p class="modal-desc">Ingresa los datos para la nueva fila en la tabla.</p>

        <div v-for="col in selectedTable.columns" :key="col.name" class="form-group" style="margin-top: 12px;">
          <label class="config-label">{{ col.name }} <span style="font-size: 12px; opacity: 0.6;">({{ col.type }})</span></label>
          <input 
            v-if="col.type === 'number'"
            v-model.number="rowFormData[col.name]"
            type="number"
            class="config-input"
          />
          <div v-else-if="col.type === 'boolean'" style="display: flex; align-items: center; gap: 8px; margin-top: 6px;">
            <input 
              v-model="rowFormData[col.name]"
              type="checkbox"
              style="width: 16px; height: 16px;"
            />
            <span style="font-size: 13px; color: hsl(var(--text-primary));">Activo/Verdadero</span>
          </div>
          <input 
            v-else
            v-model="rowFormData[col.name]"
            type="text"
            class="config-input"
          />
        </div>

        <div class="modal-actions" style="margin-top: 24px;">
          <button @click="showRowModal = false" class="btn btn-secondary">Cancelar</button>
          <button @click="addRowToSelectedTable" class="btn btn-primary">
            Guardar
          </button>
        </div>
      </div>
    </div>

    <!-- Create/Edit MCP Server Modal -->
    <div v-if="showMcpServerModal" class="modal-overlay" role="dialog" aria-modal="true" v-focus-trap @click.self="closeAllModals()">
      <div class="modal-content" style="width: 560px; max-width: 95%;">
        <h3 class="modal-title">{{ editingMcpServerId ? 'Editar Servidor MCP' : 'Crear Servidor MCP' }}</h3>
        <p class="modal-desc">Selecciona los flujos que se expondrán como herramientas. El servidor tendrá su propia URL pública.</p>

        <div class="form-group" style="margin-top: 12px;">
          <label class="config-label">Nombre del Servidor</label>
          <input v-model="mcpServerName" placeholder="ej: Herramientas de Ventas" class="config-input" />
        </div>

        <div class="form-group" style="margin-top: 16px;">
          <label class="config-label">Flujos expuestos como tools</label>
          <div style="max-height: 220px; overflow-y: auto; margin-top: 8px; border: 1px solid hsla(var(--text-muted) / 0.2); border-radius: 8px; padding: 8px;">
            <label v-for="flow in savedWorkflowsList" :key="flow.id" style="display: flex; align-items: center; gap: 8px; padding: 6px 4px; cursor: pointer; font-size: 13px;">
              <input type="checkbox" :checked="mcpServerWorkflowIds.includes(flow.id)" @change="toggleMcpWorkflow(flow.id)" style="width: 15px; height: 15px;" />
              <span>{{ flow.name }}</span>
            </label>
            <div v-if="savedWorkflowsList.length === 0" style="font-size: 12px; color: hsl(var(--text-muted)); text-align: center; padding: 12px;">
              No hay flujos guardados todavía.
            </div>
          </div>
        </div>

        <div class="form-group" style="margin-top: 16px; display: flex; align-items: center; gap: 8px;">
          <input id="mcp-require-auth" v-model="mcpServerRequireAuth" type="checkbox" style="width: 15px; height: 15px;" />
          <label for="mcp-require-auth" style="font-size: 13px; cursor: pointer;">Requerir token (Bearer) para conectarse</label>
        </div>
        <div class="form-group" style="margin-top: 8px; display: flex; align-items: center; gap: 8px;">
          <input id="mcp-system-tools" v-model="mcpServerExposeSystem" type="checkbox" style="width: 15px; height: 15px;" />
          <label for="mcp-system-tools" style="font-size: 13px; cursor: pointer;">Exponer también las herramientas de sistema (libreflow_*)</label>
        </div>

        <div class="modal-actions" style="margin-top: 24px;">
          <button @click="showMcpServerModal = false" class="btn btn-secondary">Cancelar</button>
          <button
            @click="saveMcpServerToDb"
            class="btn btn-primary"
            :disabled="!mcpServerName.trim() || mcpServerWorkflowIds.length === 0"
          >
            Guardar
          </button>
        </div>
      </div>
    </div>

    <!-- BATCH VALIDATION MODAL -->
    <div v-if="showBatchValidateModal" class="modal-overlay" role="dialog" aria-modal="true" v-focus-trap @click.self="closeAllModals()">
      <div class="modal-content" style="width: 680px; max-width: 95%;">
        <h3 class="modal-title">🔍 Validar coherencia de flujos</h3>
        <p class="modal-desc">Valida los flujos guardados en lote. Deja el filtro vacío para validar todos, o escribe un host/cadena (p.ej. <code>api.stripe.com</code>) para validar solo los que lo usan.</p>
        <div style="display: flex; gap: 10px; align-items: center;">
          <input
            v-model="batchContains"
            type="text"
            placeholder="Filtrar por API/cadena (vacío = todos)"
            style="flex: 1; padding: 10px 12px; border-radius: 8px;"
            @keyup.enter="runBatchValidate"
          />
          <button @click="runBatchValidate" class="btn btn-primary" :disabled="batchValidating">
            {{ batchValidating ? 'Validando…' : 'Validar' }}
          </button>
        </div>

        <div v-if="batchResult" style="margin-top: 16px;">
          <p class="modal-desc" style="margin-bottom: 10px;">
            {{ batchResult.summary.total }} flujo(s) ·
            <span :style="{ color: batchResult.summary.withErrors ? 'hsl(var(--color-danger))' : 'inherit' }">{{ batchResult.summary.withErrors }} con errores</span> ·
            {{ batchResult.summary.withWarnings }} con avisos
          </p>
          <div style="max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px;">
            <div
              v-for="wf in batchResult.workflows"
              :key="wf.id"
              v-show="wf.issues.length"
              class="validation-banner"
              style="position: static; width: auto; transform: none; box-shadow: none;"
            >
              <div class="validation-banner-head">
                <strong style="cursor: pointer;" @click="loadWorkflowForEdit(wf.id); closeAllModals();">
                  {{ wf.ok ? 'ℹ️' : '⚠️' }} {{ wf.name }}
                  <span style="font-weight: 400; opacity: 0.7;">({{ wf.errors }}e / {{ wf.warnings }}a)</span>
                </strong>
              </div>
              <ul class="validation-banner-list">
                <li v-for="(issue, i) in wf.issues" :key="i" :class="['validation-issue', issue.level]">
                  <span class="validation-dot" :class="issue.level"></span>{{ issue.message }}
                </li>
              </ul>
            </div>
            <p v-if="batchResult.summary.withErrors === 0 && batchResult.summary.withWarnings === 0" class="empty-table-message">
              ✓ Todos los flujos validados son coherentes.
            </p>
          </div>
        </div>

        <div class="modal-actions" style="margin-top: 16px;">
          <button @click="closeAllModals()" class="btn btn-secondary">Cerrar</button>
        </div>
      </div>
    </div>

    <!-- AI ERROR CONTEXT MODAL -->
    <div v-if="showAiContextModal" class="modal-overlay" role="dialog" aria-modal="true" v-focus-trap @click.self="closeAllModals()">
      <div class="modal-content" style="width: 640px; max-width: 95%;">
        <h3 class="modal-title">🤖 Contexto del error para la IA</h3>
        <p class="modal-desc">Instrucción lista para pegar a tu agente/LLM: incluye el flujo, la ejecución y el nodo que falló con su error.</p>
        <div v-if="aiContextLoading" class="empty-table-message">Generando contexto…</div>
        <template v-else>
          <textarea
            ref="aiContextTextarea"
            :value="aiContextText"
            readonly
            style="width: 100%; min-height: 220px; font-family: var(--font-mono, monospace); font-size: 13px; padding: 12px; border-radius: 8px;"
          ></textarea>
        </template>
        <div class="modal-actions" style="margin-top: 16px;">
          <button @click="closeAllModals()" class="btn btn-secondary">Cerrar</button>
          <button @click="copyAiContext" class="btn btn-primary" :disabled="aiContextLoading">
            {{ aiContextCopied ? '✓ Copiado' : 'Copiar al portapapeles' }}
          </button>
        </div>
      </div>
    </div>
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
const editingCredentialId = ref<string | null>(null);
const credentialName = ref('');
const credentialType = ref<'basicAuth' | 'apiKey' | 'oauth2'>('basicAuth');
const credUser = ref('');
const credPassword = ref('');
const credKeyName = ref('');
const credKeyValue = ref('');
const credKeyIn = ref<'header' | 'query'>('header');
// OAuth2
const oauthGrantType = ref<'client_credentials' | 'refresh_token' | 'authorization_code'>('client_credentials');
const oauthAuthUrl = ref('');
const oauthTokenUrl = ref('');
const oauthClientId = ref('');
const oauthClientSecret = ref('');
const oauthRefreshToken = ref('');
const oauthScope = ref('');
const oauthClientAuth = ref<'header' | 'body'>('header');
const oauthUsePkce = ref(true);
const oauthOfflineAccess = ref(true);
const oauthRedirectUri = ref('');
const oauthConnecting = ref(false);
const oauthConnected = ref(false);
const oauthConnectError = ref('');

// Validación del formulario de credencial según su tipo.
const canSaveCredential = computed(() => {
  if (!credentialName.value.trim()) return false;
  if (credentialType.value === 'basicAuth') return !!credUser.value.trim() && !!credPassword.value.trim();
  if (credentialType.value === 'apiKey') return !!credKeyName.value.trim() && !!credKeyValue.value.trim();
  if (credentialType.value === 'oauth2') {
    if (!oauthTokenUrl.value.trim() || !oauthClientId.value.trim()) return false;
    if (oauthGrantType.value === 'refresh_token' && !oauthRefreshToken.value.trim()) return false;
    if (oauthGrantType.value === 'authorization_code' && !oauthAuthUrl.value.trim()) return false;
    return true;
  }
  return false;
});

// Carga el redirect_uri que el usuario debe registrar en el proveedor.
const fetchOAuthRedirectUri = async () => {
  try {
    const res = await fetch('/api/oauth/redirect-uri');
    if (res.ok) oauthRedirectUri.value = (await res.json()).redirectUri || '';
  } catch { /* ignore */ }
};

// Inicia el flujo interactivo: abre un popup al proveedor y espera el postMessage del callback.
const connectOAuth = () => {
  if (!editingCredentialId.value) return;
  oauthConnectError.value = '';
  oauthConnecting.value = true;
  const id = editingCredentialId.value;

  const onMessage = (e: MessageEvent) => {
    if (!e.data || e.data.source !== 'libreflow-oauth') return;
    window.removeEventListener('message', onMessage);
    oauthConnecting.value = false;
    if (e.data.ok) {
      oauthConnected.value = true;
    } else {
      oauthConnectError.value = e.data.detail || 'Error de conexión';
    }
  };
  window.addEventListener('message', onMessage);

  (async () => {
    try {
      const res = await fetch(`/api/credentials/${id}/oauth/authorize`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error || 'No se pudo iniciar OAuth');
      const { url } = await res.json();
      const popup = window.open(url, 'libreflow-oauth', 'width=620,height=720');
      if (!popup) throw new Error('El navegador bloqueó el popup. Permítelo y reintenta.');
    } catch (err: any) {
      window.removeEventListener('message', onMessage);
      oauthConnecting.value = false;
      oauthConnectError.value = err.message;
    }
  })();
};

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
        parameters: n.parameters || {}
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

const openCreateCredentialModal = () => {
  editingCredentialId.value = null;
  credentialName.value = '';
  credentialType.value = 'basicAuth';
  credUser.value = '';
  credPassword.value = '';
  credKeyName.value = '';
  credKeyValue.value = '';
  credKeyIn.value = 'header';
  oauthGrantType.value = 'client_credentials';
  oauthAuthUrl.value = '';
  oauthTokenUrl.value = '';
  oauthClientId.value = '';
  oauthClientSecret.value = '';
  oauthRefreshToken.value = '';
  oauthScope.value = '';
  oauthClientAuth.value = 'header';
  oauthUsePkce.value = true;
  oauthOfflineAccess.value = true;
  oauthConnected.value = false;
  oauthConnectError.value = '';
  fetchOAuthRedirectUri();
  showCredentialModal.value = true;
};

const openEditCredentialModal = async (id: string) => {
  try {
    const res = await fetch(`/api/credentials/${id}`);
    if (res.ok) {
      const cred = await res.json();
      editingCredentialId.value = cred.id;
      credentialName.value = cred.name;
      credentialType.value = cred.type;
      
      // El endpoint GET no devuelve el material secreto descifrado (solo metadatos), así
      // que los campos sensibles llegan vacíos y se vuelven a introducir al editar.
      const data = cred.data || {};
      if (cred.type === 'basicAuth') {
        credUser.value = data.user || '';
        credPassword.value = data.password || '';
      } else if (cred.type === 'apiKey') {
        credKeyName.value = data.name || '';
        credKeyValue.value = data.value || '';
        credKeyIn.value = data.in || 'header';
      } else if (cred.type === 'oauth2') {
        oauthGrantType.value = data.grantType || 'client_credentials';
        oauthAuthUrl.value = data.authUrl || '';
        oauthTokenUrl.value = data.tokenUrl || '';
        oauthClientId.value = data.clientId || '';
        oauthClientSecret.value = data.clientSecret || '';
        oauthRefreshToken.value = data.refreshToken || '';
        oauthScope.value = data.scope || '';
        oauthClientAuth.value = data.clientAuth || 'header';
        oauthUsePkce.value = data.usePkce !== false;
        oauthOfflineAccess.value = data.offlineAccess !== false;
        oauthConnected.value = !!cred.connected; // flag derivado del backend (no expone token)
        oauthConnectError.value = '';
        fetchOAuthRedirectUri();
      }
      showCredentialModal.value = true;
    }
  } catch (err) {
    console.error('Error loading credential details:', err);
  }
};

const saveCredentialToDb = async () => {
  const id = editingCredentialId.value || `cred-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const data: Record<string, any> = {};
  
  if (credentialType.value === 'basicAuth') {
    data.user = credUser.value;
    data.password = credPassword.value;
  } else if (credentialType.value === 'apiKey') {
    data.name = credKeyName.value;
    data.value = credKeyValue.value;
    data.in = credKeyIn.value;
  } else if (credentialType.value === 'oauth2') {
    data.grantType = oauthGrantType.value;
    data.tokenUrl = oauthTokenUrl.value.trim();
    data.clientId = oauthClientId.value;
    data.clientSecret = oauthClientSecret.value;
    data.clientAuth = oauthClientAuth.value;
    if (oauthScope.value.trim()) data.scope = oauthScope.value.trim();
    if (oauthGrantType.value === 'refresh_token') data.refreshToken = oauthRefreshToken.value;
    if (oauthGrantType.value === 'authorization_code') {
      data.authUrl = oauthAuthUrl.value.trim();
      data.usePkce = oauthUsePkce.value;
      data.offlineAccess = oauthOfflineAccess.value;
    }
  }

  const payload = {
    id,
    name: credentialName.value,
    type: credentialType.value,
    data
  };

  try {
    const res = await fetch('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      await fetchCredentials();
      // OAuth2 interactivo: mantén el modal abierto tras guardar para poder "Conectar"
      // (el botón necesita un id ya persistido).
      if (credentialType.value === 'oauth2' && oauthGrantType.value === 'authorization_code') {
        editingCredentialId.value = id;
      } else {
        showCredentialModal.value = false;
      }
    }
  } catch (err) {
    console.error('Error saving credential:', err);
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
      position: n.position // Save node position coordinates
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
const runWorkflow = async () => {
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
    parameters: n.data.parameters
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
        payload: {}
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

const mcpServerUrl = (id: string) => `${window.location.origin}/mcp/${id}`;

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
