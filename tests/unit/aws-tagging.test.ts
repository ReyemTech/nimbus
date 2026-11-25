import { describe, expect, it } from "vitest";
import { createAwsClusterTags } from "../../src/aws/tagging";

describe("createAwsClusterTags", () => {
  it("preserves caller tags and sets a protected region-qualified cluster tag", () => {
    expect(
      createAwsClusterTags("ca-central-1", "reyemtech-public", {
        environment: "production",
        "nimbus:cluster": "caller-value",
      })
    ).toEqual({
      environment: "production",
      "nimbus:cluster": "ca-central-1/reyemtech-public",
    });
  });
});
