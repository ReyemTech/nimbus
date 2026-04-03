/**
 * Tailscale split DNS automation via the Tailscale API.
 *
 * Configures split DNS nameservers on the tailnet so that
 * queries for <prefix>.<tld> are routed to the in-cluster CoreDNS.
 *
 * Uses PATCH /api/v2/tailnet/{tailnet}/dns/split-dns which merges
 * with existing config (does not replace).
 *
 * @module access/tailscale-dns
 */

import * as pulumi from "@pulumi/pulumi";

interface TailscaleSplitDnsInputs {
  oauthClientId: string;
  oauthClientSecret: string;
  domain: string;
  nameservers: string[];
  tailnet?: string;
}

/**
 * Get an OAuth access token from Tailscale.
 */
async function getOAuthToken(clientId: string, clientSecret: string): Promise<string> {
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://api.tailscale.com/api/v2/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${auth}`,
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    throw new Error(`OAuth token request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return (data as { access_token: string }).access_token;
}

/**
 * PATCH split DNS config on the tailnet.
 */
async function patchSplitDns(
  token: string,
  tailnet: string,
  domain: string,
  nameservers: string[]
): Promise<void> {
  const res = await fetch(`https://api.tailscale.com/api/v2/tailnet/${tailnet}/dns/split-dns`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ [domain]: nameservers }),
  });
  if (!res.ok) {
    throw new Error(`Split DNS PATCH failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Delete a split DNS domain from the tailnet.
 */
async function deleteSplitDns(token: string, tailnet: string, domain: string): Promise<void> {
  await patchSplitDns(token, tailnet, domain, []);
}

/**
 * Pulumi dynamic resource provider for Tailscale split DNS.
 */
const tailscaleSplitDnsProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: TailscaleSplitDnsInputs) {
    const tailnet = inputs.tailnet ?? "-";
    const token = await getOAuthToken(inputs.oauthClientId, inputs.oauthClientSecret);
    await patchSplitDns(token, tailnet, inputs.domain, inputs.nameservers);
    return {
      id: `tailscale-split-dns-${inputs.domain}`,
      outs: inputs,
    };
  },

  async update(_id: string, olds: TailscaleSplitDnsInputs, news: TailscaleSplitDnsInputs) {
    const tailnet = news.tailnet ?? "-";
    const token = await getOAuthToken(news.oauthClientId, news.oauthClientSecret);

    // If domain changed, remove old entry
    if (olds.domain !== news.domain) {
      await deleteSplitDns(token, tailnet, olds.domain);
    }

    await patchSplitDns(token, tailnet, news.domain, news.nameservers);
    return { outs: news };
  },

  async delete(_id: string, props: TailscaleSplitDnsInputs) {
    const tailnet = props.tailnet ?? "-";
    const token = await getOAuthToken(props.oauthClientId, props.oauthClientSecret);
    await deleteSplitDns(token, tailnet, props.domain);
  },
};

/**
 * Configure Tailscale split DNS to route a domain to specific nameservers.
 *
 * Uses the Tailscale API to PATCH the tailnet's split DNS config.
 * This is a Pulumi dynamic resource — it creates/updates/deletes automatically.
 */
export class TailscaleSplitDns extends pulumi.dynamic.Resource {
  constructor(
    name: string,
    args: {
      oauthClientId: pulumi.Input<string>;
      oauthClientSecret: pulumi.Input<string>;
      domain: pulumi.Input<string>;
      nameservers: pulumi.Input<pulumi.Input<string>[]>;
      tailnet?: pulumi.Input<string>;
    },
    opts?: pulumi.CustomResourceOptions
  ) {
    super(tailscaleSplitDnsProvider, name, args, opts);
  }
}
