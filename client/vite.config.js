import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = (env.VITE_API_PROXY_TARGET || 'https://www.yuce.bid').replace(/\/$/, '')

  return {
    plugins: [vue(), tailwindcss()],
    server: {
      port: 5279,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true, secure: true },
      },
    },
  }
})
