import { loadLocal, saveLocal } from './api'

// which look this device uses: the dark ledger (default) or the retro windows; ?design= wins, for previews
export type Design = 'ledger' | 'retro'
export const design: Design = (new URLSearchParams(location.search).get('design') ?? loadLocal('design', 'ledger')) === 'retro' ? 'retro' : 'ledger'

export function setDesign(d: Design) {
  saveLocal('design', d)
  location.href = '/'
}
