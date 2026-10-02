# Public resource keys/roles alone remain unmasked. Mask every private identifying input,
# including account/image/flavor/network values and short database descriptions. The caller
# escapes workflow-command characters before writing these commands to a public runner log.
[ (.hosts[] | .[] | select(type == "string") | select(. != "staging" and . != "production")),
  (.databases[] | .[] | select(type == "string")),
  .ovh_project_id, .openstack_project_id, .cloudflare_zone_id,
  (.db_allow_extra[] | ., split("/")[0]),
  (.root_password_hash | select(. != "")),
  ((.root_keys[], .configure_keys[]) | split(" ")[] | select(startswith("AAAA")))
] | map(select(length > 0)) | unique
