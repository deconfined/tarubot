# Every value in TOFU_VARS that may name or identify a host or an account (tofu-ci.sh values and
# adopt mask each one before anything else prints): the DNS names, the zone ID, each access-list
# extra and its bare address, root's hash and each key's base64 field. Map keys, roles, regions,
# types, Linode labels (display names inside the account, like production's documented `tarubot`)
# and database IDs are never masked: they are public words or never printed, and masking them
# would censor the change list. Values under six characters identify nothing and would mask too
# much.
[ (.hosts[] | .fqdn),
  .cloudflare_zone_id,
  (.db_allow_extra[] | ., split("/")[0]),
  (.root_password_hash | select(. != "")),
  ((.root_keys[], .configure_keys[]) | split(" ")[] | select(startswith("AAAA")))
] | map(select(length >= 6)) | unique
