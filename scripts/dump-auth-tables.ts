/* eslint-disable @typescript-eslint/no-explicit-any */
import { getAuthTables } from 'better-auth/db';
import { getAuth } from '../src/lib/auth';
const a = getAuth();
const t = getAuthTables(a.options);
for (const [k, v] of Object.entries(t)) {
  console.log(k, '->', v.modelName);
  for (const [f, d] of Object.entries(v.fields as unknown as Record<string, Record<string, any>>)) {
    console.log(
      '  ',
      f,
      d.fieldName ?? f,
      d.type,
      d.required === false ? 'opt' : 'req',
      d.unique ? 'unique' : '',
      d.references
        ? 'ref:' +
            d.references.model +
            '.' +
            d.references.field +
            ' ' +
            (d.references.onDelete ?? '')
        : '',
      d.defaultValue !== undefined ? 'default' : '',
      d.index ? 'idx' : '',
    );
  }
}
