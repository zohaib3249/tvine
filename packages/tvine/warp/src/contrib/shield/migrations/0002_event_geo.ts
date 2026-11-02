// tvine.shield 0002 — ships with Tvine: ShieldEvent.continent + local (private / loopback traffic has no country)
import { field, migration, ops } from '../../../data/migrations.js'

export default migration({
  dependencies: [['shield', '0001_initial']],
  operations: [
    ops.addField('shield_event', 'continent', field.text({ optional: true })),
    ops.addField('shield_event', 'local', field.bool({ default: false })),
  ],
})
