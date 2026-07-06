import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // netlify dev proxies functions; direct vite dev can still hit deployed functions if you set this
    port: 5173,
  },
})
