import { gql, type GqlOptions } from "./api.js";

/**
 * Custom-domain operations against Railway's backboard.
 *
 * Note: `customDomainAvailable` is intentionally NOT used here — that query is
 * gated behind session auth (it never opts into OAuth scopes, so OAuth tokens
 * get "Not Authorized"). We attempt the create directly and translate the
 * server's error messages instead.
 */

export interface DnsRecord {
  hostlabel: string;
  fqdn: string;
  recordType: string;
  requiredValue: string;
  currentValue: string;
  status: string;
  zone: string;
  purpose: string;
}

export interface CustomDomainStatus {
  dnsRecords: DnsRecord[];
  certificateStatus: string;
  verified: boolean;
  verificationToken: string | null;
  verificationDnsHost: string | null;
}

export interface CustomDomainInfo {
  id: string;
  domain: string;
  status: CustomDomainStatus;
}

const STATUS_FIELDS = `
  status {
    dnsRecords {
      hostlabel
      fqdn
      recordType
      requiredValue
      currentValue
      status
      zone
      purpose
    }
    certificateStatus
    verified
    verificationToken
    verificationDnsHost
  }
`;

export const DNS_RECORD_PROPAGATED = "DNS_RECORD_STATUS_PROPAGATED";
export const CERT_VALID = "CERTIFICATE_STATUS_TYPE_VALID";
export const CERT_ISSUE_FAILED = "CERTIFICATE_STATUS_TYPE_ISSUE_FAILED";

export async function createCustomDomain(
  input: {
    domain: string;
    projectId: string;
    environmentId: string;
    serviceId: string;
    targetPort: number;
  },
  opts: GqlOptions = {}
): Promise<CustomDomainInfo> {
  const { customDomainCreate } = await gql<{
    customDomainCreate: CustomDomainInfo;
  }>(
    `mutation ($input: CustomDomainCreateInput!) {
      customDomainCreate(input: $input) {
        id
        domain
        ${STATUS_FIELDS}
      }
    }`,
    { input },
    opts
  );
  return customDomainCreate;
}

export async function getCustomDomain(
  args: { id: string; projectId: string },
  opts: GqlOptions = {}
): Promise<CustomDomainInfo> {
  const { customDomain } = await gql<{ customDomain: CustomDomainInfo }>(
    `query ($id: String!, $projectId: String!) {
      customDomain(id: $id, projectId: $projectId) {
        id
        domain
        ${STATUS_FIELDS}
      }
    }`,
    args,
    opts
  );
  return customDomain;
}

export async function deleteCustomDomain(
  id: string,
  opts: GqlOptions = {}
): Promise<void> {
  await gql<{ customDomainDelete: boolean }>(
    `mutation ($id: String!) { customDomainDelete(id: $id) }`,
    { id },
    opts
  );
}

/**
 * Upsert service variables without triggering Railway's automatic redeploy —
 * callers redeploy explicitly so the timing is deterministic.
 */
export async function upsertVariables(
  args: {
    projectId: string;
    environmentId: string;
    serviceId: string;
    variables: Record<string, string>;
  },
  opts: GqlOptions = {}
): Promise<void> {
  await gql<{ variableCollectionUpsert: boolean }>(
    `mutation ($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }`,
    { input: { ...args, skipDeploys: true } },
    opts
  );
}

export async function deleteVariable(
  args: {
    projectId: string;
    environmentId: string;
    serviceId: string;
    name: string;
  },
  opts: GqlOptions = {}
): Promise<void> {
  await gql<{ variableDelete: boolean }>(
    `mutation ($input: VariableDeleteInput!) { variableDelete(input: $input) }`,
    { input: args },
    opts
  );
}

export async function redeployService(
  args: { serviceId: string; environmentId: string },
  opts: GqlOptions = {}
): Promise<void> {
  await gql<{ serviceInstanceRedeploy: boolean }>(
    `mutation ($serviceId: String!, $environmentId: String!) {
      serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
    }`,
    args,
    opts
  );
}
