/** Build the protected, region-qualified tag map for AWS cluster resources. */
export function createAwsClusterTags(
  region: string,
  clusterName: string,
  userTags?: Readonly<Record<string, string>>
): Record<string, string> {
  return {
    ...userTags,
    "nimbus:cluster": `${region}/${clusterName}`,
  };
}
