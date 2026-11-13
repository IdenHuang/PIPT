# Changelog

> **Type:** Changelog
> **Last updated:** 2026-11-12

All notable changes to the PIPT project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/).

## [2026-11-12]

### Added

- `{StackPrefix}-Monitoring` stack (`cdk/lib/monitoring-stack.ts`): a KMS-encrypted SNS alarm topic (no subscriptions are created)
- Every CloudWatch alarm in the Database, Api and EcsSocket stacks now notifies the alarm topic; until now no alarm had an action
- New alarms: RDS free storage below 10 GiB, RDS freeable memory below 256 MiB, text-generation Lambda throttling, document-ingestion failures, and no healthy socket-server task behind the NLB
- Document-ingestion events that still fail after Lambda's two async retries go to the `{StackPrefix}-Api-IngestionFailures` SQS queue instead of being dropped
- Point-in-time recovery on the DynamoDB conversation table, enabled by the `EnsureConversationTable` custom resource on Create and Update
- Versioning on the document (data ingestion) and embedding buckets; deleted or overwritten objects stay recoverable for 30 days
- `DEPLOYMENT_GUIDE.md`: alarm and data-recovery sections

### Changed

- RDS automated backups are kept when the instance is deleted (`deleteAutomatedBackups: false`)

- Switched the primary chat and debrief LLM from Claude Sonnet 4.6 to Claude Sonnet 5.5 (`us.anthropic.claude-sonnet-5-5`), set by the `/{id}/BedrockLLMId` SSM parameter in `cdk/lib/api-service-stack.ts`
- `get_bedrock_llm()` in `cdk/text_generation/src/helpers/chat.py` no longer sends `temperature`, which Sonnet 5.5 rejects
- `get_bedrock_llm()` now sends `thinking: {"type": "between_tools"}` so Sonnet 5.5 answers without up-front thinking and returns plain-text responses, matching Sonnet 4.6 behavior
- `get_bedrock_llm()` now takes an `effort` argument (`low`, `medium` or `high`, default `medium`); debrief and test-debrief generation in `cdk/text_generation/src/main.py` use `high`
- Bedrock IAM permissions in the Api and EcsSocket stacks now allow the Sonnet 5.5 inference profile and foundation model instead of Sonnet 4.6
- Bedrock invocation and input-token spike alarms now track the Sonnet 5.5 model ID
- Updated model references in `README.md`, `DEPLOYMENT_GUIDE.md`, `ARCHITECTURE_DEEP_DIVE.md` and `MODIFICATION_GUIDE.md`
- `MODIFICATION_GUIDE.md` now lists the IAM, alarm and request-setting updates needed when changing the LLM

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
