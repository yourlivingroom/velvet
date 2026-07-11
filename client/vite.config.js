import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds to client/dist, which the velvet server serves (content-negotiated).
// In dev (`velvet --dev`), Vite serves this with HMR and proxies data/infra
// requests to the backend — mirroring production's same-URL negotiation:
//   - a browser navigation (Accept: text/html) to a client route → Vite (HMR);
//   - a fetch (Accept: application/json / *) or an infra path → the backend.
// Vite's own /@… /src/… /node_modules/ paths aren't matched, so Vite handles
// them natively (that's what drives HMR).
const INFRA = /^\/(mcp|oauth|bootstrap|\.well-known|docs|admin)(\/|$)/;

export default defineConfig({
    plugins: [react()],
    server: {
        proxy: {
            '^/(?!@|src/|node_modules/|vite\\.svg$)': {
                target: 'http://localhost:3000',
                changeOrigin: true,
                bypass(req) {
                    const accept = req.headers.accept ?? '';
                    const path = (req.url || '').split('?')[0];
                    // Browser navigation to a client route → let Vite serve the
                    // app shell (with HMR). Everything else proxies to velvet.
                    if (accept.includes('text/html') && !INFRA.test(path)) {
                        return '/index.html';
                    }
                }
            }
        }
    }
});
