import {defineConfig} from 'vite';

/**
 * MAIN world 被动旁路单独构建为 IIFE。
 * 必须与 content.js 分开打包：两者运行在不同的 JS 世界，不能共享模块实例。
 */
export default defineConfig({
  publicDir: false,
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'src/content/reserve-hook.ts',
      name: 'LsaReserveHook',
      formats: ['iife'],
      fileName: () => 'hook.js',
    },
  },
});
