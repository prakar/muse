// What the active pack gives this Muse: shapes (lenses) and capabilities such as wordplay. main.mjs sets it from /api/meta once; until then, and in tests,
// everything is on, so no screen is hidden by accident. A screen a pack does not supply is left out, not shown empty.
const info = { lenses: true, capabilities: ['wordplay'] };
export const setPackInfo = (p) => { if (p && typeof p === 'object') { info.lenses = !!p.lenses; info.capabilities = Array.isArray(p.capabilities) ? p.capabilities.slice() : []; } };
export const hasLenses = () => info.lenses;
export const can = (capability) => info.capabilities.includes(capability);
