# Exercise the module's actual shared variable declarations without backend/provider/import blocks.
# The fixture symlinks variables.tf; it never copies or reimplements its validation rules.
# Mock providers lack ImportResourceState, so existing-cluster imports stay in full-plan stand-ins.
variables {
  state_passphrase   = "tofu-test-only-throwaway-passphrase"
  hosts              = {}
  database_ids       = {}
  existing_databases = {}
}

run "recorded_settings_keep_only_explicit_overrides" {
  command = plan
  module {
    source = "./tests/fixtures/database-adoption-validation"
  }
  variables {
    database_ids = { primary = "100" }
    existing_databases = {
      primary = {
        label                   = "invented-database"
        engine_id               = "postgresql/17"
        region                  = "us-east"
        type                    = "g6-standard-1"
        cluster_size            = 3
        suspended               = false
        expected_encrypted      = true
        expected_ssl_connection = true
        updates                 = { day_of_week = 2, duration = 4, frequency = "weekly", hour_of_day = 22 }
        private_network         = { vpc_id = 1, subnet_id = 2, public_access = false }
        engine_config = {
          engine_config_pg_jit                    = false
          engine_config_pg_timezone               = "Etc/UTC"
          engine_config_shared_buffers_percentage = 25
        }
      }
    }
  }
  assert {
    condition = (
      output.existing_databases.primary.private_network.public_access == false
      && length(keys(output.existing_databases.primary.engine_config)) == 47
      && output.existing_databases.primary.engine_config.engine_config_pg_jit == false
      && output.existing_databases.primary.engine_config.engine_config_pg_timezone == "Etc/UTC"
      && output.existing_databases.primary.engine_config.engine_config_shared_buffers_percentage == 25
      && output.existing_databases.primary.engine_config.engine_config_work_mem == null
    )
    error_message = "Typed settings must retain explicit overrides and leave unrecorded engine settings null."
  }
}

run "unrecorded_database_id" {
  command = plan
  module {
    source = "./tests/fixtures/database-adoption-validation"
  }
  variables {
    database_ids = {}
    existing_databases = {
      "primary" = {
        label                   = "invented-database"
        engine_id               = "postgresql/17"
        region                  = "us-east"
        type                    = "g6-standard-1"
        cluster_size            = 3
        suspended               = false
        expected_encrypted      = true
        expected_ssl_connection = true
        updates                 = { day_of_week = 2, duration = 4, frequency = "weekly", hour_of_day = 22 }
        private_network         = null
        engine_config           = {}
      }
    }
  }
  expect_failures = [var.existing_databases]
}

run "invalid_public_database_key" {
  command = plan
  module {
    source = "./tests/fixtures/database-adoption-validation"
  }
  variables {
    database_ids = { primary = "100" }
    existing_databases = {
      "db-1" = {
        label                   = "invented-database"
        engine_id               = "postgresql/17"
        region                  = "us-east"
        type                    = "g6-standard-1"
        cluster_size            = 3
        suspended               = false
        expected_encrypted      = true
        expected_ssl_connection = true
        updates                 = { day_of_week = 2, duration = 4, frequency = "weekly", hour_of_day = 22 }
        private_network         = null
        engine_config           = {}
      }
    }
  }
  expect_failures = [var.existing_databases]
}

run "duplicate_existing_cluster" {
  command = plan
  module {
    source = "./tests/fixtures/database-adoption-validation"
  }
  variables {
    database_ids = { primary = "100", secondary = "100" }
    existing_databases = {
      "primary" = {
        label                   = "invented-database"
        engine_id               = "postgresql/17"
        region                  = "us-east"
        type                    = "g6-standard-1"
        cluster_size            = 3
        suspended               = false
        expected_encrypted      = true
        expected_ssl_connection = true
        updates                 = { day_of_week = 2, duration = 4, frequency = "weekly", hour_of_day = 22 }
        private_network         = null
        engine_config           = {}
      }
      secondary = {
        label                   = "invented-database"
        engine_id               = "postgresql/17"
        region                  = "us-east"
        type                    = "g6-standard-1"
        cluster_size            = 3
        suspended               = false
        expected_encrypted      = true
        expected_ssl_connection = true
        updates                 = { day_of_week = 2, duration = 4, frequency = "weekly", hour_of_day = 22 }
        private_network         = null
        engine_config           = {}
      }
    }
  }
  expect_failures = [var.existing_databases]
}

