# Utilities

Helper functions for CIDR management, cross-cloud validation, tags, and error handling.

## CIDR Utilities

```typescript
import { parseCidr, cidrsOverlap, buildCidrMap, autoOffsetCidrs } from "@reyemtech/nimbus";

// Parse CIDR to numeric range
parseCidr("10.0.0.0/16"); // { network, prefix, size, start, end }

// Check overlap
cidrsOverlap("10.0.0.0/16", "10.0.5.0/24"); // true

// Auto-generate non-overlapping CIDRs
autoOffsetCidrs(3); // ["10.0.0.0/16", "10.1.0.0/16", "10.2.0.0/16"]

// Build a cloud-to-CIDR map with conflict detection
buildCidrMap(["aws", "azure"], { aws: "10.0.0.0/16" });
// => { aws: "10.0.0.0/16", azure: "10.1.0.0/16" }
```

## Cross-Cloud Validation

```typescript
import { validateMultiCloud, validateResourceName, isFeatureSupported } from "@reyemtech/nimbus";

// Validate multi-cloud config (checks duplicates + naming)
validateMultiCloud(
  [
    { provider: "aws", region: "us-east-1" },
    { provider: "azure", region: "canadacentral" },
  ],
  "my-cluster"
); // { valid: true, errors: [], warnings: [] }

// Check feature availability
isFeatureSupported("fck-nat", "aws"); // true
isFeatureSupported("fck-nat", "azure"); // false

// Validate resource names per provider
validateResourceName("MyCluster", "gcp"); // warns about uppercase
```

## Tags

```typescript
import { normalizeTags, mergeWithRequiredTags } from "@reyemtech/nimbus";

// GCP label normalization (lowercase, no special chars, max 63)
normalizeTags({ "Cost Center": "R&D" }, "gcp"); // { "cost-center": "r-d" }

// Merge required tags (environment, client, costCenter, managedBy)
mergeWithRequiredTags(
  { environment: "prod", client: "acme", costCenter: "eng" },
  { custom: "value" }
); // { environment: "prod", client: "acme", costCenter: "eng", managedBy: "nimbus", custom: "value" }
```

## Error Handling

All errors extend `AnyCloudError` with typed error codes:

| Error                     | Code                                | When                              |
| ------------------------- | ----------------------------------- | --------------------------------- |
| `CloudValidationError`    | `CLOUD_VALIDATION`                  | Invalid provider or target        |
| `CidrError`               | `CIDR_OVERLAP` / `CIDR_INVALID`     | CIDR conflicts or malformed       |
| `UnsupportedFeatureError` | `UNSUPPORTED_FEATURE`               | Feature not available on provider |
| `ConfigError`             | `CONFIG_MISSING` / `CONFIG_INVALID` | Missing or invalid configuration  |

Missing provider SDKs produce a clear error with install instructions:

```
Cloud provider "aws" requires: @pulumi/aws
Run: npm install @pulumi/aws
Or:  npx @reyemtech/nimbus install aws
```
