'use strict';
// Lab shim: the v2 rules now live in lib/bristles.js (variantKey); variantKeyV1 is the old rule for comparison.
// WORD_TYPES is a grouping rule for consumers (hook types about the word itself, not a name): applied in e1_fold.js.
const B = require('../lib/bristles');
module.exports = { variantKey2: B.variantKey, variantKeyV1: B.variantKeyV1, WORD_TYPES: new Set(['etymon', 'homonym', 'material']) };
