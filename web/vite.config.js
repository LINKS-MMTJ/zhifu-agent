import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// PWA：让 React 应用可"安装到手机主屏"，无需原生开发
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: '智服客服 Agent',
        short_name: '智服',
        description: '电商售后智能客服 · 智能模型路由',
        theme_color: '#0FDC78',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      // 开发环境把 /api 代理到后端
      '/api': 'http://localhost:4000',
    },
  },
});
