# One line per diagnostic in OpenTofu's JSON messages (tofu-ci.sh, when plan or apply fails):
# SEVERITY ADDRESS [FILE:LINE] SUMMARY. The file and line are in this public module (a variable's
# validation names its block). The summary has every masked value ($masks[0], masks.jq) replaced,
# then is reduced to letters, spaces and . , : ' ( ) -: digits, '/', '@' and '=' never survive, so
# no ID, address, key or URL does, and what is left of a dotted name (a host or a domain) becomes
# "(name)". At most 120 characters; the detail never prints. Run with jq -rR, one message a line.
fromjson?
| select(type == "object" and .type == "diagnostic")
| .diagnostic
| (if .severity == "error" or .severity == "warning" then .severity else "?" end) as $sev
| ((.address // "-") | if . == "-" or test("^[a-z0-9_]+[.][a-z0-9_]+(\\[\"[a-z0-9-]+\"\\])?$") then . else "?" end) as $addr
| (if (.range.filename | type == "string" and test("^[a-z0-9_-]+[.](tf|tftpl)$")) and (.range.start.line | type == "number")
   then " \(.range.filename):\(.range.start.line)" else "" end) as $where
| (reduce $masks[0][] as $m ((.summary // "") | tostring; split($m) | join(" (masked) ")))
| gsub("[^A-Za-z .,:'()-]"; "") | gsub("[A-Za-z-]+([.][A-Za-z-]+)+"; "(name)") | gsub(" +"; " ")
| .[0:120]
| "\($sev) \($addr)\($where) \(.)"
