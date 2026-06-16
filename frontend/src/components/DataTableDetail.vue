<template>
  <div class="table-details-view">
    <div class="subview-header" style="margin-bottom: 16px;">
      <div>
        <div style="display: flex; align-items: center; gap: 12px;">
          <button @click="emit('back')" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;">
            ← Volver
          </button>
          <h2 class="subview-title" style="margin: 0;">📊 {{ table.name }}</h2>
        </div>
        <p class="subview-desc" style="margin-top: 6px;">ID: <span class="code-font" style="font-size: 12px;">{{ table.id }}</span></p>
      </div>
      <div style="display: flex; gap: 8px;">
        <button @click="emit('add-row')" class="btn btn-primary">
          + Añadir Fila
        </button>
        <button @click="emit('edit-schema')" class="btn btn-secondary">
          ⚙️ Columnas
        </button>
      </div>
    </div>

    <div class="table-container" style="overflow-x: auto;">
      <table class="dashboard-table">
        <thead>
          <tr>
            <th v-for="col in table.columns" :key="col.name">
              {{ col.name }} <span style="font-size: 12px; opacity: 0.6; text-transform: lowercase;">({{ col.type }})</span>
            </th>
            <th style="width: 140px; text-align: right;">Acciones</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td v-for="col in table.columns" :key="col.name">
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
                  <button @click="emit('save-edit', row.id)" class="btn btn-primary" style="padding: 4px 8px; font-size: 12px;">
                    Guardar
                  </button>
                  <button @click="emit('cancel-edit')" class="btn btn-secondary" style="padding: 4px 8px; font-size: 12px;">
                    Cancelar
                  </button>
                </template>
                <template v-else>
                  <button @click="emit('start-edit', row)" class="btn btn-secondary" style="padding: 4px 8px; font-size: 12px;">
                    Editar
                  </button>
                  <button @click="emit('delete-row', row.id)" class="btn btn-secondary" style="padding: 4px 8px; font-size: 12px; border-color: hsla(var(--color-danger) / 0.3); color: hsl(var(--color-danger));">
                    Borrar
                  </button>
                </template>
              </div>
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td :colspan="table.columns.length + 1" class="empty-table-message">
              Esta tabla está vacía. Añade tu primera fila para comenzar.
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  table: any;
  rows: any[];
  editingRowId: string | null;
  // Objeto compartido con el padre: el v-model de celda muta sus propiedades in situ
  // (misma referencia), preservando el comportamiento original sin duplicar estado.
  editingRowData: Record<string, any>;
}>();

const emit = defineEmits<{
  (e: 'back'): void;
  (e: 'add-row'): void;
  (e: 'edit-schema'): void;
  (e: 'start-edit', row: any): void;
  (e: 'cancel-edit'): void;
  (e: 'save-edit', rowId: string): void;
  (e: 'delete-row', rowId: string): void;
}>();
</script>