run "fractional_node_count" {
  command = plan
  module {
    source = "./tests/fixtures/database-adoption-validation"
  }
  variables {
    database_ids = { primary = "100" }
    existing_databases = {
      "primary" = {
        label                   = "invented-database"
        engine_id               = "postgresql/17"
        region                  = "us-east"
        type                    = "g6-standard-1"
        cluster_size            = 1.5
        suspended               = false
        expected_encrypted      = true
        expected_ssl_connection = true
        updates                 = { day_of_week = 2, duration = 4, frequency = "weekly", hour_of_day = 22 }
        private_network         = null
        engine_config           = {}
      }
    }
  }
  expect_failures = [var.existing_databases]
}

run "missing_security_observation" {
  command = plan
  module {
    source = "./tests/fixtures/database-adoption-validation"
  }
  variables {
    database_ids = { primary = "100" }
    existing_databases = {
      "primary" = {
        label                   = "invented-database"
        engine_id               = "postgresql/17"
        region                  = "us-east"
        type                    = "g6-standard-1"
        cluster_size            = 3
        suspended               = false
        expected_encrypted      = null
        expected_ssl_connection = true
        updates                 = { day_of_week = 2, duration = 4, frequency = "weekly", hour_of_day = 22 }
        private_network         = null
        engine_config           = {}
      }
    }
  }
  expect_failures = [var.existing_databases]
}

run "missing_engine_config_record" {
  command = plan
  module {
    source = "./tests/fixtures/database-adoption-validation"
  }
  variables {
    database_ids = { primary = "100" }
    existing_databases = {
      "primary" = {
        label                   = "invented-database"
        engine_id               = "postgresql/17"
        region                  = "us-east"
        type                    = "g6-standard-1"
        cluster_size            = 3
        suspended               = false
        expected_encrypted      = true
        expected_ssl_connection = true
        updates                 = { day_of_week = 2, duration = 4, frequency = "weekly", hour_of_day = 22 }
        private_network         = null
        engine_config           = null
      }
    }
  }
  expect_failures = [var.existing_databases]
}

run "invalid_maintenance_day" {
  command = plan
  module {
    source = "./tests/fixtures/database-adoption-validation"
  }
  variables {
    database_ids = { primary = "100" }
    existing_databases = {
      "primary" = {
        label                   = "invented-database"
        engine_id               = "postgresql/17"
        region                  = "us-east"
        type                    = "g6-standard-1"
        cluster_size            = 3
        suspended               = false
        expected_encrypted      = true
        expected_ssl_connection = true
        updates                 = { day_of_week = 0, duration = 4, frequency = "weekly", hour_of_day = 22 }
        private_network         = null
        engine_config           = {}
      }
    }
  }
  expect_failures = [var.existing_databases]
}

run "invalid_maintenance_hour" {
  command = plan
  module {
    source = "./tests/fixtures/database-adoption-validation"
  }
  variables {
    database_ids = { primary = "100" }
    existing_databases = {
      "primary" = {
        label                   = "invented-database"
        engine_id               = "postgresql/17"
        region                  = "us-east"
        type                    = "g6-standard-1"
        cluster_size            = 3
        suspended               = false
        expected_encrypted      = true
        expected_ssl_connection = true
        updates                 = { day_of_week = 2, duration = 4, frequency = "weekly", hour_of_day = 24 }
        private_network         = null
        engine_config           = {}
      }
    }
  }
  expect_failures = [var.existing_databases]
}

run "unsupported_maintenance_frequency" {
  command = plan
  module {
    source = "./tests/fixtures/database-adoption-validation"
  }
  variables {
    database_ids = { primary = "100" }
    existing_databases = {
      "primary" = {
        label                   = "invented-database"
        engine_id               = "postgresql/17"
        region                  = "us-east"
        type                    = "g6-standard-1"
        cluster_size            = 3
        suspended               = false
        expected_encrypted      = true
        expected_ssl_connection = true
        updates                 = { day_of_week = 2, duration = 4, frequency = "monthly", hour_of_day = 22 }
        private_network         = null
        engine_config           = {}
      }
    }
  }
  expect_failures = [var.existing_databases]
}

run "missing_private_network_flag" {
  command = plan
  module {
    source = "./tests/fixtures/database-adoption-validation"
  }
  variables {
    database_ids = { primary = "100" }
    existing_databases = {
      "primary" = {
        label                   = "invented-database"
        engine_id               = "postgresql/17"
        region                  = "us-east"
        type                    = "g6-standard-1"
        cluster_size            = 3
        suspended               = false
        expected_encrypted      = true
        expected_ssl_connection = true
        updates                 = { day_of_week = 2, duration = 4, frequency = "weekly", hour_of_day = 22 }
        private_network         = { vpc_id = 1, subnet_id = 2, public_access = null }
        engine_config           = {}
      }
    }
  }
  expect_failures = [var.existing_databases]
}
