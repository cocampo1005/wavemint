import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Applied to the packaged UI only; the dev server needs inline scripts for
// hot reloading. Thumbnails load from YouTube's image hosts over https, and
// generated artwork previews arrive as data: URLs from the main process.
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ')

function productionCsp() {
  return {
    name: 'wavemint-production-csp',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: PRODUCTION_CSP },
          injectTo: 'head-prepend',
        },
      ]
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // Relative asset URLs so the built UI loads from file:// inside the
  // packaged app, regardless of where WaveMint is installed.
  base: './',
  plugins: [react(), productionCsp()],
  server: {
    // Packaging output and bundled binaries are large and never imported by
    // the UI. On Windows, watching them also locks the folders, which makes
    // electron-builder fail while `npm start` is running.
    watch: { ignored: ['**/release/**', '**/resources/**'] },
  },
})
