# Changelog

> **Type:** Changelog
> **Last updated:** 2026-11-12

All notable changes to the PIPT project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/).

## [2026-11-12]

### Added

- **Monitoring and recovery:** an encrypted SNS alarm topic (`{StackPrefix}-Monitoring` stack) that every alarm publishes to, new alarms for RDS storage and memory, text-generation throttling, ingestion failures and socket-server health, failure queues for document ingestion and debrief runs, DynamoDB point-in-time recovery, versioning on the document and embedding buckets, and RDS backups kept if the instance is deleted
- **Audit logging:** structured `AUDIT` and `AUTHZ_DENY` log lines in the Lambda handlers, an authorization-denial spike alarm, a role-change audit table (migration `004_role_audit_log`), API Gateway access logs, WAF request logs, S3 and CloudFront access logs, and an optional CloudTrail stack (`-c EnableCloudTrail=true`)
- **Log protection:** CloudWatch log groups are encrypted with a customer-managed KMS key and have a finite retention (`-c LogRetentionDays`, default 365)
- **Image delivery pipeline:** images use immutable tags and must pass a CRITICAL/HIGH vulnerability scan before release. They are deployed by digest, with an approved-tag pointer in SSM and a rollback command printed for each deploy
- **Security headers and CSP** for the Amplify frontend (Report-Only by default, `-c CspEnforce=true` to enforce)
- **Admin bootstrap Lambda** for promoting the first administrator
- Test suites covering authorization, socket sessions, streaming, debriefs and text generation (Jest and pytest)

### Changed

- Switched the chat and debrief LLM from Claude Sonnet 4.6 to Claude Sonnet 5.5, including IAM permissions, alarms and request settings (no `temperature`; per-call `effort`, `high` for debriefs)
- Debrief generation runs asynchronously, at most one run per chat (claimed in DynamoDB), with automatic retries and recovery of lost runs. A debrief is only produced for a concluded chat
- Concluded sessions are final: no further messages, and each chat allows only one initial prompt
- The voice agent takes its prompt and patient context only from the server, never from the client
- Faster chat streaming: removed 5-second stalls in streamed replies, and live chat keeps working during deploys
- Dependency updates across the frontend, CDK and Python services, and Docker base images patched to clear image-scan findings

### Security

- **Authorization:** every student, instructor and admin route checks organization, group, patient and session ownership on the server. Object-level checks cover files, profile pictures, question banks and streams. Preview enrollment is limited to staff, and scores supplied by the client or the model are no longer trusted
- **Authentication:** hardened JWT authorizers. The socket server verifies tokens with `aws-jwt-verify`, rate-limits reauthentication and JWKS fetches, and closes sockets when their ID token expires. The Cognito identity pool role has no permissions
- **Stream and socket hardening:** stream callbacks are bound to a per-request nonce and an SSM-configured URL, `/stream-callback` is blocked at CloudFront, the NLB accepts only CloudFront and in-VPC traffic, socket events are validated, and voice-preview limits are per user
- **AI safety:** the voice agent and chat refuse to run when the Bedrock guardrail is missing or unavailable, AI audio is gated on the guardrail verdict, every turn is screened before grading, answer keys are kept out of student chat, and chat text is redacted from guardrail logs
- **Least-privilege IAM:** IAM roles are scoped to specific resources (Secrets Manager, Bedrock models, ECR repositories, CodeBuild, Cognito triggers and the socket redeploy). Broad managed policies such as `AmazonS3FullAccess` were removed. Database access uses separate `app_rw` and `app_tc` users instead of the master credential, with rotated credentials and a privilege-regression alarm
- **Data protection:** the Cognito user pool and database are retained and deletion-protected, tokens and secrets are redacted from logs, group access codes use a cryptographically secure random generator, presigned uploads are bound to the persona's group, and CORS allows only exact origins
- **WAF:** path-scoped XSS and body-size rules replace the blanket managed rules that blocked legitimate clinical content

### Fixed

- Debriefs: stale instructor recommendation caches, errors reported as successes, and stuck or duplicate runs
- Text generation: message caps resolved from the chat's group, wildcard CORS origins, playground turns no longer written to the database, matching on the stored message text, and canonical session IDs
- Ingestion: URL-encoded S3 keys, chunk source IDs, and a timeout sweep scoped to stuck rows
- Voice: reconnecting after a timeout, a microphone stuck on "connecting", and the mute icon after a session ends
- Admin promotion and Cognito/database role mismatches; the global system prompt is scoped to the null organization

## [2026-05-30]

### Added

- `USER_GUIDE.md` — User-facing guide covering student, instructor, and admin workflows
- `CHANGELOG.md` — Project changelog following Keep a Changelog format
- `DATA_INGESTION.md` — Technical reference for the document ingestion pipeline and vector store
- `BEDROCK_GUARDRAILS.md` — Technical reference for AI content filtering and prompt injection defenses
- `README.md` — Central documentation index organized by document type
- `CONTRIBUTING_DOCS.md` — Documentation maintenance rules and contribution guidelines

### Changed

- Renamed files from camelCase to UPPER_SNAKE_CASE to follow naming conventions:
  - `architectureDeepDive.md` → `ARCHITECTURE_DEEP_DIVE.md`
  - `deploymentGuide.md` → `DEPLOYMENT_GUIDE.md`
  - `modificationGuide.md` → `MODIFICATION_GUIDE.md`
  - `databaseMigrations.md` → `DATABASE_MIGRATIONS.md`
  - `dependencyManagement.md` → `DEPENDENCY_MANAGEMENT.md`
- Restructured `ARCHITECTURE_DEEP_DIVE.md` to follow the Technical Reference pattern
- Restructured `DEPLOYMENT_GUIDE.md` to follow the Procedural Guide pattern
- Restructured `MODIFICATION_GUIDE.md` to follow the Procedural Guide pattern
- Restructured `DATABASE_MIGRATIONS.md` to follow the Procedural Guide pattern
- Restructured `DEPENDENCY_MANAGEMENT.md` to follow the Technical Reference pattern
- Added supplementary document headers to `CDK_TECHNICAL_REVIEW.md`, `SECURITY_OVERVIEW.md`, `VOICE_AGENT_DEEP_DIVE.md`, and `AGENTCORE_VOICE_AGENT_SETUP.md`
