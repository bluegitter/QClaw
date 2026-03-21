import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@guanjia-openclaw/shared', '@guanjia-openclaw/report', '@electron-toolkit/utils', 'electron-log'] })],
    define: {
      'process.env.BUILD_ENV': JSON.stringify(process.env.BUILD_ENV || 'test'),
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@guanjia-openclaw/shared'] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        }
      }
    }
  },
  renderer: {
    plugins: [vue()],
    server: {
      host: '127.0.0.1',
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
