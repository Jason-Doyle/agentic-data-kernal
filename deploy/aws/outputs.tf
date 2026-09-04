output "api_service_name" {
  value = aws_ecs_service.api.name
}

output "worker_service_name" {
  value = aws_ecs_service.worker.name
}

output "bootstrap_task_definition_arn" {
  value = aws_ecs_task_definition.bootstrap.arn
}

output "migrate_task_definition_arn" {
  value = aws_ecs_task_definition.migrate.arn
}

output "network_configuration_json" {
  description = "Pass this object to aws ecs run-task for bootstrap and migration."
  value       = jsonencode(local.network_configuration)
}
