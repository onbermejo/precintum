import { describe, expect, it } from 'vitest';
import { splitNotClosed } from '../src/cli/export-commands.ts';

// Rango de 10 ventanas de 300 s; el último lote cubre la tercera (serviceEnd = 900).
const pkg = {
  covered: [0, 3000] as [number, number],
  windowSeconds: 300,
  serviceEnd: 900,
  batches: [{ window: [0, 300] as [number, number] }, { window: [600, 900] as [number, number] }],
  totals: { windowsNotClosed: 7 },
};

describe('splitNotClosed: ventanas sin lote después del último', () => {
  it('separa las terminadas (se pueden cerrar) de las que aún no han terminado', () => {
    // A las 1500 + 120 de gracia: han terminado [900,1200) y [1200,1500).
    expect(splitNotClosed(pkg, 1620, 120)).toEqual({ closable: 2, notEnded: 5 });
  });

  it('dentro de la gracia una ventana terminada aún no cuenta como cerrable', () => {
    expect(splitNotClosed(pkg, 1619, 120)).toEqual({ closable: 1, notEnded: 6 });
  });

  it('sin lotes no hay nada que cerrar: todo se declara anterior al servicio', () => {
    expect(
      splitNotClosed(
        { ...pkg, serviceEnd: null, batches: [], totals: { windowsNotClosed: 0 } },
        9999,
        120,
      ),
    ).toEqual({ closable: 0, notEnded: 0 });
  });
});
