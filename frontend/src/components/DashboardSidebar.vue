<script setup lang="ts">
// Sidebar de navegación del dashboard: marca, menú de subvistas y bloque de sesión.
// Presentacional: emite `select(view)` (App.vue cambia la subvista y dispara el fetch que toque)
// y `logout`. La entrada "Usuarios" solo aparece para admin. Estilos globales en index.css.
defineProps<{
  activeSubView: string;
  isAdmin: boolean;
  userLabel: string;
  userEmail: string;
}>();

const emit = defineEmits<{
  (e: 'select', view: string): void;
  (e: 'logout'): void;
}>();

const items = [
  { view: 'workflows', label: '📂 Flujos de Trabajo' },
  { view: 'executions', label: '⏳ Ejecuciones' },
  { view: 'credentials', label: '🔑 Credenciales' },
  { view: 'datatables', label: '📊 Tablas de Datos' },
  { view: 'mcpservers', label: '🔌 Servidores MCP' },
];
</script>

<template>
  <aside class="dashboard-sidebar">
    <div class="sidebar-brand">
      <span class="brand-logo">⚡ LibreFlow</span>
    </div>
    <nav class="sidebar-menu">
      <button
        v-for="item in items"
        :key="item.view"
        @click="emit('select', item.view)"
        :class="['menu-btn', { active: activeSubView === item.view }]"
      >
        {{ item.label }}
      </button>
      <button
        v-if="isAdmin"
        @click="emit('select', 'users')"
        :class="['menu-btn', { active: activeSubView === 'users' }]"
      >
        👤 Usuarios
      </button>
    </nav>

    <!-- Sesión: usuario actual + cerrar sesión -->
    <div class="sidebar-session">
      <span class="session-email" :title="userEmail">{{ userLabel }}</span>
      <button class="logout-btn" @click="emit('logout')">Cerrar sesión</button>
    </div>
  </aside>
</template>
