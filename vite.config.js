import { defineConfig } from 'vite';

export default defineConfig({
  // 开发服务器配置
  server: {
    port: 5173,
    open: false
  },
  build: {
    // Phaser 包体积大，放宽 chunk 警告阈值
    chunkSizeWarningLimit: 1500
  }
});
