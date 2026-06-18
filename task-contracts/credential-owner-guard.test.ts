// PROPERTY-TESTS CONGELADOS del contrato `credential-owner-guard`.
// NO se ejecutan en la suite (viven fuera de backend/tests y frontend/src). Son el
// oráculo congelado que la implementación de F2b debe satisfacer. Oráculo independiente:
// no importa valores esperados del target.
import { describe, it, expect } from 'vitest';
import { resolve_credential_auth } from '../src/registry.js';

describe('resolve_credential_auth (owner guard)', () => {
  it('mismo dueño resuelve', async () => {
    expect(await resolve_credential_auth('cred-A', 'user-A', false)).toHaveProperty('headers');
  });
  it('ajena lanza', async () => {
    await expect(resolve_credential_auth('cred-B', 'user-A', false)).rejects.toThrow();
  });
  it('admin resuelve cualquiera', async () => {
    expect(await resolve_credential_auth('cred-B', 'user-A', true)).toHaveProperty('headers');
  });
  it('sin id vacío', async () => {
    expect(await resolve_credential_auth('', 'user-A', false)).toEqual({ headers: {}, query: {} });
  });
});
