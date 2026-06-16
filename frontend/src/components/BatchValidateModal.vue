<template>
  <div class="modal-overlay" role="dialog" aria-modal="true" v-focus-trap @click.self="emit('close')">
    <div class="modal-content" style="width: 680px; max-width: 95%;">
      <h3 class="modal-title">🔍 Validar coherencia de flujos</h3>
      <p class="modal-desc">Valida los flujos guardados en lote. Deja el filtro vacío para validar todos, o escribe un host/cadena (p.ej. <code>api.stripe.com</code>) para validar solo los que lo usan.</p>
      <div style="display: flex; gap: 10px; align-items: center;">
        <input
          v-model="containsModel"
          type="text"
          placeholder="Filtrar por API/cadena (vacío = todos)"
          style="flex: 1; padding: 10px 12px; border-radius: 8px;"
          @keyup.enter="emit('validate')"
        />
        <button @click="emit('validate')" class="btn btn-primary" :disabled="validating">
          {{ validating ? 'Validando…' : 'Validar' }}
        </button>
      </div>

      <div v-if="result" style="margin-top: 16px;">
        <p class="modal-desc" style="margin-bottom: 10px;">
          {{ result.summary.total }} flujo(s) ·
          <span :style="{ color: result.summary.withErrors ? 'hsl(var(--color-danger))' : 'inherit' }">{{ result.summary.withErrors }} con errores</span> ·
          {{ result.summary.withWarnings }} con avisos
        </p>
        <div style="max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px;">
          <div
            v-for="wf in result.workflows"
            :key="wf.id"
            v-show="wf.issues.length"
            class="validation-banner"
            style="position: static; width: auto; transform: none; box-shadow: none;"
          >
            <div class="validation-banner-head">
              <strong style="cursor: pointer;" @click="emit('open-flow', wf.id)">
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
          <p v-if="result.summary.withErrors === 0 && result.summary.withWarnings === 0" class="empty-table-message">
            ✓ Todos los flujos validados son coherentes.
          </p>
        </div>
      </div>

      <div class="modal-actions" style="margin-top: 16px;">
        <button @click="emit('close')" class="btn btn-secondary">Cerrar</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  contains: string;
  validating: boolean;
  result: any;
}>();

const emit = defineEmits<{
  (e: 'update:contains', value: string): void;
  (e: 'validate'): void;
  (e: 'open-flow', id: string): void;
  (e: 'close'): void;
}>();

const containsModel = computed({ get: () => props.contains, set: (v: string) => emit('update:contains', v) });
</script>
