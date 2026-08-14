/**
 * Framework-free trusted-edge verification.
 *
 * @module edge
 */

export type {
  EdgeHeaders,
  EdgeProvider,
  IEdgeHeaderNames,
  IEdgeTrustConfig,
  IEdgeTrustVerdict,
} from "./interfaces";
export {
  EDGE_HEADER_PRESETS,
  parseEdgeClientIp,
  verifyEdgeHeaders,
  type EdgeHeaderPreset,
} from "./verify";
