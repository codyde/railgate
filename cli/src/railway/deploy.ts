import { gql, type GqlOptions } from "./api.js";

/**
 * The railgate template — must match the template registered in Railway.
 *
 * TEMPLATE_ID is what Railway's GraphQL API expects. TEMPLATE_CODE is the
 * short code used in /deploy/<code> URLs for the legacy browser-handoff path.
 */
export const RAILGATE_TEMPLATE_ID = "9b93c7e9-c52a-4b6f-a81d-dbcf873687c9";
export const RAILGATE_TEMPLATE_CODE = "mBm3DX";

interface TemplateDetailResult {
  template: { id: string; serializedConfig: TemplateConfig } | null;
}

interface ProjectCreateResult {
  projectCreate: {
    id: string;
    name: string;
    environments: { edges: Array<{ node: { id: string; name: string } }> };
  };
}

interface TemplateDeployResult {
  templateDeployV2: { projectId: string; workflowId: string | null };
}

interface WorkflowStatusResult {
  workflowStatus: {
    status: "Complete" | "Error" | "NotFound" | "Running";
    error: string | null;
  };
}

interface ProjectServicesResult {
  project: {
    services: { edges: Array<{ node: { id: string; name: string } }> };
  };
}

interface DomainsResult {
  domains: { serviceDomains: Array<{ domain: string }> };
}

interface TemplateConfig {
  services?: Record<
    string,
    {
      variables?: Record<string, { value?: string; [k: string]: unknown }>;
      [k: string]: unknown;
    }
  >;
  [k: string]: unknown;
}

export interface DeployedRelay {
  projectId: string;
  environmentId: string;
  serviceId: string;
  baseDomain: string;
  httpUrl: string;
  wsUrl: string;
}

export interface DeployProgress {
  /** Called whenever the high-level phase changes (for spinner text updates). */
  onPhase?: (msg: string) => void;
  /** Forwarded to OAuth login when a fresh token is needed. */
  onPromptUrl?: (url: string) => void;
}

/**
 * Run the full provisioning flow: create a project, deploy the railgate
 * template into it, poll the build workflow, and discover the resulting
 * public domain.
 */
export async function deployRailgateRelay(
  relayToken: string,
  projectName: string,
  progress: DeployProgress = {}
): Promise<DeployedRelay> {
  const gqlOpts: GqlOptions = { onPromptUrl: progress.onPromptUrl };

  progress.onPhase?.("Fetching template config");
  const { template } = await gql<TemplateDetailResult>(
    `query ($id: String!) { template(id: $id) { id serializedConfig } }`,
    { id: RAILGATE_TEMPLATE_ID },
    gqlOpts
  );
  if (!template) {
    throw new Error(
      "Railgate template not accessible from this Railway account — make sure the template is published or that you have access."
    );
  }
  const config = injectVariables(template.serializedConfig, {
    RAILGATE_TOKEN: relayToken,
  });

  progress.onPhase?.("Creating Railway project");
  const { projectCreate } = await gql<ProjectCreateResult>(
    `mutation ($input: ProjectCreateInput!) {
      projectCreate(input: $input) {
        id
        name
        environments { edges { node { id name } } }
      }
    }`,
    { input: { name: projectName } },
    gqlOpts
  );
  const productionEnv =
    projectCreate.environments.edges.find((e) => e.node.name === "production")
      ?.node ?? projectCreate.environments.edges[0]?.node;
  if (!productionEnv) {
    throw new Error("Created project has no environments");
  }

  progress.onPhase?.("Deploying relay");
  const { templateDeployV2 } = await gql<TemplateDeployResult>(
    `mutation (
      $projectId: String!
      $environmentId: String!
      $templateId: String!
      $serializedConfig: SerializedTemplateConfig!
    ) {
      templateDeployV2(input: {
        projectId: $projectId
        environmentId: $environmentId
        templateId: $templateId
        serializedConfig: $serializedConfig
      }) { projectId workflowId }
    }`,
    {
      projectId: projectCreate.id,
      environmentId: productionEnv.id,
      templateId: RAILGATE_TEMPLATE_ID,
      serializedConfig: config,
    },
    gqlOpts
  );

  if (templateDeployV2.workflowId) {
    progress.onPhase?.("Waiting for build to finish (up to 2 minutes)");
    await waitForWorkflow(templateDeployV2.workflowId, gqlOpts);
  }

  progress.onPhase?.("Discovering service domain");
  const { project } = await gql<ProjectServicesResult>(
    `query ($id: String!) {
      project(id: $id) {
        services { edges { node { id name } } }
      }
    }`,
    { id: projectCreate.id },
    gqlOpts
  );
  const service = project.services.edges[0]?.node;
  if (!service) {
    throw new Error("Deploy reported success but the project has no services");
  }

  const baseDomain = await pollForDomain(
    projectCreate.id,
    productionEnv.id,
    service.id,
    gqlOpts
  );

  return {
    projectId: projectCreate.id,
    environmentId: productionEnv.id,
    serviceId: service.id,
    baseDomain,
    httpUrl: `https://${baseDomain}`,
    wsUrl: `wss://${baseDomain}`,
  };
}

/**
 * Poll `workflowStatus` until the workflow reports Complete, Error, or NotFound.
 * Mirrors the cadence Railway's own CLI uses (120 × ~1.5s = ~3min ceiling).
 */
async function waitForWorkflow(
  workflowId: string,
  opts: GqlOptions
): Promise<void> {
  const maxAttempts = 120;
  const delayMs = 1500;
  for (let i = 0; i < maxAttempts; i++) {
    const { workflowStatus } = await gql<WorkflowStatusResult>(
      `query ($workflowId: String!) {
        workflowStatus(workflowId: $workflowId) { status error }
      }`,
      { workflowId },
      opts
    );
    switch (workflowStatus.status) {
      case "Complete":
        return;
      case "Error":
        throw new Error(workflowStatus.error || "Template deploy failed");
      case "NotFound":
        throw new Error("Deploy workflow not found — Railway may have lost track");
      case "Running":
        await new Promise((r) => setTimeout(r, delayMs));
        break;
    }
  }
  throw new Error("Timed out waiting for deploy to finish");
}

/**
 * Domain provisioning can lag a few seconds behind workflow completion.
 * Poll until one shows up or we hit the cap.
 */
async function pollForDomain(
  projectId: string,
  environmentId: string,
  serviceId: string,
  opts: GqlOptions
): Promise<string> {
  const maxAttempts = 30;
  const delayMs = 1500;
  for (let i = 0; i < maxAttempts; i++) {
    const { domains } = await gql<DomainsResult>(
      `query ($projectId: String!, $environmentId: String!, $serviceId: String!) {
        domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
          serviceDomains { domain }
        }
      }`,
      { projectId, environmentId, serviceId },
      opts
    );
    const domain = domains.serviceDomains[0]?.domain;
    if (domain) return domain;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("Service domain didn't appear after deploy");
}

/**
 * Walk the template's services and fill in variable values from the supplied
 * map. Deep-clones to avoid mutating the input config.
 */
function injectVariables(
  config: TemplateConfig,
  vars: Record<string, string>
): TemplateConfig {
  const clone = JSON.parse(JSON.stringify(config)) as TemplateConfig;
  for (const svcId of Object.keys(clone.services ?? {})) {
    const svc = clone.services![svcId];
    for (const key of Object.keys(svc.variables ?? {})) {
      if (vars[key] !== undefined) {
        svc.variables![key].value = vars[key];
      }
    }
  }
  return clone;
}
