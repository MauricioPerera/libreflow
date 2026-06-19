<script setup lang="ts">
import { ref, onMounted } from 'vue';

// Vista de gestión de usuarios (solo admin). Autónoma: consume /api/users directamente (el
// Bearer lo inyecta el interceptor global). Recibe el id del usuario actual para no ofrecer
// borrarse a sí mismo.
const props = defineProps<{ currentUserId: string | null }>();

interface UserRow { id: string; email: string; role: string; created_at?: string }

const users = ref<UserRow[]>([]);
const loading = ref(false);
const error = ref('');

// Alta
const newEmail = ref('');
const newPassword = ref('');
const newRole = ref<'user' | 'admin'>('user');
const creating = ref(false);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch('/api/users');
    if (!res.ok) { error.value = 'No se pudo cargar la lista de usuarios.'; return; }
    users.value = await res.json();
  } catch { error.value = 'Error de red.'; }
  finally { loading.value = false; }
}

async function createUser() {
  error.value = '';
  if (!newEmail.value || !newPassword.value) { error.value = 'Email y contraseña son obligatorios.'; return; }
  creating.value = true;
  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: newEmail.value, password: newPassword.value, role: newRole.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { error.value = data?.error || 'No se pudo crear el usuario.'; return; }
    newEmail.value = ''; newPassword.value = ''; newRole.value = 'user';
    await load();
  } catch { error.value = 'Error de red.'; }
  finally { creating.value = false; }
}

async function deleteUser(u: UserRow) {
  if (!confirm(`¿Borrar al usuario "${u.email}"? Sus recursos quedarán solo accesibles para administradores.`)) return;
  error.value = '';
  try {
    const res = await fetch(`/api/users/${u.id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { error.value = data?.error || 'No se pudo borrar el usuario.'; return; }
    await load();
  } catch { error.value = 'Error de red.'; }
}

onMounted(load);
defineExpose({ load });
</script>

<template>
  <section class="users-view">
    <h2 class="users-title">👤 Usuarios</h2>

    <form class="user-create" @submit.prevent="createUser">
      <input v-model="newEmail" type="email" placeholder="email@dominio.com" class="user-input" :disabled="creating" />
      <input v-model="newPassword" type="password" placeholder="contraseña" class="user-input" :disabled="creating" />
      <select v-model="newRole" class="user-input" :disabled="creating">
        <option value="user">Usuario</option>
        <option value="admin">Admin</option>
      </select>
      <button type="submit" class="user-create-btn" :disabled="creating">{{ creating ? 'Creando…' : 'Crear usuario' }}</button>
    </form>

    <p v-if="error" class="users-error" role="alert">{{ error }}</p>

    <p v-if="loading" class="users-empty">Cargando…</p>
    <table v-else class="users-table">
      <thead>
        <tr><th>Email</th><th>Rol</th><th>Creado</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="u in users" :key="u.id">
          <td>{{ u.email }}</td>
          <td><span :class="['role-badge', u.role]">{{ u.role }}</span></td>
          <td>{{ u.created_at || '—' }}</td>
          <td>
            <button
              v-if="u.id !== props.currentUserId"
              class="user-del-btn"
              @click="deleteUser(u)"
            >Borrar</button>
            <span v-else class="users-self">(tú)</span>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.users-view { padding: 24px; color: #e2e8f0; }
.users-title { margin: 0 0 20px; }
.user-create { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.user-input { background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 8px 10px; color: #f8fafc; }
.user-create-btn { background: #6366f1; color: #fff; border: none; border-radius: 6px; padding: 8px 14px; cursor: pointer; font-weight: 600; }
.user-create-btn:disabled { opacity: 0.6; }
.users-error { color: #f87171; }
.users-empty { color: #94a3b8; }
.users-table { width: 100%; border-collapse: collapse; }
.users-table th, .users-table td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #334155; }
.role-badge { font-size: 0.75rem; padding: 2px 8px; border-radius: 999px; background: #334155; }
.role-badge.admin { background: #7c3aed; color: #fff; }
.user-del-btn { background: transparent; border: 1px solid #b91c1c; color: #f87171; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
.users-self { color: #64748b; font-size: 0.85rem; }
</style>
