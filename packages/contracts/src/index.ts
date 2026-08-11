// First, and a side-effect import rather than a call: zod decides whether to
// JIT-compile a schema when the schema is constructed, and the three modules
// below construct theirs on import. ESM finishes every import in this file
// before running its first statement, so nothing later could be early enough.
import "./jit.js";

export * from "./contract.js";
export * from "./inputs.js";
export * from "./schemas.js";
