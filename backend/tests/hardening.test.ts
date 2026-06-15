import { describe, it, expect } from 'vitest';
import { resolveValue } from '../src/nodes.js';
import { isUnsafeKey, cronTooFrequent } from '../src/security.js';

describe('security hardening', () => {
  it('isUnsafeKey flags prototype-pollution keys', () => {
    expect(isUnsafeKey('__proto__')).toBe(true);
    expect(isUnsafeKey('constructor')).toBe(true);
    expect(isUnsafeKey('prototype')).toBe(true);
    expect(isUnsafeKey('name')).toBe(false);
  });

  it('resolveValue does not traverse prototype-pollution paths', () => {
    const context = { Evil: { output: { safe: 'ok' } } } as any;
    // A full expression that traverses __proto__ must resolve to undefined, never the prototype.
    expect(resolveValue('{{ $node.Evil.output.__proto__ }}', context)).toBeUndefined();
    expect(resolveValue('{{ $node.Evil.output.constructor }}', context)).toBeUndefined();
    // In string interpolation the blocked path yields an empty string.
    expect(resolveValue('x={{ $node.Evil.output.__proto__ }}', context)).toBe('x=');
    // Legitimate paths still resolve.
    expect(resolveValue('{{ $node.Evil.output.safe }}', context)).toBe('ok');
  });

  it('cronTooFrequent rejects per-second 6-field schedules', () => {
    expect(cronTooFrequent('* * * * * *')).toBeTruthy();
    expect(cronTooFrequent('*/5 * * * * *')).toBeTruthy();
    // Standard 5-field schedules are allowed.
    expect(cronTooFrequent('* * * * *')).toBeNull();
    expect(cronTooFrequent('*/5 * * * *')).toBeNull();
    // 6-field with a fixed seconds value is allowed (runs once per minute at that second).
    expect(cronTooFrequent('30 * * * * *')).toBeNull();
  });
});
