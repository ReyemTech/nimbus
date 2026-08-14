/**
 * CDN factory — creates CloudFront distributions through a provider-neutral API.
 *
 * @module factories/cdn
 */

import type { ICdn, ICdnConfig } from "../cdn";
import { createAwsCloudFront } from "../aws/index.js";
import { resolveCloudTarget, UnsupportedFeatureError } from "../types";
import type { CloudTarget } from "../types";

/**
 * Create the trusted application CDN.
 *
 * CloudFront is global and AWS-only, so multi-cloud configurations are intentionally rejected.
 *
 * @throws {UnsupportedFeatureError} When the target provider is not AWS.
 */
export function createCdn(name: string, config: ICdnConfig): ICdn {
  if (Array.isArray(config.cloud)) {
    throw new UnsupportedFeatureError("cdn multi-cloud deployment", "multiple providers");
  }

  const target = resolveCloudTarget(config.cloud as CloudTarget);
  if (target.provider !== "aws") {
    throw new UnsupportedFeatureError("cdn", target.provider);
  }

  return createAwsCloudFront(name, config);
}
