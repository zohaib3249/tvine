import { defineSettings } from 'tvine'
import { base } from './base.ts'
export default defineSettings({ ...base, debug: false, logging: { level: 'warn' }, session: { secure: false } })
