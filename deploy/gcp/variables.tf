variable "project_id" {
  description = "Google Cloud project containing the existing GKE cluster."
  type        = string
}

variable "location" {
  description = "GKE cluster region or zone."
  type        = string
}

variable "cluster_name" {
  description = "Existing private GKE cluster name."
  type        = string
}

variable "namespace" {
  type    = string
  default = "agentic-data"
}

variable "release_name" {
  type    = string
  default = "agentic-data"
}

variable "image_repository" {
  type    = string
  default = "ghcr.io/jason-doyle/agentic-data-kernel"
}

variable "image_tag" {
  description = "Immutable Agentic Data Kernel release tag."
  type        = string
  default     = ""
}

variable "image_digest" {
  description = "Optional sha256 OCI digest used instead of image_tag."
  type        = string
  default     = ""
}

variable "runtime_kubernetes_secret_name" {
  description = "Existing Secret containing runtime-only keys."
  type        = string
  default     = "agentic-data-runtime"
}

variable "admin_kubernetes_secret_name" {
  description = "Existing Secret containing bootstrap and migration keys."
  type        = string
  default     = "agentic-data-admin"
}

variable "artifact_pvc_name" {
  description = "Existing ReadWriteMany PVC backed by Filestore."
  type        = string
}

variable "service_account_name" {
  description = "Kubernetes service account name."
  type        = string
  default     = "agentic-data"
}

variable "service_account_annotations" {
  description = "Optional Workload Identity annotations."
  type        = map(string)
  default     = {}
}

variable "job_service_account_name" {
  description = "Pre-created Kubernetes service account used by Helm hook Jobs."
  type        = string
  default     = "agentic-data-jobs"
}

variable "gcp_service_account_email" {
  description = "Google service account with roles/cloudsql.client."
  type        = string
}

variable "cloud_sql_instance_connection_name" {
  description = "Cloud SQL connection name in project:region:instance form."
  type        = string
}

variable "database_proxy_image" {
  description = "Immutable Cloud SQL Auth Proxy image."
  type        = string
}

variable "embedding_base_url" {
  type = string
}

variable "embedding_model" {
  type    = string
  default = "text-embedding-3-small"
}

variable "embedding_version" {
  type    = string
  default = "openai-compatible-v1"
}

variable "embedding_dimensions" {
  type    = number
  default = 1536

  validation {
    condition = (
      var.embedding_dimensions >= 1 &&
      var.embedding_dimensions <= 2000
    )
    error_message = "embedding_dimensions must be from 1 through 2000."
  }
}

variable "artifact_current_key_id" {
  description = "Current key ID present in ARTIFACT_KEYRING."
  type        = string
  default     = "v1"
}

variable "effect_allowed_hosts" {
  type    = string
  default = ""
}

variable "api_replica_count" {
  type    = number
  default = 1
}

variable "worker_replica_count" {
  type    = number
  default = 1
}

variable "ingress_enabled" {
  type    = bool
  default = false
}

variable "ingress_class_name" {
  type    = string
  default = ""
}

variable "ingress_host" {
  type    = string
  default = "agentic-data.example.com"
}

variable "ingress_annotations" {
  type    = map(string)
  default = {}
}

variable "ingress_tls_secret_name" {
  type    = string
  default = ""
}
