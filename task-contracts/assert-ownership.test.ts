// PROPERTY-TESTS CONGELADOS del contrato `assert-ownership`.
// Fuera de la suite (no en backend/tests ni frontend/src). Oráculo independiente del target.
import { describe, it, expect } from 'vitest';
import { assert_ownership } from '../src/db.js';

describe('assert_ownership', () => {
  it('admin siempre autoriza', () => {
    expect(assert_ownership('user-B', 'user-A', true)).toBe(true);
  });
  it('mismo dueño autoriza', () => {
    expect(assert_ownership('user-A', 'user-A', false)).toBe(true);
  });
  it('dueño distinto niega', () => {
    expect(assert_ownership('user-B', 'user-A', false)).toBe(false);
  });
  it('huérfano niega a no-admin', () => {
    expect(assert_ownership('', 'user-A', false)).toBe(false);
  });
});
