/**
 * Backward compatibility shim.
 * Forwards all provider requests to the dedicated AI infrastructure layer: `backend/ai/providers`.
 */

module.exports = require('../ai/providers');
