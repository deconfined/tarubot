# Native type normalization is observable without providers, backend, resources or imports.
output "existing_databases" {
  value     = var.existing_databases
  sensitive = true
}
