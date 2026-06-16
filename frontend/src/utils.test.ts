import { describe, it, expect, vi } from 'vitest';
import { statusLabel, formatFullDate, setNestedValue, parseJsonColumns, coerceRowByColumns } from './utils';

describe('statusLabel', () => {
  it('traduce los estados conocidos y deja pasar los desconocidos', () => {
    expect(statusLabel('success')).toBe('Éxito');
    expect(statusLabel('failed')).toBe('Fallo');
    expect(statusLabel('running')).toBe('En curso');
    expect(statusLabel('waiting')).toBe('En espera');
    expect(statusLabel('otro')).toBe('otro');
  });
});

describe('formatFullDate', () => {
  it('formatea una fecha válida e ignora una inválida', () => {
    expect(formatFullDate('2026-06-16T10:00:00Z')).toMatch(/\d/);
    expect(formatFullDate('no-es-fecha')).toBe('no-es-fecha');
  });
});

describe('setNestedValue', () => {
  it('escribe en rutas anidadas creando intermedios', () => {
    const obj: any = {};
    setNestedValue(obj, 'a.b.c', 7);
    expect(obj.a.b.c).toBe(7);
  });

  it('crea arrays cuando el siguiente segmento es numérico', () => {
    const obj: any = {};
    setNestedValue(obj, 'list.0', 'x');
    expect(Array.isArray(obj.list)).toBe(true);
    expect(obj.list[0]).toBe('x');
  });

  it('bloquea rutas con claves peligrosas (prototype pollution)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const obj: any = {};
    setNestedValue(obj, '__proto__.polluted', true);
    expect(({} as any).polluted).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('parseJsonColumns', () => {
  it('parsea JSON string, pasa arrays y degrada a []', () => {
    expect(parseJsonColumns('[{"name":"a"}]')).toEqual([{ name: 'a' }]);
    expect(parseJsonColumns([{ name: 'b' }])).toEqual([{ name: 'b' }]);
    expect(parseJsonColumns('{malformado')).toEqual([]);
    expect(parseJsonColumns(null)).toEqual([]);
  });
});

describe('coerceRowByColumns', () => {
  it('convierte number y boolean según las columnas', () => {
    const out = coerceRowByColumns(
      { n: '42', activo: 'true', nombre: 'Ada', vacio: '' },
      [{ name: 'n', type: 'number' }, { name: 'activo', type: 'boolean' }, { name: 'vacio', type: 'number' }],
    );
    expect(out.n).toBe(42);
    expect(out.activo).toBe(true);
    expect(out.vacio).toBeNull();
    expect(out.nombre).toBe('Ada'); // sin columna → intacto
  });
});
