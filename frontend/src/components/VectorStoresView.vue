<script setup lang="ts">
// Vista de colecciones de vectores (RAG). Presentacional: lista + borrar. Las colecciones se
// crean/llenan ejecutando el nodo vectorStore (operación index); aquí solo se ven y se borran.
defineProps<{ stores: any[]; loaded: boolean }>();
const emit = defineEmits<{ (e: 'delete', collection: string): void }>();
</script>

<template>
  <section class="vs-view">
    <div class="config-header" style="border-bottom: none;">
      <div>
        <h2 class="config-title">🧠 Vector Stores (RAG)</h2>
        <span class="node-subtitle">Bases de conocimiento para búsqueda por similitud. Se llenan con el nodo <code>vectorStore</code> (indexar).</span>
      </div>
    </div>

    <p v-if="!loaded" class="vs-empty">Cargando colecciones…</p>
    <p v-else-if="stores.length === 0" class="vs-empty">
      No tienes colecciones de vectores. Ejecuta un nodo <code>vectorStore</code> con operación <strong>Indexar</strong> para crear una.
    </p>
    <table v-else class="vs-table">
      <thead>
        <tr><th>Colección</th><th>Ficheros</th><th>Actualizado</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="s in stores" :key="s.collection">
          <td>{{ s.collection }}</td>
          <td>{{ s.files }}</td>
          <td>{{ s.updated_at || '—' }}</td>
          <td><button class="vs-del" @click="emit('delete', s.collection)">Borrar</button></td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.vs-view { padding: 24px; color: #e2e8f0; }
.vs-empty { color: #94a3b8; margin-top: 16px; }
.vs-table { width: 100%; border-collapse: collapse; margin-top: 12px; }
.vs-table th, .vs-table td { text-align: left; padding: 10px 12px; border-bottom: 1px solid hsl(var(--border-color)); }
.vs-del { background: transparent; border: 1px solid #b91c1c; color: #f87171; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
</style>
