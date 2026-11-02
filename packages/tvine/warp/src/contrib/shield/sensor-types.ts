// Copy of the contract's SensorReport (docs/design/contrib/shield.md). Coordinator: replace with a
// re-export from ./types.js once the engine's types.ts lands.
export interface SensorReport {
  webdriver: boolean; headless: string[]; webgl?: string; canvas?: string; audio?: string
  screen: string; tz: string; langs: string[]; touch: number; cores?: number; plugins: number
  behaviour: { moves: number; entropy: number; scrolls: number; keys: number; dwellMs: number }
}
