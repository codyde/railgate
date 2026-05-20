/**
 * Embedded copy of the railgate template's serializedConfig.
 *
 * Why embedded vs fetched at runtime: the singular `template(id|code)`
 * resolver on Railway's backboard is gated by the OAuthDenyPlugin and not
 * opted in via `hasOAuthScopes`, so OAuth tokens get "Not Authorized" when
 * trying to fetch it. `templateDeployV2` itself accepts OAuth + an arbitrary
 * serializedConfig payload, so we ship the config in the package and skip
 * the fetch entirely.
 *
 * How to refresh this file (run from a machine with `railway` CLI logged in
 * as the template owner):
 *
 *   scripts/railway-api.sh 'query ($id: String!) {
 *     workspaceTemplates(workspaceId: $id, first: 50) {
 *       edges { node { id code serializedConfig } }
 *     }
 *   }' '{"id":"<your-workspace-id>"}' \
 *     | jq '.data.workspaceTemplates.edges[]
 *         | select(.node.code == "mBm3DX") | .node.serializedConfig'
 *
 * Paste the result as RAILGATE_TEMPLATE_CONFIG below and bump the
 * cli package version before publishing.
 */
export const RAILGATE_TEMPLATE_CONFIG = {
  buckets: {},
  services: {
    "9d2d3178-1234-4138-908f-7ecf36e50d31": {
      icon: null,
      name: "@railgate/relay",
      deploy: {
        startCommand: null,
        healthcheckPath: "/",
        restartPolicyType: "ON_FAILURE",
        restartPolicyMaxRetries: 10,
      },
      source: {
        repo: "https://github.com/codyde/railgate",
        rootDirectory: null,
      },
      variables: {
        RAILGATE_TOKEN: {
          isOptional: false,
        },
      },
      networking: {
        serviceDomains: {
          "<hasDomain>:8080": {
            port: 8080,
          },
        },
      },
    },
  },
} as const;
