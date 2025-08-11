// src/shims/borsh.ts
// Make CJS borsh usable with ESM & named imports without circular aliasing.
// We import from a deep path so the /^borsh$/ alias does not match.

// @ts-ignore deep path is intentional
import * as real from 'borsh/lib/index.js'; 

const b: any = (real as any).default ?? real;

export const {
  serialize,
  deserialize,
  deserializeUnchecked,
  BinaryReader,
  BinaryWriter,
} = b;

// So `import borsh from 'borsh'` also works after aliasing:
export default b;
