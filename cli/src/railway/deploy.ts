import { gql, HttpError, type GqlOptions } from "./api.js";
import { RAILGATE_TEMPLATE_CONFIG } from "./template-config.js";

/**
 * The railgate template — must match the template registered in Railway.
 *
 * TEMPLATE_ID is what Railway's GraphQL API expects. TEMPLATE_CODE is the
 * short code used in /deploy/<code> URLs for the legacy browser-handoff path.
 */
export const RAILGATE_TEMPLATE_ID = "9b93c7e9-c52a-4b6f-a81d-dbcf873687c9";
export const RAILGATE_TEMPLATE_CODE = "mBm3DX";

interface MeResult {
  me: {
    id: string;
    workspaces: Array<{ id: string; name: string }>;
  };
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

interface VolumeCreateResult {
  volumeCreate: { id: string; name: string };
}

/** Must match RAILGATE_DATA_DIR in relay/Dockerfile. */
const HISTORY_VOLUME_MOUNT_PATH = "/data";

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
  /** Forwarded to OAuth login as a fallback when the browser can't be opened. */
  onPromptUrl?: (url: string) => void;
  /** The browser was launched and we're awaiting Railway authorization. */
  onBrowserOpened?: () => void;
  /** Railway authorization completed successfully. */
  onAuthenticated?: () => void;
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
  const gqlOpts: GqlOptions = {
    onPromptUrl: progress.onPromptUrl,
    onBrowserOpened: progress.onBrowserOpened,
    onAuthenticated: progress.onAuthenticated,
  };

  // The serializedConfig is embedded (see template-config.ts for why) so we
  // skip the runtime template fetch entirely.
  const config = injectVariables(RAILGATE_TEMPLATE_CONFIG as TemplateConfig, {
    RAILGATE_TOKEN: relayToken,
  });

  progress.onPhase?.("Looking up your Railway workspace");
  const { me } = await gql<MeResult>(
    `query { me { id workspaces { id name } } }`,
    {},
    gqlOpts
  );
  const workspaceId = me.workspaces[0]?.id;
  if (!workspaceId) {
    throw new Error(
      "Your Railway account doesn't appear to belong to any workspace. Create one at https://railway.com first."
    );
  }

  progress.onPhase?.("Creating Railway project");
  const { projectCreate } = await gql<ProjectCreateResult>(
    `mutation ($input: ProjectCreateInput!) {
      projectCreate(input: $input) {
        id
        name
        environments { edges { node { id name } } }
      }
    }`,
    { input: { name: projectName, workspaceId } },
    gqlOpts
  );
  const productionEnv =
    projectCreate.environments.edges.find((e) => e.node.name === "production")
      ?.node ?? projectCreate.environments.edges[0]?.node;
  if (!productionEnv) {
    throw new Error("Created project has no environments");
  }

  // From here on a created project exists — if anything fails, tell the user
  // where it lives so it doesn't linger as an invisible orphan.
  try {
    progress.onPhase?.("Deploying relay");
    const workflowId = await deployTemplate(
      projectCreate.id,
      productionEnv.id,
      config,
      progress,
      gqlOpts
    );

    if (workflowId) {
      progress.onPhase?.("Waiting for build to finish (up to 2 minutes)");
      try {
        await waitForWorkflow(workflowId, gqlOpts);
      } catch {
        // Railway intermittently returns "Not Authorized"/transient errors for
        // workflowStatus on a freshly-created project even though the deploy is
        // proceeding fine. The service and domain appearing are the real
        // success signal, so fall through to polling for those instead of
        // aborting the whole setup.
        progress.onPhase?.(
          "Couldn't read build status — waiting for the service to come up"
        );
      }
    }

    progress.onPhase?.("Discovering service domain");
    const service = await pollForService(projectCreate.id, gqlOpts);

    progress.onPhase?.("Attaching tunnel history volume");
    await createVolume(
      projectCreate.id,
      productionEnv.id,
      service.id,
      progress,
      gqlOpts
    );

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
  } catch (err) {
    const e = err as Error;
    e.message +=
      `\n\nThe Railway project "${projectCreate.name}" was created before this failed.` +
      `\nDelete it (or re-run setup, which creates a fresh project):` +
      `\nhttps://railway.com/project/${projectCreate.id}`;
    throw e;
  }
}

/**
 * Run templateDeployV2, recovering from gateway timeouts. The mutation only
 * enqueues a deploy workflow server-side, so a 504 doesn't mean it failed —
 * the workflow may be running even though we never got the response. Before
 * retrying (which would deploy the template a second time into the same
 * project), poll briefly for services appearing in the project.
 */
async function deployTemplate(
  projectId: string,
  environmentId: string,
  config: TemplateConfig,
  progress: DeployProgress,
  opts: GqlOptions
): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    try {
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
          projectId,
          environmentId,
          templateId: RAILGATE_TEMPLATE_ID,
          serializedConfig: config,
        },
        opts
      );
      return templateDeployV2.workflowId;
    } catch (err) {
      if (!(err instanceof HttpError) || !err.transient || attempt >= 2) {
        throw err;
      }
      // Did the deploy actually start despite the timeout? Services appearing
      // in the project means yes — continue without a workflowId (the domain
      // poll below has its own wait).
      progress.onPhase?.("Railway timed out — checking if the deploy started anyway");
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const services = await listServices(projectId, opts);
        if (services.length > 0) return null;
      }
      progress.onPhase?.("Deploy never started — retrying");
    }
  }
}

async function listServices(
  projectId: string,
  opts: GqlOptions
): Promise<Array<{ id: string; name: string }>> {
  const { project } = await gql<ProjectServicesResult>(
    `query ($id: String!) {
      project(id: $id) {
        services { edges { node { id name } } }
      }
    }`,
    { id: projectId },
    opts
  );
  return project.services.edges.map((e) => e.node);
}

/**
 * Attach a persistent volume so the relay's tunnel history survives restarts
 * and deploys. Best-effort: if the volume can't be created the relay still
 * runs, just with in-memory history, so a failure here must not abort setup.
 */
async function createVolume(
  projectId: string,
  environmentId: string,
  serviceId: string,
  progress: DeployProgress,
  opts: GqlOptions
): Promise<void> {
  try {
    await gql<VolumeCreateResult>(
      `mutation ($input: VolumeCreateInput!) {
        volumeCreate(input: $input) { id name }
      }`,
      {
        input: {
          projectId,
          environmentId,
          serviceId,
          mountPath: HISTORY_VOLUME_MOUNT_PATH,
        },
      },
      opts
    );
  } catch {
    progress.onPhase?.(
      "Couldn't attach the history volume — the relay will use in-memory history"
    );
  }
}

/**
 * The service can lag a few seconds behind the deploy workflow (and we may
 * reach here without having confirmed the workflow at all). Poll until one
 * shows up rather than failing on a single empty read.
 */
async function pollForService(
  projectId: string,
  opts: GqlOptions
): Promise<{ id: string; name: string }> {
  const maxAttempts = 120; // ~3min
  const delayMs = 1500;
  for (let i = 0; i < maxAttempts; i++) {
    const service = (await listServices(projectId, opts))[0];
    if (service) return service;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("Deploy reported success but the project has no services");
}

/**
 * Poll `workflowStatus` until the workflow reports Complete, Error, or NotFound.
 * Railway builds (npm install + tsc + Docker) can run long, so allow ~8min.
 */
async function waitForWorkflow(
  workflowId: string,
  opts: GqlOptions
): Promise<void> {
  const maxAttempts = 320;
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
  const maxAttempts = 120; // ~3min
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
