#!/usr/bin/env node
// npm create tvine@latest my-app  ==  tvine startproject my-app (one generator: @tvine/warp cli/scaffold)
import { main } from '@tvine/warp/cli'

const args = process.argv.slice(2)
if (!args.length || args[0].startsWith('-')) {
  console.error('usage: npm create tvine@latest <name> [dir] [--db sqlite|postgres|mysql] [--no-admin] [--no-tasks] [--pm pnpm|npm|yarn] [--no-install] [--local]')
  process.exit(1)
}
// the package manager that ran us (npm_config_user_agent: "pnpm/9 …"), unless --pm says otherwise
const ua = (process.env.npm_config_user_agent ?? '').split('/')[0]
const pm = !args.includes('--pm') && ['pnpm', 'npm', 'yarn'].includes(ua) ? ['--pm', ua] : []
main(['startproject', ...args, ...pm]).then((code) => { if (code !== undefined) process.exit(code) })
