import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served from /mobile/ on the same origin as the web app, so the paths the browser asks for
// have to carry that prefix. Same origin matters: the service worker's scope, the manifest and
// the API all come from one place, and the phone never has to deal with a second host.
export default defineConfig({ base: '/mobile/', plugins: [react()] });
