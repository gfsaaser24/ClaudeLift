import type { CoworkExporterApi } from '../shared/ipc'

declare global {
  interface Window {
    /** Typed IPC bridge exposed by src/preload/index.ts via contextBridge. */
    api: CoworkExporterApi
  }
}

export {}
