import { defineSettings } from 'tvine'
import { base } from './base.ts'
export default defineSettings({ ...base, debug: true, allowedHosts: ['localhost', '127.0.0.1'] })
