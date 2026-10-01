# CI/CD

Use [CONTRIBUTING.md](../CONTRIBUTING.md) for local checks and [the threat model](THREAT_MODEL.md) for the agreed trust boundary.

## Workflows

| Workflow | Purpose and gate |
| --- | --- |
| `ci.yml` | Version/changelog, types, lint/format, build, unit/contract/PostgreSQL tests and AMD64/ARM64 image builds; required `CI result` |
| `publish.yml`, `scan.yml` | Verify merged `main`; a new version publishes candidates, scans both exact platform digests, signs provenance and promotes `latest` |
| `deploy.yml`, `host.yml` | Verify the published release and deploy the requested target; see [DEPLOYMENT](DEPLOYMENT.md) |
| `infra.yml` | Dispatch-only infrastructure plan and owner-approved Apply; see [OpenTofu](../ops/tofu/README.md) |
| `release.yml`, `release-infra.yml` | Inactive replacement pipeline; see [current status](PIPELINE.md#current-status) |
| `pages.yml` | pnpm/Node site build and Pages publication; site changes need a green Build |
| `dependency-audit.yml` | Advisory audit of locked Bun dependencies |

CodeQL uses GitHub default setup for JavaScript/TypeScript and Actions. The owner manages its settings and required security checks.

Actions use full-SHA pins and checkouts do not persist credentials. PR checks use invented data and need no live Discord, database or provider credentials. CI also checks migration immutability, ShellCheck, Quadlet rendering, builtin-only Ansible syntax/lint and renderer equivalence, and mock OpenTofu/cloud-init behavior. The version gate runs last so dependency PRs still receive other results.

Merge with a merge commit after current CI/security checks and the owner's code-owner review. Further pushes dismiss that approval. A published release can configure staging as root, so review is a security boundary.

## Release intent

An unchanged application version passes CI without a new changelog or startup plan. Documentation, tests and pipeline revisions use their Git commit identity. Application changes may accumulate on `main`; increasing `package.json` declares a bot release and requires its changelog entry and matching startup plan. Versions cannot decrease.

Only the first automatic push run with a new version publishes images. Maintenance merges, manual Publish dispatches and reruns verify without publishing, signing, moving `latest` or requesting deployment. The workflow refuses an existing version tag and serializes publication for each version. If a failed run already created that tag, fix the failure and release a new version rather than overwrite it.

## Signed build provenance

Publication scans both exact runtime child digests with checksum-pinned Trivy before signing the build-returned index digest. Fixable high/critical findings, scanner errors and registry errors block signing and promotion. Candidate tags can exist after failure; they do not authorize deployment.

The default policy in [release-scan-exceptions.ts](../scripts/release-scan-exceptions.ts) is empty. Exceptions need reviewed exact finding fields, a reason, issue and bounded expiry. Signing and promotion recheck the policy after job waits. Only the attestation job receives OIDC/attestation permissions; it has no registry write permission and installs no repository dependencies. `latest` advances only after signing.

Deploy verifies certificate identity, source ref and commit before using a digest, including an already-live release. For a manual verification, substitute the digest and commit:

```sh
gh attestation verify oci://ghcr.io/deconfined/tarubot@<digest> \
  --repo deconfined/tarubot \
  --cert-identity https://github.com/deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main \
  --source-ref refs/heads/main --source-digest <commit> \
  --predicate-type https://slsa.dev/provenance/v1 --deny-self-hosted-runners
```

Keep the exact `--cert-identity`; `--signer-workflow` accepts a broader pattern. Normal Deploy refuses unsigned releases. Publication success does not prove deployment success.

## Dependency updates

| Dependency | Update method / paired pins |
| --- | --- |
| Bun | Dependabot Docker PR; synchronize runtime, `@types/bun`, lockfile and README |
| PostgreSQL | Dependabot Compose minor PR; synchronize CI and README; majors need a migration plan |
| Actions | Dependabot SHA-pin PR; retain full pins and version comments |
| Site | Dependabot pnpm PR; install/build from `site/` and check peer compatibility |
| Bun packages | Manual Bun update and frozen install; Dependabot cannot read the current lockfile format |
| Selectors | `bun run selectors:update`; commit lockfile and revision metadata together |
| Ansible | Regenerate hash-pinned requirements as their headers describe; run offline checks |
| OpenTofu/providers | Follow [Checks and upgrades](../ops/tofu/README.md#checks-and-upgrades) |

Dependency PRs use normal CI without a mandatory version/changelog/test-plan update; publish runtime dependency changes in the next explicit bot release. Do not add `[dependabot skip]`: it permits force-pushing over maintainer edits. After a maintainer push, merge newer `main` if necessary; `@dependabot recreate` discards those commits. Security alerts are enabled; automated security-update PRs are off.

## Assistant workflow boundaries

The agent rule, confirmed on 2026-09-26, is in [AGENTS.md](../AGENTS.md). Trusted workflow triggers must not execute member-submitted Discord text; the suggestion marker preserves that boundary even when a trusted account posts it.

Actions logs are public. Keep hosts, addresses, zone/account/cluster IDs and credentials out of output, validate workflow inputs, and avoid trace/debug output.
