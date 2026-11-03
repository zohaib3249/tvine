import { migration, ops, field } from 'tvine/migrations'

export default migration({
  dependencies: [],
  operations: [
    ops.createModel('items', {
      id: field.id(),
      name: field.text(),
      price: field.float(),
      category: field.text(),
      created_at: field.datetime({ autoNowAdd: true }),
    }),
  ],
})
