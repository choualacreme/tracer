import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: [
      '.ngrok-free.app',
    ]
  },
  build: {
    // バックエンドの priv/static ディレクトリへ出力
    outDir: '../tracer_backend/priv/static',
    emptyOutDir: true
  }
})
