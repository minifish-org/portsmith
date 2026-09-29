# Public release preparation

Prepared in English: README, contributor guidance, security notes, and migration evidence. Existing AGPL licensing and upstream MIT notices are retained. Pith adds offline no-CGO CI; Portsmith retains local model-fixture tests.

## Review before making the repositories public

- Review and commit local changes; Portsmith's executed fixes are not all represented by its previous HEAD.
- Scan both current tracked files and Git history for credentials and private data. The preparation scan found no matches for selected API-token/private-key patterns; it is not a comprehensive secret-detection guarantee. Test fixture email addresses are synthetic. Pith's historical analysis contains a local source checkout path.
- `.env`, raw sessions, node_modules, build output, and local progress stay ignored. Exported evidence contains no raw model reasoning or credentials.
- Keep the original migration receipts immutable. Future updates need new reviewed evidence.
- The two repositories were private during the preparation audit. The maintainer subsequently authorized committing, pushing, making both repositories public, and publishing the blog. The tweet remains an unposted draft; no package-registry release is claimed.
- Review the draft blog's account-wide usage attribution before describing it as the exact migration cost.
- Do not advertise complete Pi compatibility, production readiness, or a working scheduled self-porting system.

This file records release preparation; repository visibility and deployment status must be checked on GitHub and the live site. Enabling CI in GitHub is not evidence that hosted jobs have run successfully.
