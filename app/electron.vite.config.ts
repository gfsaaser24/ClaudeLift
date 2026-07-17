import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    // electron-store@10 and p-queue@9 are ESM-only: bundle them instead of
    // externalizing so the CJS main output can load them.
    plugins: [externalizeDepsPlugin({ exclude: ['electron-store', 'p-queue'] })]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react(), tailwindcss()]
  }
})
