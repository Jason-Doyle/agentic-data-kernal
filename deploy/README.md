# Deployment Templates

These templates deploy the same production workload contract across multiple
platforms:

| Platform | Template | Scope |
| --- | --- | --- |
| Kubernetes | [Helm chart](kubernetes/helm/agentic-data-kernel) | Portable API, worker, bootstrap, migration, service, ingress, and artifact PVC |
| Azure | [Bicep](azure) | Azure Container Apps workloads and manual jobs |
| AWS | [OpenTofu](aws) | ECS Fargate services and one-shot task definitions |
| Google Cloud | [OpenTofu](gcp) | Helm deployment into an existing GKE cluster |

Read [CONTRACT.md](CONTRACT.md) before using any template.

Every template requires an explicit immutable application image version or
digest. No runnable default points at an older release.

The templates intentionally consume existing cloud networks, PostgreSQL
servers, secret stores, and persistent storage. Landing zones and credentials
vary substantially between organizations, and placing generated database or
provider credentials in Bicep parameters or OpenTofu state would create an
unsafe default.

## Support level

The templates are reference deployments for the repository's bounded
single-primary production profile. Static validation runs in CI. Cloud applies
require an account, billable resources, provider-specific policy decisions,
and operator verification.

They do not claim:

- multi-region database failover;
- zero-downtime schema changes;
- automatic secret rotation;
- cloud object-storage support;
- compatibility with filesystems that lack POSIX hard links;
- a complete organizational landing zone.
