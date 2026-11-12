# Architecture Deep Dive

> **Type:** Technical Reference
> **Last updated:** 2026-05-30

## Table of Contents

- [Overview](#overview)
- [Component Breakdown](#component-breakdown)
  - [Edge and Security](#edge-and-security)
  - [Frontend Hosting](#frontend-hosting)
  - [Authentication](#authentication)
  - [API Layer](#api-layer)
  - [Real-time Streaming](#real-time-streaming)
  - [Data Persistence](#data-persistence)
  - [Object Storage](#object-storage)
  - [AI Services](#ai-services)
  - [Voice Agent](#voice-agent)
  - [CI/CD Pipeline](#cicd-pipeline)
- [Data Flow Diagrams](#data-flow-diagrams)
  - [Text Chat Flow](#text-chat-flow)
  - [Voice Interaction Flow](#voice-interaction-flow)
  - [Document Ingestion Flow](#document-ingestion-flow)
- [Semantic Matching](#semantic-matching)
  - [Key Question Matching](#key-question-matching-real-time-per-message)
  - [DTP Matching](#dtp-matching-at-conclude-time)
  - [Recommendation Matching](#recommendation-matching-at-conclude-time)
  - [Configurable Thresholds](#configurable-thresholds)
  - [Embedding Cache Strategy](#embedding-cache-strategy)
  - [Key Functions](#key-functions)
- [Database Schema](#database-schema)
  - [organizations](#organizations)
  - [users](#users)
  - [simulation_groups](#simulation_groups)
  - [group_instructors](#group_instructors)
  - [personas](#personas)
  - [persona_media](#persona_media)
  - [persona_data](#persona_data)
  - [rubrics](#rubrics)
  - [key_questions](#key_questions)
  - [enrollments](#enrollments)
  - [student_interactions](#student_interactions)
  - [chats](#chats)
  - [messages](#messages)
  - [debriefs](#debriefs)
  - [feedback](#feedback)
  - [user_engagement_log](#user_engagement_log)
  - [system_prompt_history](#system_prompt_history)
  - [question_bank](#question_bank)
  - [simulation_group_questions](#simulation_group_questions)
  - [question_interactions](#question_interactions)
  - [debrief_prompt_history](#debrief_prompt_history)
  - [debrief_feedback](#debrief_feedback)
  - [issue_reports](#issue_reports)
  - [dtp_bank](#dtp_bank)
  - [recommendations_bank](#recommendations_bank)
  - [simulation_group_dtps](#simulation_group_dtps)
  - [simulation_group_recommendations](#simulation_group_recommendations)
- [Entity Relationships](#entity-relationships)
- [Cross-References](#cross-references)

## Overview

The Patient Interaction Practice Tool platform is a clinical simulation system for pharmacy education. Students interact with AI-powered patient personas through text and voice chat, practicing clinical assessment skills in a safe environment. The system is built on AWS using CDK for infrastructure-as-code, with a React SPA frontend, monolithic Lambda API handlers, real-time streaming via Socket.IO on ECS Fargate, and AI inference through Amazon Bedrock. DynamoDB provides fast key-value storage for LangChain conversation history and embedding caches, while RDS PostgreSQL holds all relational application data.

![Patient Interaction Practice Tool Architecture](./architecture-diagram-no-numberings-with-ses.drawio.png)

## Component Breakdown

### Edge and Security

CloudFront sits in front of the Socket.IO server (NLB origin) to provide HTTPS termination and WebSocket proxying. All traffic enters through HTTPS endpoints. Cognito handles authentication and a Bedrock Guardrail screens user input and AI output for content safety.

### Frontend Hosting

A React SPA built with Vite is hosted on AWS Amplify. Amplify auto-builds from the `main` branch on push. The app uses Tailwind CSS, shadcn/ui components, and communicates with the backend via REST API and WebSocket connections.

### Authentication

Amazon Cognito User Pool handles sign-up, sign-in, and email verification. A custom Lambda authorizer (`jwtAuthorizer.js`) validates JWTs on every API request and injects `userId` and `email` into the request context. Roles are stored in the database, not in JWT claims.

**Email delivery** is configurable. If the deployer sets the `SesVerifiedDomain` CDK context variable, Cognito sends verification codes and password-reset emails through Amazon SES using a verified domain identity (e.g., `noreply@yourdomain.com`). CDK automatically creates the SES Email Identity and configures DKIM/MAIL FROM DNS records via Route 53. Without `SesVerifiedDomain`, Cognito falls back to its built-in email service, which is limited to 50 emails per day (sandbox). See [Custom Domain & SES Setup](./CUSTOM_DOMAIN_AND_SES.md) for configuration details.

### API Layer

Amazon API Gateway (REST) routes requests to monolithic Lambda handlers per role: `studentFunction.js`, `instructorFunction.js`, and `adminFunction.js`. Each handler uses `httpMethod + resource` switch routing. An OpenAPI/Swagger definition drives the API Gateway configuration.

### Real-time Streaming

Both text chat and voice flow through a Socket.IO server running on ECS Fargate. The frontend establishes a single WebSocket connection (via CloudFront → NLB → ECS) for all real-time communication. For text chat, the Socket.IO server invokes the Text Generation Lambda and streams response tokens back to the client. This unified WebSocket approach replaced an earlier AppSync-based design, providing consistent low-latency streaming and a single connection point for both modalities.

### Data Persistence

**Amazon RDS PostgreSQL 16** (encrypted at rest) stores all application data. Three RDS Proxy instances (user, table creator, admin) pool connections. The `pgvector` extension enables semantic similarity search on document embeddings.

**Amazon DynamoDB** serves two roles in the system:

1. **LangChain conversation history** — The `DynamoDBChatMessageHistory` table stores the rolling message context fed into each LLM call. Both the text generation Lambda and the voice agent read/write here so the AI maintains conversational continuity across turns. Items are keyed by `SessionId` (the chat UUID).

2. **Embedding cache** — Key question embeddings, DTP embeddings, and recommendation embeddings are cached in DynamoDB (keyed by `QCACHE#{session_id}`, `DTPCACHE#{group}#{persona}`, `RECCACHE#{group}#{persona}`) to avoid redundant Cohere API calls. Embeddings are computed once on the first student message or conclude action and reused for all subsequent semantic matching within that session.

### Object Storage

Amazon S3 stores uploaded persona documents (PDFs) and generated embeddings. Pre-signed URLs provide secure, time-limited access for uploads and downloads.

### AI Services

Amazon Bedrock provides LLM inference (Claude Sonnet 5.5 via cross-region inference profile `us.anthropic.claude-sonnet-5-5`), text embeddings (Cohere Embed v4 `cohere.embed-v4:0`) and voice interactions (Nova Sonic 2.0). All model calls route to `us-east-1` regardless of deployment region.

A Docker Lambda (`text_generation`) handles chat, debrief generation, and semantic question matching via LangChain. A separate Docker Lambda (`data_ingestion`) processes uploaded PDFs into vector embeddings. See [Data Ingestion](./DATA_INGESTION.md) for pipeline details.

### Voice Agent

The voice pipeline uses Amazon Bedrock AgentCore to host a containerized voice agent (`cdk/voice-agent/bot.py`). The ECS Socket.IO server connects to AgentCore via a SigV4-authenticated WebSocket, relaying audio frames between the frontend and the voice agent. The voice agent container uses Nova Sonic 2.0's bidirectional streaming API for real-time speech-to-speech interaction.

 See the [Voice Agent Deep Dive](./VOICE_AGENT_DEEP_DIVE.md) for design decision context.

### CI/CD Pipeline

AWS CodePipeline triggers on GitHub pushes. CodeBuild projects build Docker images for each service module, push to ECR, run vulnerability scans, and update Lambda function code. Amplify handles frontend CI/CD independently.

## Data Flow Diagrams

### Text Chat Flow

```mermaid
sequenceDiagram
    participant Student as Student (Browser)
    participant CF as CloudFront
    participant ECS as Socket.IO Server (ECS)
    participant TG as Text Generation Lambda
    participant DDB as DynamoDB
    participant Bedrock as Amazon Bedrock
    participant RDS as PostgreSQL (RDS)

    Student->>CF: WebSocket connect
    CF->>ECS: Forward connection
    Student->>ECS: Send message (Socket.IO event)
    ECS->>TG: Invoke text generation
    TG->>RDS: Store student message
    TG->>DDB: Load conversation history
    TG->>RDS: Fetch persona context (RAG)
    TG->>Bedrock: LLM inference (streaming)
    Bedrock-->>TG: Token stream
    TG-->>ECS: Stream tokens (POST /stream-callback)
    ECS-->>Student: Emit tokens (Socket.IO)
    TG->>RDS: Store AI response
    TG->>DDB: Save AI message to history
```

### Voice Interaction Flow

```mermaid
sequenceDiagram
    participant Student as Student (Browser)
    participant CF as CloudFront
    participant ECS as Socket.IO Server (ECS)
    participant AC as AgentCore (Voice Agent)
    participant Bedrock as Nova Sonic 2.0

    Student->>CF: WebSocket connect
    CF->>ECS: Forward connection
    Student->>ECS: Audio frames (Socket.IO)
    ECS->>AC: SigV4 WebSocket relay
    AC->>Bedrock: Bidirectional audio stream
    Bedrock-->>AC: Speech response stream
    AC-->>ECS: Audio frames
    ECS-->>Student: Audio frames (Socket.IO)
```

### Document Ingestion Flow

```mermaid
sequenceDiagram
    participant Instructor as Instructor
    participant API as API Gateway
    participant S3 as S3 Bucket
    participant DI as Data Ingestion Lambda
    participant Bedrock as Bedrock (Cohere Embed)
    participant RDS as PostgreSQL (pgvector)

    Instructor->>API: Upload PDF (pre-signed URL)
    API->>S3: Store document
    S3->>DI: Trigger ingestion
    DI->>S3: Fetch document
    DI->>DI: Extract text (PyMuPDF)
    DI->>Bedrock: Generate embeddings
    Bedrock-->>DI: Vector embeddings
    DI->>RDS: Store in pgvector
```

## Semantic Matching

The platform uses embedding-based cosine similarity to evaluate student performance in real time. There are three types of semantic matching, all implemented in `cdk/text_generation/src/helpers/chat.py`.

### Key Question Matching (Real-Time, Per-Message)

Every time a student sends a message (text or voice), the text generation Lambda scores it against the session's key questions:

1. **Intent decomposition** — If the message has >12 words, the AI decomposes it into individual clinical intents (max 5). Short messages are used as-is.
2. **Batch embedding** — All intents are embedded in a single Cohere Embed v4 call (`embed_symmetric` mode).
3. **Cosine similarity** — Each intent embedding is compared against all cached key question embeddings.
4. **Tier classification** — Matches are classified based on the configurable `key_question_threshold` (default: 0.55):

| Tier | Score Range | Meaning |
|------|-------------|---------|
| **high** | ≥ threshold (default ≥ 0.55) | Confidently addressed |
| **moderate** | ≥ threshold − 0.10 (default ≥ 0.45) | Likely addressed |
| **low** | ≥ threshold − 0.25 (default ≥ 0.30) | Logged but NOT counted as "addressed" in debrief |
| discarded | < threshold − 0.25 | Ignored |

5. **Best-match-per-question** — If multiple intents match the same question, only the highest score is kept.
6. **Persist** — The `matched_question_ids` JSONB column on the `messages` table is updated with the match results.

> **Critical:** Matching runs **synchronously** before returning 200 OK. AWS Lambda freezes execution on response, so async threads cannot reliably complete DB writes. This was the root cause of 0% debrief scores in the async implementation.

### DTP Matching (At Conclude Time)

When a student submits their Drug Therapy Problem recommendations:

1. **Batch-embed student DTPs** — One Cohere API call for all student-submitted DTP texts.
2. **Use pre-cached instructor embeddings** — Instructor-defined expected DTPs are cached in DynamoDB (`DTPCACHE#{group}#{persona}`) on first access.
3. **Clinical contradiction filtering** — Before scoring, pairs containing opposing clinical actions (e.g., "continue naproxen" vs "discontinue naproxen") are excluded. 16+ medical action antonym pairs are checked.
4. **Greedy one-to-one assignment** — Score matrix is sorted descending; each student/instructor item can only be matched once. Threshold: configurable `dtp_threshold` (default: 0.55).
5. **Categorize results** — Returns `matched`, `missed` (instructor items unmatched), and `additional` (student items unmatched).

### Recommendation Matching (At Conclude Time)

Same algorithm as DTP matching but for recommendation text. Rationale is NOT used for matching — it is evaluated separately only for matched pairs. Uses configurable `recommendation_threshold` (default: 0.55).

### Configurable Thresholds

Thresholds are configurable per organization via the admin console:

| Threshold | Default | Controls |
|-----------|---------|----------|
| `key_question_threshold` | 0.55 | Minimum score for "high" confidence tier in real-time matching |
| `dtp_threshold` | 0.55 | Minimum score for DTP greedy assignment |
| `recommendation_threshold` | 0.55 | Minimum score for recommendation greedy assignment |

Stored as nullable `NUMERIC(5,4)` columns on the `organizations` table. NULL = use default (0.55). Thresholds are resolved by looking up the organization via `simulation_group_id → simulation_groups.organization_id`.

### Embedding Cache Strategy

| Cache Key | Scope | Created When | TTL |
|-----------|-------|--------------|-----|
| `QCACHE#{session_id}` | Per chat session | First student message | 7 days |
| `DTPCACHE#{group}#{persona}` | Per group+persona | First conclude action | 7 days |
| `RECCACHE#{group}#{persona}` | Per group+persona | First conclude action | 7 days |

Embeddings are stored as binary-packed float arrays in DynamoDB. The cache includes a version field to detect stale embeddings from old embedding models — stale caches are ignored (matching skips gracefully).

### Key Functions

| Function | Purpose |
|----------|---------|
| `match_message_to_questions()` | Main key question matching: decompose → embed → compare → tier → persist |
| `match_submissions()` | Generic DTP/recommendation matcher: batch embed students, greedy assign against cached instructor items |
| `decompose_message_intents()` | Claude-based intent splitting for multi-part messages |
| `compute_cosine_similarity()` | Pure math cosine similarity, handles zero-vectors |
| `greedy_match_assignment()` | One-to-one assignment: sort by score desc, threshold-filter |
| `are_clinically_contradictory()` | Checks for antonym pairs to prevent false matches |
| `cache_key_questions()` | Fetches key questions from DB, embeds, stores in DynamoDB |

## Database Schema

![Database Schema](./dbschema.png)

The database runs PostgreSQL 16 with the `uuid-ossp` and `vector` (pgvector) extensions enabled. All primary keys are UUIDs generated by `uuid_generate_v4()`.

### organizations

Top-level grouping for institutions (universities, programs).

| Column | Type | Description |
|--------|------|-------------|
| organization_id | uuid (PK) | Unique identifier |
| name | varchar | Organization name |
| type | varchar | Organization type |
| created_at | timestamp | Creation timestamp |
| description | text | Organization description |
| ai_persona | varchar | Display label for AI characters (default: 'Patient') |
| user_role | varchar | Display label for users (default: 'Student') |
| icon_color | varchar | Brand color for UI (default: '#03045E') |
| system_prompt | text | Organization-level default system prompt |

### users

User accounts with roles and organization affiliation.

| Column | Type | Description |
|--------|------|-------------|
| user_id | uuid (PK) | Unique identifier |
| organization_id | uuid (FK → organizations) | Organization membership |
| user_email | varchar (UNIQUE) | Login email |
| first_name | varchar | First name |
| last_name | varchar | Last name |
| time_account_created | timestamptz | Account creation time |
| roles | varchar[] | Role array (default: ['student']) |
| last_sign_in | timestamptz | Last login timestamp |
| username | varchar | Display username |

### simulation_groups

Instructor-created scenarios containing patient personas and enrolled students.

| Column | Type | Description |
|--------|------|-------------|
| simulation_group_id | uuid (PK) | Unique identifier |
| organization_id | uuid (FK → organizations) | Parent organization |
| created_by | uuid (FK → users) | Instructor who created the group |
| group_name | varchar | Display name |
| group_description | varchar | Description text |
| group_access_code | varchar | Code students use to join |
| group_student_access | boolean | Whether students can currently access |
| system_prompt | text | System prompt for AI interactions |
| instructor_voice_enabled | boolean | Whether voice is enabled (default: true) |
| debrief_prompt | text | Custom debrief evaluation prompt |
| max_messages_per_chat | integer | Per-chat message limit (NULL = unlimited) |

### group_instructors

Mapping of instructors to simulation groups (many-to-many).

| Column | Type | Description |
|--------|------|-------------|
| group_instructor_id | uuid (PK) | Unique identifier |
| simulation_group_id | uuid (FK → simulation_groups) | Group reference |
| user_id | uuid (FK → users) | Instructor reference |
| added_by | uuid (FK → users) | Who added this instructor |
| added_at | timestamp | When the instructor was added |

Constraints: UNIQUE(simulation_group_id, user_id)

### personas

AI patient characters within simulation groups.

| Column | Type | Description |
|--------|------|-------------|
| persona_id | uuid (PK) | Unique identifier |
| simulation_group_id | uuid (FK → simulation_groups) | Parent group |
| persona_name | varchar | Character name |
| persona_age | integer | Character age |
| persona_gender | varchar | Character gender |
| persona_number | integer | Display order number |
| persona_prompt | text | Character-specific prompt |
| average_wpm | integer | Speech rate for voice |
| voice_id | varchar | TTS voice identifier (default: 'tiffany') |
| interaction_mode | varchar | Interaction mode setting |
| llm_completion | boolean | Whether LLM completion is enabled |
| voice_enabled | boolean | Whether voice is enabled for this persona (default: true) |

### persona_media

Media files (images, documents) associated with personas.

| Column | Type | Description |
|--------|------|-------------|
| media_id | uuid (PK) | Unique identifier |
| persona_id | uuid (FK → personas) | Parent persona |
| media_type | varchar | File type (e.g., 'image', 'document') |
| url | varchar | Storage URL |
| title | varchar | Display title |
| description | text | Description |
| created_at | timestamp | Upload timestamp |

### persona_data

Uploaded knowledge base files (PDFs) ingested into the vector store.

| Column | Type | Description |
|--------|------|-------------|
| file_id | uuid (PK) | Unique identifier |
| persona_id | uuid (FK → personas) | Parent persona |
| filetype | varchar | File extension/type |
| s3_bucket_reference | varchar | S3 bucket name |
| filepath | varchar | S3 object key |
| filename | varchar | Original filename |
| time_uploaded | timestamp | Upload timestamp |
| metadata | text | Extracted metadata |
| file_number | integer | Display order |
| ingestion_status | varchar(20) | Processing status (default: 'not processing') |
| display_name | varchar | User-facing file name |

### rubrics

Assessment rubrics for simulation groups/personas.

| Column | Type | Description |
|--------|------|-------------|
| rubric_id | uuid (PK) | Unique identifier |
| simulation_group_id | uuid (FK → simulation_groups) | Parent group |
| persona_id | uuid (FK → personas) | Associated persona |
| name | varchar | Rubric name |
| description | text | Rubric description |
| created_at | timestamp | Creation timestamp |

### key_questions

Assessment questions within rubrics (legacy — superseded by question_bank).

| Column | Type | Description |
|--------|------|-------------|
| question_id | uuid (PK) | Unique identifier |
| rubric_id | uuid (FK → rubrics) | Parent rubric |
| question_text | text | Question content |
| category | varchar | Question category |
| order | integer | Display order |
| weight | float | Scoring weight |
| max_score | integer | Maximum possible score |

### enrollments

Student enrollment in simulation groups.

| Column | Type | Description |
|--------|------|-------------|
| enrollment_id | uuid (PK) | Unique identifier |
| user_id | uuid (FK → users) | Student reference |
| simulation_group_id | uuid (FK → simulation_groups) | Group reference |
| enrollment_type | varchar | Type of enrollment |
| group_completion_percentage | integer | Progress percentage |
| time_enrolled | timestamp | Enrollment timestamp |

Constraints: UNIQUE(simulation_group_id, user_id)

### student_interactions

Per-persona interaction session for a student within an enrollment.

| Column | Type | Description |
|--------|------|-------------|
| student_interaction_id | uuid (PK) | Unique identifier |
| persona_id | uuid (FK → personas) | Persona being interacted with |
| enrollment_id | uuid (FK → enrollments) | Parent enrollment |
| persona_score | integer | Aggregate score for this persona |
| last_accessed | timestamp | Last activity timestamp |
| persona_context_embedding | float[] | Vector embedding of interaction context |
| is_completed | boolean | Whether the interaction is complete (default: false) |

Constraints: UNIQUE(persona_id, enrollment_id)

### chats

Individual chat sessions between a student and an AI persona.

| Column | Type | Description |
|--------|------|-------------|
| chat_id | uuid (PK) | Unique identifier |
| student_interaction_id | uuid (FK → student_interactions) | Parent interaction |
| chat_name | varchar | Display name |
| chat_context_embeddings | float[] | Vector embedding of chat context |
| last_accessed | timestamp | Last activity timestamp |
| notes | text | Student notes |
| started_at | timestamptz | Session start time |
| ended_at | timestamptz | Session end time |
| status | varchar | Session status: 'active', 'concluded', or 'expired' |
| recommendation | text | Student's recommendation submitted on conclude |
| dtp_submission | jsonb | Array of DTP strings submitted by the student |
| recommendation_submission | jsonb | Array of {recommendation, rationale} objects submitted on conclude |

### messages

Individual messages within a chat session.

| Column | Type | Description |
|--------|------|-------------|
| message_id | uuid (PK) | Unique identifier |
| chat_id | uuid (FK → chats) | Parent chat |
| sender_type | varchar | Who sent: 'student', 'ai', or 'system' |
| user_id | uuid | Sender's user ID |
| message_content | text | Message body |
| sent_at | timestamptz | When the message was sent |
| matched_question_ids | jsonb | Array of {question_id, similarity_score} matches |

### debriefs

AI-generated evaluations of student chat performance.

| Column | Type | Description |
|--------|------|-------------|
| debrief_id | uuid (PK) | Unique identifier |
| chat_id | uuid (FK → chats, UNIQUE) | One debrief per chat |
| generated_text | text | Full debrief JSON output |
| missing_key_questions | jsonb | Questions the student missed |
| reasoning_gaps | text | Identified reasoning gaps |
| rubric_scores | jsonb | Per-rubric scoring data |
| created_at | timestamp | Generation timestamp |
| student_id | uuid (FK → users) | Student who was evaluated |
| persona_id | uuid (FK → personas) | Persona in the interaction |
| simulation_group_id | uuid (FK → simulation_groups) | Parent group |
| total_questions_assigned | integer | Number of questions assigned |
| total_questions_asked | integer | Number of questions addressed |
| total_questions_missed | integer | Number of questions missed |
| overall_score | float | Aggregate score (0.0–100.0) |

### feedback

Student feedback on chat sessions (legacy).

| Column | Type | Description |
|--------|------|-------------|
| feedback_id | uuid (PK) | Unique identifier |
| chat_id | uuid (FK → chats) | Related chat |
| score | integer | Feedback score |
| analysis | text | Feedback analysis text |
| areas_for_improvement | varchar[] | Improvement suggestions |
| submitted_at | timestamp | Submission timestamp |

### user_engagement_log

Audit trail of user engagement events.

| Column | Type | Description |
|--------|------|-------------|
| log_id | uuid (PK) | Unique identifier |
| user_id | uuid (FK → users) | User who performed the action |
| simulation_group_id | uuid (FK → simulation_groups) | Related group |
| persona_id | uuid (FK → personas) | Related persona |
| enrollment_id | uuid (FK → enrollments) | Related enrollment |
| timestamp | timestamp | Event timestamp |
| engagement_type | varchar | Type of engagement event |
| engagement_details | text | Event details |

### system_prompt_history

History of the platform-wide system prompt used by the voice engines (`socket-server` and `voice-agent`). Only global admins write it, through `/admin/update_system_prompt` and `/admin/restore_system_prompt`. The newest row with `organization_id IS NULL` is the active prompt. Text chat uses each simulation group's own `simulation_groups.system_prompt` instead.

| Column | Type | Description |
|--------|------|-------------|
| history_id | uuid (PK) | Unique identifier |
| modified_by | uuid (FK → users) | Admin who made the change |
| organization_id | uuid (FK → organizations) | Reserved. Always NULL (platform-wide); every reader filters on `organization_id IS NULL`. Must be written and filtered per organization before organization-scoped admins can edit prompts |
| prompt_content | text | Prompt content at time of change |
| created_at | timestamp | Change timestamp |

### question_bank

Organization-scoped repository of assessment questions.

| Column | Type | Description |
|--------|------|-------------|
| question_id | uuid (PK) | Unique identifier |
| organization_id | uuid (FK → organizations) | Parent organization |
| created_by | uuid (FK → users) | Creator |
| title | varchar(255) | Question title |
| question_text | text | Full question content |
| evaluation_criteria | text | How to evaluate student responses |
| category | varchar(100) | Question category |
| difficulty_level | varchar(50) | Difficulty level |
| is_mandatory | boolean | Whether the question must be asked (default: false) |
| weight | float | Scoring weight (default: 1.0) |
| max_score | integer | Maximum score (default: 100) |
| is_active | boolean | Soft-delete flag (default: true) |
| created_at | timestamp | Creation timestamp |
| tags | varchar[] | Flexible categorization tags (default: '{}') |

### simulation_group_questions

Links questions from the bank to specific simulation groups, with optional persona-level specificity.

| Column | Type | Description |
|--------|------|-------------|
| group_question_id | uuid (PK) | Unique identifier |
| simulation_group_id | uuid (FK → simulation_groups) | Target group |
| persona_id | uuid (FK → personas) | Target persona (NULL = group-level) |
| question_id | uuid (FK → question_bank) | Question reference |
| weight_override | float | Override the question's default weight |
| max_score_override | integer | Override the question's default max score |
| order | integer | Display/evaluation order (default: 0) |
| added_by | uuid (FK → users) | Who assigned the question |
| added_at | timestamp | Assignment timestamp |

Constraints: UNIQUE(simulation_group_id, persona_id, question_id)

### question_interactions

Per-question tracking of student interactions during chat.

| Column | Type | Description |
|--------|------|-------------|
| interaction_id | uuid (PK) | Unique identifier |
| chat_id | uuid (FK → chats) | Related chat session |
| question_id | uuid (FK → question_bank) | Question being tracked |
| student_id | uuid (FK → users) | Student |
| persona_id | uuid (FK → personas) | Persona in the interaction |
| simulation_group_id | uuid (FK → simulation_groups) | Parent group |
| was_asked | boolean | Whether the student asked this question (default: false) |
| is_correct | boolean | Whether the response was correct |
| message_id | uuid | Message that triggered the match |
| quality_score | integer | Quality assessment score |
| quality_feedback | text | Quality assessment feedback |
| semantic_similarity_score | float | Cosine similarity score |
| asked_at | timestamp | When the question was asked |
| time_to_ask_seconds | integer | Time from chat start to asking |
| attempt_number | integer | Which attempt (default: 1) |
| created_at | timestamp | Record creation timestamp |
| updated_at | timestamp | Last update timestamp |

### debrief_prompt_history

Audit trail of debrief prompt changes per simulation group.

| Column | Type | Description |
|--------|------|-------------|
| history_id | uuid (PK) | Unique identifier |
| modified_by | uuid (FK → users) | User who made the change |
| simulation_group_id | uuid (FK → simulation_groups) | Group reference |
| prompt_content | text | Prompt content at time of change |
| created_at | timestamp | Change timestamp |

### debrief_feedback

Student feedback on debrief quality (thumbs up/down with optional comment).

| Column | Type | Description |
|--------|------|-------------|
| feedback_id | uuid (PK) | Unique identifier |
| simulation_group_id | uuid (FK → simulation_groups) | Group context |
| persona_id | uuid (FK → personas) | Persona context |
| chat_id | uuid (FK → chats) | Related chat |
| user_id | uuid (FK → users) | Student who submitted |
| is_helpful | boolean | Whether the debrief was helpful |
| comment | text | Optional comment |
| submitted_at | timestamptz | Submission timestamp |

### issue_reports

Student-submitted issue/bug reports during simulations.

| Column | Type | Description |
|--------|------|-------------|
| report_id | uuid (PK) | Unique identifier |
| simulation_group_id | uuid (FK → simulation_groups) | Group context |
| persona_id | uuid (FK → personas) | Persona context |
| chat_id | uuid (FK → chats) | Related chat |
| user_id | uuid (FK → users) | Reporter |
| issue_categories | varchar[] | Category tags for the issue |
| details | text | Issue description |
| submitted_at | timestamptz | Submission timestamp |

### dtp_bank

Organization-scoped Drug Therapy Problem repository.

| Column | Type | Description |
|--------|------|-------------|
| dtp_id | uuid (PK) | Unique identifier |
| organization_id | uuid (FK → organizations) | Parent organization |
| created_by | uuid (FK → users) | Creator |
| title | varchar(255) | DTP title |
| expected_dtp_text | text | Expected DTP text for matching |
| clinical_intent | text | Clinical intent description |
| evaluation_criteria | text | How to evaluate student responses |
| tags | text[] | Categorization tags (default: '{}') |
| is_required | boolean | Whether this DTP is required (default: false) |
| is_active | boolean | Soft-delete flag (default: true) |
| created_at | timestamp | Creation timestamp |

### recommendations_bank

Organization-scoped Recommendation repository.

| Column | Type | Description |
|--------|------|-------------|
| recommendation_id | uuid (PK) | Unique identifier |
| organization_id | uuid (FK → organizations) | Parent organization |
| created_by | uuid (FK → users) | Creator |
| title | varchar(255) | Recommendation title |
| recommendation_text | text | Expected recommendation text for matching |
| evaluation_criteria | text | How to evaluate student responses |
| rationale | text | Expected rationale for the recommendation |
| is_active | boolean | Soft-delete flag (default: true) |
| created_at | timestamp | Creation timestamp |

### simulation_group_dtps

Links DTP items from the bank to specific simulation groups, with optional persona-level specificity.

| Column | Type | Description |
|--------|------|-------------|
| group_dtp_id | uuid (PK) | Unique identifier |
| simulation_group_id | uuid (FK → simulation_groups) | Target group |
| persona_id | uuid (FK → personas) | Target persona (NULL = group-level) |
| dtp_id | uuid (FK → dtp_bank) | DTP reference |
| sort_order | integer | Display/evaluation order (default: 0) |
| added_by | uuid (FK → users) | Who assigned the DTP |
| added_at | timestamp | Assignment timestamp |

Constraints: UNIQUE(simulation_group_id, persona_id, dtp_id)

### simulation_group_recommendations

Links Recommendation items from the bank to specific simulation groups, with optional persona-level specificity.

| Column | Type | Description |
|--------|------|-------------|
| group_recommendation_id | uuid (PK) | Unique identifier |
| simulation_group_id | uuid (FK → simulation_groups) | Target group |
| persona_id | uuid (FK → personas) | Target persona (NULL = group-level) |
| recommendation_id | uuid (FK → recommendations_bank) | Recommendation reference |
| sort_order | integer | Display/evaluation order (default: 0) |
| added_by | uuid (FK → users) | Who assigned the recommendation |
| added_at | timestamp | Assignment timestamp |

Constraints: UNIQUE(simulation_group_id, persona_id, recommendation_id)

## Entity Relationships

```text
organizations (1) ──── (N) users
organizations (1) ──── (N) simulation_groups
organizations (1) ──── (N) question_bank
organizations (1) ──── (N) dtp_bank
organizations (1) ──── (N) recommendations_bank

simulation_groups (1) ──── (N) personas
simulation_groups (1) ──── (N) enrollments
simulation_groups (1) ──── (N) group_instructors
simulation_groups (1) ──── (N) simulation_group_questions
simulation_groups (1) ──── (N) simulation_group_dtps
simulation_groups (1) ──── (N) simulation_group_recommendations

personas (1) ──── (N) persona_data
personas (1) ──── (N) persona_media

enrollments (1) ──── (N) student_interactions
student_interactions (1) ──── (N) chats

chats (1) ──── (N) messages
chats (1) ──── (1) debriefs

question_bank (1) ──── (N) simulation_group_questions
question_bank (1) ──── (N) question_interactions

dtp_bank (1) ──── (N) simulation_group_dtps
recommendations_bank (1) ──── (N) simulation_group_recommendations
```

## Cross-References

- [Voice Agent Deep Dive](./VOICE_AGENT_DEEP_DIVE.md) — Voice architecture and design decisions
- [Data Ingestion](./DATA_INGESTION.md) — Document processing pipeline and vector store
- [Deployment Guide](./DEPLOYMENT_GUIDE.md) — Full deployment from scratch
