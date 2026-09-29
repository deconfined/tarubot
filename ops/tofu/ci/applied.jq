# The apply's own counts, from its change_summary message (tofu-ci.sh apply): numbers only. Run
# with jq -rR, one message a line.
fromjson?
| select(type == "object" and .type == "change_summary") | .changes
| "applied: \(.add | numbers) added, \(.change | numbers) changed, \(.import | numbers) imported, \(.remove | numbers) destroyed"
