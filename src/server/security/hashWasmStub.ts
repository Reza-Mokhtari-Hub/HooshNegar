/**
 * Cloudflare Workers build-time stub for hash-wasm.
 * On Cloudflare Workers, password hashing automatically uses native C++ `node:crypto` scrypt
 * so zero dynamic WebAssembly compilation occurs inside workerd isolates.
 */

export async function argon2id(): Promise<string> {
  throw new Error('hash-wasm Argon2id is disabled on Cloudflare Workers; native scrypt is used automatically.');
}

export async function argon2Verify(): Promise<boolean> {
  return false;
}
