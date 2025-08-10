// src/shims/borsh.ts
// Bridge CommonJS borsh -> ESM named exports for Rollup/Vite builds.

import * as borsh from 'borsh';

export const serialize = (borsh as any).serialize;
export const deserialize = (borsh as any).deserialize;
export const deserializeUnchecked = (borsh as any).deserializeUnchecked;
