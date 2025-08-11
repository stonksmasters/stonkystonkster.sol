// Make borsh's CommonJS exports look like named ESM exports for web3.js.

// IMPORTANT: deep-import the real file so our alias (to "borsh") doesn't loop.
// @ts-ignore deep path is intentional and works with borsh@0.7.x
import * as b from 'borsh/lib/index.js';

export const {
  serialize,
  deserialize,
  deserializeUnchecked,
  BinaryReader,
  BinaryWriter,
} = b as any;

export default b as any;
