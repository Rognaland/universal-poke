import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
  server: {
  host: true,
    port: 3002,
    strictPort: true,
    open: false
  },
  build: {
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-[hash]-${Date.now()}.js`,
        chunkFileNames: `assets/[name]-[hash]-${Date.now()}.js`,
        assetFileNames: `assets/[name]-[hash]-${Date.now()}.[ext]`,
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('ethers')) return 'vendor-ethers';
            if (id.includes('firebase')) return 'vendor-firebase';
            if (id.includes('@erc725') || id.includes('erc725')) return 'vendor-erc725';
            return 'vendor';
          }
        }
      }
    }
  }
});
