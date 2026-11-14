'use strict';
// A comparable description of a database's structure: every table with its columns (type, not-null, default, primary key), foreign keys, indexes (columns, unique)
// and triggers, and virtual tables by their definition. Row data is never read. Used to check that "base tables + every migration" builds what the real database has.
function structure(db) {
  const out = { tables: {}, triggers: {}, virtual: {} };
  const objs = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const virtualNames = objs.filter(o => o.type === 'table' && /^CREATE VIRTUAL TABLE/i.test(o.sql || '')).map(o => o.name);
  const shadow = n => virtualNames.some(v => n.startsWith(v + '_'));
  for (const o of objs) {
    if (o.type === 'table' && /^CREATE VIRTUAL TABLE/i.test(o.sql || '')) { out.virtual[o.name] = o.sql.replace(/\s+/g, ' ').trim(); continue; }
    if (o.type === 'table' && !shadow(o.name)) {
      const q = n => '"' + n.replace(/"/g, '""') + '"';
      out.tables[o.name] = {
        columns: db.prepare('PRAGMA table_info(' + q(o.name) + ')').all().map(c => `${c.name} ${String(c.type).toUpperCase()}${c.notnull ? ' NOT NULL' : ''}${c.dflt_value != null ? ' DEFAULT ' + c.dflt_value : ''}${c.pk ? ' PK' + c.pk : ''}`),
        foreignKeys: db.prepare('PRAGMA foreign_key_list(' + q(o.name) + ')').all().map(f => `${f.from} -> ${f.table}(${f.to}) ON DELETE ${f.on_delete}`).sort(),
        indexes: db.prepare('PRAGMA index_list(' + q(o.name) + ')').all().filter(i => i.origin !== 'pk').map(i => `${i.unique ? 'UNIQUE ' : ''}${db.prepare('PRAGMA index_info(' + q(i.name) + ')').all().map(c => c.name).join(',')}`).sort()
      };
    }
    if (o.type === 'trigger') out.triggers[o.name] = (o.sql || '').replace(/\s+/g, ' ').trim();
  }
  return out;
}
module.exports = { structure };
