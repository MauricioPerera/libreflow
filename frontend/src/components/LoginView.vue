<script setup lang="ts">
import { ref } from 'vue';

// Pantalla de login: email/password → POST /api/auth/login. Emite `logged-in` con el token y el
// usuario; App.vue persiste el token y muestra el dashboard. No guarda nada por sí misma.
const emit = defineEmits<{ (e: 'logged-in', payload: { token: string; user: any }): void }>();

const email = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

async function submit() {
  error.value = '';
  if (!email.value || !password.value) {
    error.value = 'Introduce email y contraseña.';
    return;
  }
  loading.value = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.value, password: password.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      error.value = data?.error || 'No se pudo iniciar sesión.';
      return;
    }
    emit('logged-in', { token: data.token, user: data.user });
  } catch (e: any) {
    error.value = 'Error de red al iniciar sesión.';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-layout">
    <form class="login-card" @submit.prevent="submit">
      <div class="login-brand">⚡ LibreFlow</div>
      <p class="login-sub">Inicia sesión para continuar</p>

      <label class="login-label" for="login-email">Email</label>
      <input id="login-email" v-model="email" type="email" autocomplete="username" class="login-input" :disabled="loading" />

      <label class="login-label" for="login-password">Contraseña</label>
      <input id="login-password" v-model="password" type="password" autocomplete="current-password" class="login-input" :disabled="loading" />

      <p v-if="error" class="login-error" role="alert">{{ error }}</p>

      <button type="submit" class="login-btn" :disabled="loading">
        {{ loading ? 'Entrando…' : 'Entrar' }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.login-layout {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: #0f172a;
}
.login-card {
  width: 100%;
  max-width: 360px;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 12px;
  padding: 32px;
  display: flex;
  flex-direction: column;
}
.login-brand {
  font-size: 1.6rem;
  font-weight: 700;
  color: #f8fafc;
  text-align: center;
}
.login-sub {
  color: #94a3b8;
  text-align: center;
  margin: 4px 0 24px;
  font-size: 0.9rem;
}
.login-label {
  color: #cbd5e1;
  font-size: 0.8rem;
  margin-bottom: 4px;
}
.login-input {
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 10px 12px;
  color: #f8fafc;
  margin-bottom: 16px;
  font-size: 0.95rem;
}
.login-input:focus {
  outline: none;
  border-color: #6366f1;
}
.login-error {
  color: #f87171;
  font-size: 0.85rem;
  margin: 0 0 12px;
}
.login-btn {
  background: #6366f1;
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 11px;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
}
.login-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
