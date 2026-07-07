import type { SwitchboardApi } from '../../preload/index'

declare global {
  interface Window {
    switchboard: SwitchboardApi
  }
}

export {}
