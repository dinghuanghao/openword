import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

const getConfigValue = (env: Record<string, string>, key: string) => process.env[key] ?? env[key];

const toPort = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  const devPort = toPort(getConfigValue(env, 'PORT'), 30000);
  const bffPort = toPort(getConfigValue(env, 'BFF_PORT'), 31000);
  const geminiApiKey = getConfigValue(env, 'GEMINI_API_KEY') ?? '';
  const bffTarget = `http://127.0.0.1:${bffPort}`;

  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(geminiApiKey),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: devPort,
      proxy: {
        '/api': {
          target: bffTarget,
          changeOrigin: true,
        },
        '/health': {
          target: bffTarget,
          changeOrigin: true,
        },
        '/ws': {
          target: bffTarget,
          changeOrigin: true,
          ws: true,
        },
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: getConfigValue(env, 'DISABLE_HMR') !== 'true',
    },
  };
});
