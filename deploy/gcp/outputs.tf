output "release_name" {
  value = helm_release.agentic_data_kernel.name
}

output "namespace" {
  value = helm_release.agentic_data_kernel.namespace
}

output "cluster_endpoint" {
  value     = data.google_container_cluster.target.endpoint
  sensitive = true
}
