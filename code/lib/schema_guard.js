'use strict';
// Read-only check that the tables a step writes to already exist. A step never creates or alters tables itself: the migrations (code/migrate.js) are the only
// thing that changes the schema, so a missing table means "the database has not been created or updated", and the step stops and says so instead of quietly
// building it (which would hide the problem from the integrity check).
function needTables(db, names) {
  const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
  const missing = names.filter(n => !have.has(n));
  if (missing.length) throw new Error('Missing table' + (missing.length > 1 ? 's' : '') + ': ' + missing.join(', ') + '. Run "Create or update the database" (Admin, or: node code/migrate.js --run) first. Nothing was changed.');
}
module.exports = { needTables };
