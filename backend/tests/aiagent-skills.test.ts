import { describe, it, expect } from 'vitest';
import { buildSkillsBlock, loadSkillsFromSession } from '../src/mcp.js';

describe('buildSkillsBlock', () => {
  it('formatea las skills con nombre y filtra las vacías', () => {
    const block = buildSkillsBlock([
      { name: 'A', text: 'haz X' },
      { name: 'B', text: '   ' },     // vacía -> se ignora
      { text: 'haz Y' },              // sin nombre
    ]);
    expect(block).toContain('## A');
    expect(block).toContain('haz X');
    expect(block).toContain('haz Y');
    expect(block).not.toContain('## B');
  });

  it('sin skills devuelve cadena vacía', () => {
    expect(buildSkillsBlock([])).toBe('');
    expect(buildSkillsBlock([{ text: '' }])).toBe('');
  });
});

describe('loadSkillsFromSession (recursos MCP -> bloque de contexto)', () => {
  // Sesión MCP falsa que expone dos recursos-skill.
  const fakeSession = {
    listResources: async () => [
      { uri: 'skill://greet', name: 'Saludo' },
      { uri: 'skill://empty', name: 'Vacía' },
    ],
    readResource: async (uri: string) =>
      uri === 'skill://greet'
        ? { contents: [{ text: 'Saluda siempre en catalán.' }] }
        : { contents: [] },
  };

  it('lee los recursos, ignora los vacíos y arma el bloque', async () => {
    const block = await loadSkillsFromSession(fakeSession);
    expect(block).toContain('## Saludo');
    expect(block).toContain('Saluda siempre en catalán');
    expect(block).not.toContain('Vacía'); // recurso sin texto -> fuera
  });

  it('servidor sin recursos -> bloque vacío (no rompe el agente)', async () => {
    const empty = { listResources: async () => [], readResource: async () => null };
    expect(await loadSkillsFromSession(empty)).toBe('');
  });
});
