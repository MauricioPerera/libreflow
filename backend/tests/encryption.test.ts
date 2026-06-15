import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../src/encryption.js';

describe('Encryption Module', () => {
  it('should encrypt and decrypt a string successfully', () => {
    const secretText = 'my-super-secret-api-key-123456';
    const encrypted = encrypt(secretText);
    
    expect(encrypted).toBeDefined();
    expect(typeof encrypted).toBe('string');
    expect(encrypted.split(':').length).toBe(4); // salt:iv:authTag:encrypted

    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(secretText);
  });

  it('should generate different ciphertexts for the same plaintext (random IV/salt)', () => {
    const text = 'same-plaintext';
    const encrypted1 = encrypt(text);
    const encrypted2 = encrypt(text);

    expect(encrypted1).not.toBe(encrypted2);
    expect(decrypt(encrypted1)).toBe(text);
    expect(decrypt(encrypted2)).toBe(text);
  });

  it('should throw an error if decrypting a tampered ciphertext (integrity check)', () => {
    const text = 'very-sensitive-info';
    const encrypted = encrypt(text);
    
    // Split into parts
    const parts = encrypted.split(':');
    
    // Tamper with the encrypted content part (last part)
    const lastPart = parts[3];
    const tamperedLastPart = lastPart.substring(0, lastPart.length - 2) + (lastPart.endsWith('0') ? '1' : '0');
    parts[3] = tamperedLastPart;
    const tamperedEncrypted = parts.join(':');

    expect(() => decrypt(tamperedEncrypted)).toThrow();
  });

  it('should throw an error for invalid formats', () => {
    expect(() => decrypt('invalidformat')).toThrow('Invalid encrypted text format');
    expect(() => decrypt('one:two:three')).toThrow('Invalid encrypted text format');
  });
});
