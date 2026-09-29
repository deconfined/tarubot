# The public change list (tofu-ci.sh summarize): one sorted line per change, `ACTION ADDRESS`,
# plus ` +N -M` (entries added and removed) on a database access list, and `?` for anything this
# can't name, which the guards then refuse. Input: `tofu show -json` of the saved plan; $vars[0]:
# the values. A set with a new host's addresses in it is wholly unknown in a plan, so its counts are
# rebuilt the way ../main.tf builds the list: db_allow_extra, each known host's IPv6 /128 and IPv4
# /32, and two entries per host still being built.
def addr: if test("^[a-z_]+[.][a-z_]+(\\[\"[a-z0-9-]+\"\\])?$") then . else "?" end;
def act:
  if . == ["create"] then "create"
  elif . == ["update"] then "update"
  elif . == ["delete"] then "delete"
  elif . == ["read"] then "read"
  elif . == ["delete", "create"] or . == ["create", "delete"] then "replace"
  elif . == ["no-op"] then "no-op"
  else "?" end;
def unknown: if type == "boolean" then . else tostring | contains("true") end;
$vars[0] as $v
| [.resource_changes[]?] as $rc
| [$v.hosts | keys[] as $k
    | ([$rc[] | select(.type == "linode_instance" and .name == "host" and .index == $k and (has("deposed") | not))][0].change) as $c
    | if $c == null or $c.after == null or ($c.after_unknown.ipv4 // false | unknown) or ($c.after_unknown.ipv6 // false | unknown)
      then {unknown: 2}
      else {known: [(($c.after.ipv6 // "?") | split("/")[0]) + "/128", (($c.after.ipv4 // ["?"])[0]) + "/32"]}
      end] as $hosts
| ($v.db_allow_extra + [$hosts[] | (.known // [])[]]) as $known
| ([$hosts[] | .unknown // 0] | add // 0) as $pending
| def counts:
    (.before.allow_list // []) as $b
    | if .actions == ["delete"] then {plus: 0, minus: ($b | length)}
      elif (.after_unknown.allow_list // false | unknown) or .after.allow_list == null
      then {plus: ((($known - $b) | unique | length) + $pending), minus: (($b - $known) | unique | length)}
      else (.after.allow_list) as $a | {plus: (($a - $b) | unique | length), minus: (($b - $a) | unique | length)}
      end;
[ $rc[]
  | (.change.actions | act) as $act
  | (.address | addr) as $a
  | (if .type == "linode_database_access_controls" then .change | counts | " +\(.plus) -\(.minus)" else "" end) as $n
  | (if .change.importing != null then "import \($a)\($n)" else empty end),
    (if $act != "no-op" then "\($act) \($a)\($n)" else empty end)
] | sort | .[]
