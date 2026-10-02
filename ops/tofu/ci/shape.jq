# Reject obsolete/unknown private input fields before masks or native planning. Precise values
# are checked by the Bun input adapter and again by OpenTofu's sensitive variable validations.
type == "object"
and keys == ["cloudflare_zone_id", "configure_keys", "databases", "db_allow_extra", "hosts", "openstack_project_id", "ovh_project_id", "root_keys", "root_password_hash"]
and (.hosts | type == "object" and all(to_entries[];
  (.key | test("^(staging|production)(-[0-9]{1,2})?$"))
  and (.value | type == "object" and keys == ["flavor_id", "fqdn", "image_id", "label", "network_id", "role"]
    and (.label | type == "string")
    and (.fqdn | type == "string" and test("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")))))
and (.databases | type == "object" and all(to_entries[];
  (.key | test("^[a-z]{1,16}$"))
  and (.value | type == "object" and keys == ["backup_time", "description", "disk_size_gb", "flavor", "maintenance_time", "version"])))
and (.root_keys | type == "array" and all(.[]; type == "string"))
and (.configure_keys | type == "object" and all(.[]; type == "string"))
and (.root_password_hash | type == "string")
and (.cloudflare_zone_id | type == "string" and test("^[0-9a-f]{32}$"))
and (.ovh_project_id | type == "string")
and (.openstack_project_id | type == "string")
and (.db_allow_extra | type == "array" and all(.[]; type == "string" and test("^[0-9a-f:.]+/[0-9]{1,3}$")))
