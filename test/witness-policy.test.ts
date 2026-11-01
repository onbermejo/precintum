import { describe, expect, it } from 'vitest';
import { backoffSeconds, classifyFailure, quorumMet } from '../src/domain/witness/policy.ts';

describe('política de reintentos', () => {
  it('reintenta lo transitorio y se rinde ante la política del relay', () => {
    expect(classifyFailure('timeout', 'sin OK en 8000ms')).toBe('retry');
    expect(classifyFailure('closed', 'conexión cerrada')).toBe('retry');
    expect(classifyFailure('connect', 'error de conexión')).toBe('retry');
    expect(classifyFailure('rejected', 'rate-limited: slow down')).toBe('retry');
    expect(classifyFailure('rejected', 'error: database busy')).toBe('retry');
    expect(classifyFailure('rejected', 'blocked: pubkey is not allowed')).toBe('final');
    expect(classifyFailure('rejected', 'invalid: created_at out of range')).toBe('final');
    expect(classifyFailure('rejected', 'pow: 28 bits needed')).toBe('final');
    expect(classifyFailure('rejected', 'mute: no thanks')).toBe('final');
    expect(classifyFailure('restricted', 'restricted: not allowed')).toBe('final');
    expect(classifyFailure('auth-required', 'auth-required: …')).toBe('final');
  });

  it('un rechazo sin prefijo estandarizado se reintenta (es barato; perderlo no)', () => {
    expect(classifyFailure('rejected', 'nope')).toBe('retry');
    expect(classifyFailure('unknown', '')).toBe('retry');
  });
});

describe('backoff exponencial con jitter', () => {
  const mid = () => 0.5; // jitter neutro: factor 1.0
  it('crece 30, 60, 120… y se corta en una hora', () => {
    expect(backoffSeconds(0, mid)).toBe(30);
    expect(backoffSeconds(1, mid)).toBe(60);
    expect(backoffSeconds(2, mid)).toBe(120);
    expect(backoffSeconds(6, mid)).toBe(1_920);
    expect(backoffSeconds(7, mid)).toBe(3_600);
    expect(backoffSeconds(50, mid)).toBe(3_600);
  });

  it('el jitter mueve ±20 % y nunca baja de 1 s', () => {
    expect(backoffSeconds(0, () => 0)).toBe(24);
    expect(backoffSeconds(0, () => 1)).toBe(36);
    expect(backoffSeconds(0, () => 0, { baseSeconds: 1 })).toBe(1);
  });
});

describe('quórum N de M', () => {
  it('compara con el mínimo y rechaza quórums absurdos', () => {
    expect(quorumMet(2, 2)).toBe(true);
    expect(quorumMet(1, 2)).toBe(false);
    expect(quorumMet(5, 3)).toBe(true);
    expect(() => quorumMet(1, 0)).toThrow(/quórum/);
  });
});
