# The shape of TOFU_VARS (tofu-ci.sh prepare): the original seven keys and optional adoption map of
# ../examples/example.tfvars.json, and the values the masks (masks.jq) rely on. ../variables.tf
# validates every value again, precisely. The caller discards jq's output and errors, which could
# quote the value, and prints a fixed message instead.
def str($re): type == "string" and test($re);
type == "object"
and ((keys - ["existing_databases"]) == ["cloudflare_zone_id", "configure_keys", "database_ids", "db_allow_extra", "hosts", "root_keys", "root_password_hash"])
and (if has("existing_databases") then .existing_databases | type == "object" else true end)
and (.database_ids as $ids | all((.existing_databases // {}) | to_entries[];
    .key as $key | ($ids | has($key)) and (.value | type == "object")))
and (.hosts | type == "object")
and all(.hosts | to_entries[];
    (.key | test("^(staging|production)(-[0-9]{1,2})?$"))
    and (.value | type == "object" and keys == ["fqdn", "label", "region", "role", "type"])
    and (.value.label | type == "string")
    and (.value.fqdn | str("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$"))
    and (.value.role | str("^(staging|production)$"))
    and (.value.region | str("^[a-z0-9-]{2,32}$"))
    and (.value.type | str("^[a-z0-9-]{2,64}$")))
and (.root_keys | type == "array" and all(.[]; str("^[ -~]+$")))
and (.configure_keys | type == "object" and all(.[]; str("^[ -~]+$")))
and (.root_password_hash | str("^[$./0-9A-Za-z=]*$"))
and (.cloudflare_zone_id | str("^[0-9a-f]{32}$"))
and (.database_ids | type == "object" and all(to_entries[]; (.key | test("^[a-z]{1,16}$")) and (.value | str("^[0-9]{1,20}$"))))
and (.db_allow_extra | type == "array" and all(.[]; str("^[0-9A-Fa-f.:]+/[0-9]{1,3}$")))
