<template>
  <div class="modal-overlay" role="dialog" aria-modal="true" v-focus-trap @click.self="emit('close')">
    <div class="modal-content" style="width: 640px; max-width: 95%;">
      <h3 class="modal-title">🤖 Contexto del error para la IA</h3>
      <p class="modal-desc">Instrucción lista para pegar a tu agente/LLM: incluye el flujo, la ejecución y el nodo que falló con su error.</p>
      <div v-if="loading" class="empty-table-message">Generando contexto…</div>
      <template v-else>
        <textarea
          :value="text"
          readonly
          style="width: 100%; min-height: 220px; font-family: var(--font-mono, monospace); font-size: 13px; padding: 12px; border-radius: 8px;"
        ></textarea>
      </template>
      <div class="modal-actions" style="margin-top: 16px;">
        <button @click="emit('close')" class="btn btn-secondary">Cerrar</button>
        <button @click="emit('copy')" class="btn btn-primary" :disabled="loading">
          {{ copied ? '✓ Copiado' : 'Copiar al portapapeles' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  loading: boolean;
  text: string;
  copied: boolean;
}>();

const emit = defineEmits<{
  (e: 'copy'): void;
  (e: 'close'): void;
}>();
</script>
