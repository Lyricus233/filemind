import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const { FILEMIND_API_TARGET = 'http://127.0.0.1:3000' } = loadEnv(
    mode,
    process.cwd(),
    'FILEMIND_',
  );
  const proxy = {
    '^/api(?:/|$)': {
      target: FILEMIND_API_TARGET,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api(?=\/|$)/, ''),
    },
  };

  return {
    plugins: [react()],
    server: { host: '127.0.0.1', proxy },
    preview: { host: '127.0.0.1', proxy },
  };
});
