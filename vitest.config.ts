import { defineConfig } from 'vitest/config';

const integration = process.env.PRECINTUM_IT === '1';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Los tests de integración (test/**/*.it.test.ts) hablan con relays reales.
    // Solo se ejecutan con PRECINTUM_IT=1 (pnpm test:it) para que la suite normal sea determinista.
    exclude: integration ? ['node_modules/**'] : ['test/**/*.it.test.ts', 'node_modules/**'],
    // Los tests de CLI crean procesos nuevos; Windows necesita margen para su arranque en frío.
    ...(process.platform === 'win32'
      ? { maxWorkers: 1, testTimeout: 90_000 }
      : { testTimeout: 15_000 }),
    // Con PRECINTUM_IT=1 hay tests que dependen de relays, TSA y calendarios públicos, que a veces no
    // contestan a tiempo: se reintentan dos veces antes de darlos por fallidos.
    retry: integration ? 2 : 0,
  },
});
