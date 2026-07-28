import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// Bake the version into the bundle. Settings used to learn its own version from
// /api/settings/version, so any hiccup on that call left it showing "Version …"
// — the app couldn't state what build it was, which is exactly what you need
// when filing a bug. The release workflow bumps this file, so it's the truth.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// https://vitejs.dev/config/
export default defineConfig({
  // Demo build is served from https://<user>.github.io/bindarr/, so assets need
  // that sub-path prefix. Every other build (web/mobile) stays root-relative.
  base: process.env.VITE_DEMO ? '/bindarr/' : '/',
  plugins: [react(), basicSsl()],
  // Matches how the app already reads build-time config (VITE_DEMO), so this
  // needs no new global and no eslint exception.
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
  // Ship source maps so a minified production error (e.g. a device-only crash in
  // the Android WebView) maps back to real file:line via chrome://inspect. Repo
  // is public, so exposing sources costs nothing.
  build: {
    sourcemap: true,
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      }
    }
  }
})
