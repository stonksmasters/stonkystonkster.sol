// src/polyfills.ts
import { Buffer } from 'buffer'

declare global {
  interface Window { Buffer?: any }
}

if (!window.Buffer) {
  window.Buffer = Buffer
}
