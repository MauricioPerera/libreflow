import { createApp } from 'vue';
import App from './App.vue';
import './index.css';
import { focusTrap } from './focusTrap';

// Core styles are required for Vue Flow
import '@vue-flow/core/dist/style.css';

// Theme styles (optional, but good for base styles)
import '@vue-flow/core/dist/theme-default.css';

const app = createApp(App);
app.directive('focus-trap', focusTrap);
app.mount('#app');
