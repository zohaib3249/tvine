import { defineModel, field } from 'tvine'

export const Item = defineModel('items', {
  id: field.id(),
  name: field.text(),
  price: field.float(),
  category: field.text(),
  created_at: field.datetime({ autoNowAdd: true }),
})
