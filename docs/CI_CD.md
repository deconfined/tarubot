# CI/CD

Use [CONTRIBUTING.md](../CONTRIBUTING.md) for the local change checklist. This reference describes the workflows, not a history of individual runs.

## Workflows

| Workflow | Purpose and gate |
| --- | --- |
| `ci.yml` | Version/changelog, types, lint/format, build, unit/contract/PostgreSQL tests and AMD64/ARM64 image builds; required `CI result` |
| `codeql.yml` | JavaScript/TypeScript and Actions analysis; required security gate |
| `publish.yml`, `scan.yml` | Revalidate merged `main`, publish candidate images, scan both exact platform digests, sign provenance, then promote `latest` |
| `release.yml`, `release-infra.yml` | Inactive replacement components; code-fenced before credentials until adoption/trust ship; see [PIPELINE](PIPELINE.md#replacement-components-implemented-but-activation-fenced) |
| `deploy.yml`, `host.yml` | Verify the published release and run target-specific deployment; see [DEPLOYMENT](DEPLOYMENT.md) |
| `infra.yml` | Dispatch-only infrastructure plan/approved apply; see [OpenTofu](../ops/tofu/README.md) |
| `pages.yml` | pnpm/Node site build and Pages publication; site changes must have a green Build |
| `dependency-audit.yml` | Advisory audit of all locked Bun dependencies |
| `claude-code-review.yml`, `claude.yml` | Advisory read-only PR review and trusted `@claude` requests |

Actions use full-SHA pins; checkouts never persist credentials. PR jobs are read-only and use invented migration input. CI needs no live Discord/database/provider credentials. The version gate runs last so earlier checks still report on dependency PRs awaiting a version commit.

Infrastructure's reviewed `adopt` operation imports only explicitly configured existing clusters. Cluster mutation is independently refused regardless of destroy/access switches. Import completion remains pending until a separate step, using read-only provider tokens, verifies a fresh no-change plan and exact saved-plan/state evidence. Private settings and any real import remain owner steps; release activation stays fenced.

CI also refuses changes to existing migrations, checks ShellCheck coverage, renders the bot unit through the pinned Podman Quadlet generator, syntax/lint-checks the builtin-only Ansible playbooks, and compares the test renderer with Ansible. PR infrastructure checks run pinned OpenTofu fmt/validate/mock tests and cloud-init schema validation without secrets; publication can skip that external-registry-dependent job.

Merge with a merge commit only, after up-to-date CI, security checks and the owner's code-owner review. Further pushes dismiss that review. A runtime merge can configure staging as root; review is a security boundary, not paperwork.

## Signed build provenance

Publication scans both runtime child digests with checksum-pinned Trivy before signing the **build-returned index digest**, not a tag read back from GHCR. Remote-only scans authenticate the JSON report's digest, platform and scanner version. Fixable high/critical findings fail unless they match an exact reviewed source exception; every scanner/registry/database error fails. Repository ignore/config files and runtime policy overrides are disabled.

`scripts/release-scan-exceptions.ts` holds the empty default policy. Any exception requires a protected-main/CODEOWNERS review, exact platform/result/package/vulnerability/version/severity fields, a reason, repository issue and an expiry within 30 days of review; at most 32 entries are allowed. OS targets first match the complete authenticated digest-bearing name, then use exact family/base version plus extended-support status so a source change can survive the next image build. Language package targets remain literal. Neither a timestamp nor an issue link grants approval. Expired or future-reviewed entries block the gate even when no reported finding uses them.

Both scans and private cleanup count against wall and physical expiry. Signing and `latest` promotion each check the same release checkout's fixed policy after job waits, immediately before their write, and require strictly more than ten minutes of remaining validity; each write job has a hard ten-minute deadline. These checkpoints enforce expiry and depend on the earlier completed two-platform scan; they do not rescan or atomically lock registry writes. Only the attestation job receives OIDC/attestation write permissions; that job has no registry write and installs no repository dependencies. `latest` advances only after signing (and replacement staging acceptance when that future lane is enabled). Unsigned BuildKit provenance/SBOM metadata is not the deployment trust boundary.

Deployment verifies the exact certificate identity, source ref and commit before any digest is used, even before a “nothing to deploy” exit. To verify a release manually, substitute its digest and commit:

```sh
gh attestation verify oci://ghcr.io/deconfined/tarubot@<digest> \
  --repo deconfined/tarubot \
  --cert-identity https://github.com/deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main \
  --source-ref refs/heads/main --source-digest <commit> \
  --predicate-type https://slsa.dev/provenance/v1 --deny-self-hosted-runners
```

Use `--cert-identity`, not `--signer-workflow`: the latter's pattern is only start-anchored. Releases before signed publication are not accepted by normal Deploy. Publication success alone does not prove deployment success.

## Dependency updates

| Dependency | Update method / paired pins |
| --- | --- |
| Bun | Dependabot Docker PR; synchronize manifest runtime, `@types/bun`, lockfile and README |
| PostgreSQL | Dependabot Compose minor PR; synchronize CI service and README; majors need a migration plan |
| Actions | Dependabot SHA-pin PR; retain full pins and version comments |
| Site | Dependabot pnpm PR; install/build from `site/` and check peer compatibility |
| Bun packages | Manual Bun update and frozen install; Dependabot cannot read the current lockfile format |
| Selectors | `bun run selectors:update`; commit lockfile and revision metadata together |
| Ansible | Regenerate hash-pinned requirements as their headers describe; run offline checks |
| OpenTofu/providers | Follow [Checks and upgrades](../ops/tofu/README.md#checks-and-upgrades) |

Dependency PRs need the same version/changelog/test-plan update as any change. Do not add `[dependabot skip]`; it permits a force-push over maintainer edits. After your push, Dependabot stops rebasing: merge newer `main` into the branch if necessary. `@dependabot recreate` discards maintainer commits. Security alerts remain enabled; automated security-update PRs are off.

## Assistant workflow boundaries

The agent rule was confirmed by @deconfined on 2026-09-26 ([#41](https://github.com/deconfined/tarubot/issues/41#issuecomment-5846407419)) and widened to all deployment environments and Infrastructure. Its binding wording is in [AGENTS.md](../AGENTS.md). Agents read public logs but never hold environment secrets, approve/bypass/re-run a deployment, change an environment, or use real infrastructure credentials. Dispatch requires the owner's request in that session.

The PR review is advisory and read-only. Do not push concurrently with an `@claude` code-editing run: its API commits can overwrite newer branch changes. Do not ask it to edit fork PRs. Workflows gated on trusted author association must skip the Discord suggestion marker; a trusted comment can still expose untrusted member text to an assistant.

Public Actions logs must not expose hosts, addresses, zone/account/cluster IDs, keys or secrets. Keep data masked, pass workflow expressions through validated inputs and avoid trace/debug output. Historical credential/review analysis is preserved in [the archive](archive/README.md#operations-and-cutovers).
