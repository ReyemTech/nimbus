/**
 * Cluster-scoped bookkeeping of the role identities a stack has claimed.
 *
 * Every engine nimbus supports keeps login identities at the *server* level, not
 * inside the database: a PostgreSQL role and a MariaDB account both exist once
 * per cluster and are merely granted privileges on individual databases. nimbus'
 * `addRole()` is scoped to a database, so nothing in the shape of the API stops
 * two databases on one cluster from each asking for a role called `reader`.
 *
 * That is not a duplicate resource Pulumi can catch. Each database derives its
 * own Pulumi logical names, so `pulumi preview` sees two unrelated resources and
 * reports no conflict — while on the cluster both reconcile the *same* account
 * against *different* generated password Secrets, rewriting its password against
 * each other forever. At least one database's replicated connection Secrets then
 * holds a credential that no longer authenticates, and nothing in the diff says
 * why.
 *
 * A registry lives for the lifetime of one cluster object and refuses the second
 * claim, so the collision surfaces at preview instead of in production. The
 * alternative — silently renaming the second role, say by prefixing it with the
 * database name — is worse: it would hand back an account that is not the one
 * the caller asked for.
 *
 * @module operator/role-registry
 */

import { AnyCloudError, ERROR_CODES } from "../types/errors.js";

/** Wording a registry uses to describe the scope its identities are global to. */
export interface IRoleRegistryOptions {
  /** Cluster or instance the registry covers, named in the error message. */
  readonly clusterName: string;
  /** What that thing is called for this engine, e.g. `"cluster"`, `"instance"`. */
  readonly scopeNoun: string;
  /** Sentences explaining why identities are scope-global and what a clash breaks. */
  readonly scopeExplanation: string;
}

/** One request to claim a role identity. */
export interface IRoleClaim {
  /**
   * The value two roles must not share.
   *
   * This is the engine's own notion of account identity, which is not always
   * just the name — MariaDB accounts are identified by username *and* host, so
   * two roles named `reader` on genuinely different hosts are distinct accounts
   * and must both be allowed.
   */
  readonly identity: string;
  /** How the identity is rendered in the error message, e.g. `"reader"@"%"`. */
  readonly label: string;
  /** Database whose configuration is making the claim. */
  readonly databaseName: string;
}

/** Records which role identities a cluster has already handed out. */
export interface IRoleRegistry {
  /**
   * Claim an identity for a database, or fail because something else holds it.
   *
   * @param claim - Identity to claim, its display form, and the claiming database
   * @throws {AnyCloudError} code `UNSUPPORTED_ROLE_OPTION` when the identity was
   *   already claimed on this cluster, by any database
   */
  claim(claim: IRoleClaim): void;
}

/**
 * Create an empty registry for one cluster.
 *
 * Callers hold exactly one per cluster and thread it through every database
 * created on it — both the owner created by `createDatabase()` and every role
 * added by `addRole()` must claim, or the guard has a hole.
 *
 * @param options - Cluster name and the engine's wording for scope and consequence
 * @returns A registry with no identities claimed yet
 *
 * @example
 * ```typescript
 * const registry = createRoleRegistry({
 *   clusterName: "pgsql-main",
 *   scopeNoun: "cluster",
 *   scopeExplanation: "PostgreSQL roles are cluster-global.",
 * });
 * registry.claim({ identity: "reader", label: '"reader"', databaseName: "billing" });
 * // Throws: "reader" is already claimed by database "billing".
 * registry.claim({ identity: "reader", label: '"reader"', databaseName: "analytics" });
 * ```
 */
export function createRoleRegistry(options: IRoleRegistryOptions): IRoleRegistry {
  /** identity → the database that claimed it first. */
  const claimedBy = new Map<string, string>();

  return {
    claim({ identity, label, databaseName }: IRoleClaim): void {
      const holder = claimedBy.get(identity);
      if (holder !== undefined) {
        const scope = `${options.scopeNoun} "${options.clusterName}"`;
        const where =
          holder === databaseName
            ? `already claimed by database "${holder}"`
            : `already claimed by database "${holder}" and cannot be claimed again by ` +
              `database "${databaseName}"`;
        throw new AnyCloudError(
          `Role ${label} is ${where} on ${scope}. ${options.scopeExplanation} ` +
            `Give one of them a different name — nimbus will not silently rename it for ` +
            `you, because the role you would get back is not the one you asked for.`,
          ERROR_CODES.UNSUPPORTED_ROLE_OPTION
        );
      }
      claimedBy.set(identity, databaseName);
    },
  };
}
