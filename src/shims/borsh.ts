// src/shims/borsh.ts
// Import the real library entry (this bypasses the alias because we used an exact-match regex)
import * as realBorsh from 'borsh/lib/index.js';

export const serialize = (realBorsh as any).serialize;
export const deserialize = (realBorsh as any).deserialize;
export const deserializeUnchecked = (realBorsh as any).deserializeUnchecked;
