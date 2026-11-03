import { z } from 'zod'
import { byDb, Field } from './base.js'
import type { Dialect } from '../sql/dialect.js'

// file / image fields: the column holds the storage key (`avatars/abc.png`) that
// defineUpload({ uploadTo }) returned; the file itself lives in settings.media storage.
const key = () => z.string().max(512)
const type = (d: Dialect) => [byDb(d, { sqlite: 'TEXT', postgres: 'TEXT', mysql: 'VARCHAR(512)' })]

export class FileField extends Field<string, boolean, 'file', boolean> {
  readonly kind = 'file' as const
  dbType(d: Dialect) { return type(d) }
  zod() { return key() }
}

export class ImageField extends Field<string, boolean, 'image', boolean> {
  readonly kind = 'image' as const
  dbType(d: Dialect) { return type(d) }
  zod() { return key() }
}
