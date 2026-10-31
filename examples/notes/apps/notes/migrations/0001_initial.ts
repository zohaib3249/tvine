import { migration, ops, field } from 'tvine/migrations'

export default migration({
  dependencies: [],
  operations: [
    ops.createModel('note', {
      id: field.id(),
      title: field.text({ searchable: true }),
      body: field.text({ default: '' }),
      pinned: field.bool({ default: false }),
      words: field.int({ default: 0 }),
    }),
  ],
})
