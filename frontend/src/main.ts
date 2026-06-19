import { createApp } from 'vue';
import App from './App.vue';
import './index.css';
import { focusTrap } from './focusTrap';
import { installFetchAuth } from './auth';

// Inyecta el Bearer en las llamadas a la API y gestiona los 401 (debe ir ANTES de montar).
installFetchAuth();

// Core styles are required for Vue Flow
import '@vue-flow/core/dist/style.css';

// Theme styles (optional, but good for base styles)
import '@vue-flow/core/dist/theme-default.css';

const app = createApp(App);
app.directive('focus-trap', focusTrap);
app.mount('#app');
