# Patient Interaction Practice Tool REST API Documentation

## Table of Contents

- [Authentication](#authentication)
- [Base URL](#base-url)
- [Common Headers](#common-headers)
- [Error Responses](#error-responses)
- [Student Endpoints](#student-endpoints)
  - [User Management](#user-management)
  - [Simulation Groups](#simulation-groups)
  - [Session Management](#session-management)
  - [Messaging](#messaging)
  - [Notes](#notes)
  - [AI Text Generation & Debrief](#ai-text-generation--debrief)
  - [Scoring & Completion](#scoring--completion)
  - [Feedback & Reporting](#feedback--reporting)
  - [Files & Media](#files--media)
  - [Voice & Context](#voice--context)
  - [Empathy Summary](#empathy-summary)
- [Instructor Endpoints](#instructor-endpoints)
  - [Group Management](#group-management)
  - [Patient Management](#patient-management)
  - [Student Management](#student-management)
  - [Prompt Management](#prompt-management)
  - [Analytics & Reporting](#analytics--reporting)
  - [File & Metadata Management](#file--metadata-management)
  - [Question Bank & Assessment](#question-bank--assessment)
  - [DTP Assignments](#dtp-assignments)
  - [Recommendation Assignments](#recommendation-assignments)
  - [Physical Assessment Materials](#physical-assessment-materials)
  - [Student Progress & Sessions](#student-progress--sessions)
- [Admin Endpoints](#admin-endpoints)
  - [Instructor Management](#instructor-management)
  - [Simulation Group Management (Admin)](#simulation-group-management-admin)
  - [System Prompts](#system-prompts)
  - [Empathy Prompts](#empathy-prompts)
  - [Organization Management](#organization-management)
  - [Question Bank (Admin)](#question-bank-admin)
  - [DTP Bank (Admin)](#dtp-bank-admin)
  - [Recommendations Bank (Admin)](#recommendations-bank-admin)
  - [Issue Reports & Feedback (Admin)](#issue-reports--feedback-admin)
  - [Message Limits](#message-limits)

---

## Authentication

All endpoints require AWS Cognito JWT tokens passed via the `Authorization` header.

```javascript
import { fetchAuthSession } from 'aws-amplify/auth';

const session = await fetchAuthSession();
const token = session.tokens?.idToken?.toString();
```

### Authorization Levels

| Authorizer | Role Required | Prefix |
|---|---|---|
| `studentAuthorizer` | Student | `/student/*` |
| `instructorAuthorizer` | Instructor | `/instructor/*` |
| `adminAuthorizer` | Admin | `/admin/*` |

**Important:** Roles are NOT hierarchical. Having `admin` does NOT grant access to `/instructor/*` or `/student/*` endpoints. Each role's endpoints require the corresponding authorizer.

### Email Validation (Security)

All Lambda handlers extract the authenticated user's email from the JWT token (`event.requestContext.authorizer.email`). If any email-based query parameter (`email`, `student_email`, `user_email`, `instructor_email`) is provided, it is validated against the token email. A mismatch results in a **401 Unauthorized** response.

When no email query parameter is provided, the handler automatically uses the token email. This prevents users from accessing other users' data by spoofing email parameters.

### Role Enforcement (Database as Source of Truth)

Beyond the API Gateway authorizer (JWT validation), backend handlers perform a secondary role check against the database:

- **Instructor endpoints** verify the authenticated user has `instructor` or `admin` in their DB `roles` array. If not, the request is rejected with **403 Forbidden**.
- **Admin endpoints** verify the authenticated user has `admin` in their DB `roles` array. Token claims (including `cognito:groups`) are never used for authorization. The first admin is created with the `bootstrapAdmin` Lambda (see the Deployment Guide).

### CORS Origin Restriction

Lambda responses use a configurable allowlist-based CORS policy via the `ALLOWED_ORIGINS` environment variable (comma-separated list). The CDK stack (`cdk/lib/api-service-stack.ts`) sets it to exact origins only: the deployed Amplify branch, the `SesVerifiedDomain` origins when set, plus any extras passed with `-c AllowedOrigins="https://a.example.com,https://b.example.com"`. Wildcards are rejected at synth time, because a pattern like `https://*.amplifyapp.com` would trust any other tenant's Amplify app. The Vite dev origins (`http://localhost:5173`, `:5174`) are only added with `-c AllowLocalhostOrigins=true`, which is meant for dev deployments.

The CORS helpers still understand `*` subdomain patterns and an explicit `*` entry, but the stack no longer emits them. If `ALLOWED_ORIGINS` is unset or empty, the helpers fail closed.

Gateway error responses and the `OPTIONS` mock integrations still return `Access-Control-Allow-Origin: *`, because API Gateway can't pick one origin from a list there. This is safe because the API authenticates with a bearer token, never cookies. Gateway errors return fixed messages (`Unauthorized`, `Request rejected`, ...) rather than `$context.error.messageString`.

### WAF Body Rules

The API WAF (`cdk/lib/api-service-stack.ts`) runs the managed `SizeRestrictions_BODY`, `CrossSiteScripting_BODY` and `GenericLFI_BODY` rules in Count mode and adds two custom rules in Block mode:

- `BlockOversizedBody`: REST API bodies over 64 KB get a 403. The body inspection limit is raised to 64 KB. AppSync (`/graphql`) is excluded.
- `BlockXssBody`: XSS patterns in the body get a 403 on every path except `*/instructor/persona_media` (instructor `<iframe>` embed codes, sanitized on render) and AppSync.

### Frontend Security Headers

The Amplify app sends HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` and a Content Security Policy (`cdk/lib/security-headers.ts`). By default the CSP is sent as `Content-Security-Policy-Report-Only`. Once the browser checks in `cdk/scripts/smoke-security-defaults.ps1` show no violations, deploy the Amplify stack with `-c CspEnforce=true` to enforce it. If you add a new embed provider to `ALLOWED_IFRAME_DOMAINS` in `frontend/src/lib/embedSafety.ts`, add it to `FRONTEND_IFRAME_DOMAINS` in `security-headers.ts` too. A unit test fails if the two lists differ.

### Shared Endpoints

The following endpoints are accessible to any authenticated user regardless of role:

- `GET /student/me` — Get current user profile and roles (uses token email directly, no query param needed)
- `GET /student/get_user_roles` — Get available roles for user
- `POST /student/create_user` — Create/update user profile on first sign-in

---

## Base URL

```
https://api-id.execute-api.us-east-1.amazonaws.com/prod
```

---

## Common Headers

```
Authorization: eyJraWQiOiJ...
Content-Type: application/json
```

---

## Error Responses

| Status Code | Description |
|---|---|
| 400 | Bad Request — Missing or invalid parameters |
| 401 | Unauthorized — Invalid or missing JWT token, or email query parameter does not match the authenticated token email |
| 403 | Forbidden — Access denied; authenticated user lacks the required role in the database, or does not own the requested resource |
| 404 | Not Found — Resource does not exist |
| 429 | Too Many Requests — Rate limit exceeded |
| 500 | Internal Server Error |

Error response body format:

```json
{
  "error": "Description of what went wrong"
}
```


---

# Student Endpoints

All student endpoints require the `studentAuthorizer`. The authenticated user's email is extracted from the JWT token and used as the source of truth. If an email-based query parameter is provided, it must match the token email or a **401 Unauthorized** is returned. When omitted, the token email is used automatically.

## User Management

### Create User

Create a new user profile or update an existing one on sign-in.

**Endpoint:** `POST /student/create_user`

**Query Parameters:**

- `user_email` (string, optional): Email of the user
- `username` (string, optional): Username
- `first_name` (string, optional): First name
- `last_name` (string, optional): Last name

**Response:**

```json
{
  "user_id": "uuid",
  "user_email": "student@example.com",
  "username": "jdoe",
  "first_name": "Jane",
  "last_name": "Doe",
  "roles": ["student"],
  "time_account_created": "2024-01-15T10:30:00.000Z",
  "last_sign_in": "2024-06-01T08:00:00.000Z"
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/create_user?user_email=student@example.com&username=jdoe&first_name=Jane&last_name=Doe" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json"
```

---

### Get Current User Profile

Get the authenticated user's profile including roles. Uses the email from the JWT token directly — no query parameters needed.

**Endpoint:** `GET /student/me`

**Response:**

```json
{
  "user_email": "student@example.com",
  "first_name": "Jane",
  "last_name": "Doe",
  "roles": ["student"],
  "organization_id": "uuid"
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/me" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get User Roles

Get the roles assigned to the authenticated user. Prefers the token email; falls back to the query parameter for backwards compatibility.

**Endpoint:** `GET /student/get_user_roles`

**Query Parameters:**

- `user_email` (string, optional): Email of the user (must match token email if provided; token email used if omitted)

**Response:**

```json
{
  "roles": ["student", "instructor"]
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/get_user_roles?user_email=student@example.com" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get User Name

Get the first name of the authenticated user. Prefers the token email; falls back to the query parameter for backwards compatibility.

**Endpoint:** `GET /student/get_name`

**Query Parameters:**

- `user_email` (string, optional): Email of the user (must match token email if provided; token email used if omitted)

**Response:**

```json
{
  "name": "Jane"
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/get_name?user_email=student@example.com" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Simulation Groups

### Get Enrolled Simulation Groups

Get all simulation groups the student is enrolled in.

**Endpoint:** `GET /student/simulation_group`

**Query Parameters:**

- `email` (string, optional): Email of the student (must match token email if provided; token email used if omitted)

**Response:**

```json
[
  {
    "simulation_group_id": "uuid",
    "group_name": "Pharmacy 101 - Fall 2024",
    "group_description": "Introductory pharmacy simulation",
    "group_access_code": "ABC123",
    "group_student_access": true
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/simulation_group?email=student@example.com" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Simulation Group Page

Get detailed simulation group page with all patient personas and student engagement data.

**Endpoint:** `GET /student/simulation_group_page`

**Query Parameters:**

- `email` (string, optional): Email of the student (must match token email if provided; token email used if omitted)
- `simulation_group_id` (string, required): ID of the group

**Response:**

```json
[
  {
    "persona_id": "uuid",
    "persona_name": "Maria Garcia",
    "persona_age": 45,
    "persona_gender": "Female",
    "persona_number": 1,
    "llm_completion": true,
    "voice_enabled": true,
    "persona_score": 80,
    "last_accessed": "2024-05-20T14:30:00.000Z",
    "has_dtps": true,
    "has_recommendations": true,
    "mode": "chat"
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/simulation_group_page?email=student@example.com&simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Enroll Student

Enroll a student in a simulation group using an access code.

**Endpoint:** `POST /student/enroll_student`

**Query Parameters:**

- `student_email` (string, optional): Email of the student to enroll (must match token email if provided; token email used if omitted)
- `group_access_code` (string, required): Access code of the group

**Response:**

```json
{
  "message": "Student enrolled successfully."
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/enroll_student?student_email=student@example.com&group_access_code=ABC123" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json"
```

---

## Session Management

### Get Patient Sessions

Get all sessions for a specific patient accessed by a student.

**Endpoint:** `GET /student/patient`

**Query Parameters:**

- `email` (string, optional): Email of the student (must match token email if provided; token email used if omitted)
- `simulation_group_id` (string, required): ID of the group
- `patient_id` (string, required): ID of the patient

**Response:**

```json
[
  {
    "chat_id": "uuid",
    "chat_name": "Session 1",
    "created_at": "2024-05-15T09:00:00.000Z",
    "last_accessed": "2024-05-15T10:30:00.000Z",
    "is_ended": false,
    "overall_score": 85
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/patient?email=student@example.com&simulation_group_id=uuid&patient_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Create Session

Create a new chat session with a patient.

**Endpoint:** `POST /student/create_session`

**Query Parameters:**

- `patient_id` (string, required): ID of the patient
- `email` (string, optional): Email of the student (must match token email if provided; token email used if omitted)
- `simulation_group_id` (string, required): ID of the group
- `session_name` (string, required): Name of the session

**Response:**

```json
{
  "chat_id": "uuid",
  "student_interaction_id": "uuid",
  "chat_name": "Session 1",
  "created_at": "2024-05-15T09:00:00.000Z"
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/create_session?patient_id=uuid&email=student@example.com&simulation_group_id=uuid&session_name=Session%201" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json"
```

---

### Delete Session

Delete a session for a student interaction.

**Endpoint:** `DELETE /student/delete_session`

**Query Parameters:**

- `session_id` (string, required): ID of the session to delete
- `email` (string, optional): Email of the student (must match token email if provided; token email used if omitted)
- `simulation_group_id` (string, required): ID of the group
- `patient_id` (string, required): ID of the patient

**Response:**

```json
{
  "session_id": "uuid"
}
```

**Example (cURL):**

```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/delete_session?session_id=uuid&email=student@example.com&simulation_group_id=uuid&patient_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Update Session Name

Update the name of an existing session.

**Endpoint:** `PUT /student/update_session_name`

**Query Parameters:**

- `session_id` (string, required): ID of the session to update

**Request Body:**

```json
{
  "session_name": "Updated Session Name"
}
```

**Parameters:**

- `session_name` (string, required): New name for the session

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/update_session_name?session_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"session_name": "Updated Session Name"}'
```


---

## Messaging

### Create Message

Send a student message in a session. Checks the per-group message limit.

**Endpoint:** `POST /student/create_message`

**Query Parameters:**

- `session_id` (string, required): ID of the session
- `email` (string, optional): Email of the student (must match token email if provided; token email used if omitted)
- `simulation_group_id` (string, required): ID of the group
- `patient_id` (string, required): ID of the patient

**Request Body:**

```json
{
  "message_content": "What medications are you currently taking?"
}
```

**Parameters:**

- `message_content` (string, required): Content of the message

**Response:**

```json
{
  "message_id": "uuid",
  "chat_id": "uuid",
  "sender_type": "student",
  "message_content": "What medications are you currently taking?",
  "sent_at": "2024-05-15T09:05:00.000Z"
}
```

**Response Fields:**

- `sender_type` (string): Either "student" or "ai"

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/create_message?session_id=uuid&email=student@example.com&simulation_group_id=uuid&patient_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"message_content": "What medications are you currently taking?"}'
```

---

### Create AI Message

Create an AI response message for a session (used internally after text generation).

**Endpoint:** `POST /student/create_ai_message`

**Query Parameters:**

- `session_id` (string, required): ID of the session
- `email` (string, optional): Email of the student (must match token email if provided; token email used if omitted)
- `simulation_group_id` (string, required): ID of the group
- `patient_id` (string, required): ID of the patient

**Request Body:**

```json
{
  "message_content": "I am currently taking lisinopril for blood pressure..."
}
```

**Parameters:**

- `message_content` (string, required): Content of the AI message

**Response:**

```json
{
  "message_id": "uuid",
  "chat_id": "uuid",
  "sender_type": "ai",
  "message_content": "I am currently taking lisinopril for blood pressure...",
  "sent_at": "2024-05-15T09:05:30.000Z"
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/create_ai_message?session_id=uuid&email=student@example.com&simulation_group_id=uuid&patient_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"message_content": "I am currently taking lisinopril for blood pressure..."}'
```

---

### Get Messages

Get all messages in a session, ordered chronologically.

**Endpoint:** `GET /student/get_messages`

**Query Parameters:**

- `session_id` (string, required): The ID of the session

**Response:**

```json
[
  {
    "message_id": "uuid",
    "chat_id": "uuid",
    "user_id": "uuid",
    "sender_type": "student",
    "message_content": "What medications are you currently taking?",
    "sent_at": "2024-05-15T09:05:00.000Z"
  },
  {
    "message_id": "uuid",
    "chat_id": "uuid",
    "user_id": null,
    "sender_type": "ai",
    "message_content": "I am currently taking lisinopril...",
    "sent_at": "2024-05-15T09:05:30.000Z"
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/get_messages?session_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Delete Last Message

Delete the last message exchange (student + AI pair) in a session.

**Endpoint:** `DELETE /student/delete_last_message`

**Query Parameters:**

- `session_id` (string, required): ID of the session

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/delete_last_message?session_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Notes

### Get Notes

Get session notes for a student.

**Endpoint:** `GET /student/get_notes`

**Query Parameters:**

- `session_id` (string, required): The ID of the session

**Response:**

```json
{
  "notes": "Patient reports taking lisinopril 10mg daily. No known allergies."
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/get_notes?session_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Update Notes

Update or create notes for a session.

**Endpoint:** `PUT /student/update_notes`

**Query Parameters:**

- `session_id` (string, required): The ID of the session

**Request Body:**

```json
{
  "notes": "Patient reports taking lisinopril 10mg daily. No known allergies."
}
```

**Parameters:**

- `notes` (string, required): Notes content

**Response:**

```json
{
  "message": "Notes updated successfully"
}
```

**Example (cURL):**

```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/update_notes?session_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"notes": "Patient reports taking lisinopril 10mg daily. No known allergies."}'
```


---

## AI Text Generation & Debrief

### Text Generation

Generate a response from the LLM. Supports multiple modes: chat, debrief, question matching, and test debrief.

**Endpoint:** `POST /student/text_generation`

**Authorization** (enforced in the Lambda, `helpers/authz.py`; the API Gateway authorizer only validates the JWT):

- `chat`, `match`, `debrief`: the caller must own `session_id` (admins bypass ownership). The session must belong to `patient_id` and `simulation_group_id`.
- `test_debrief`: the caller must be an instructor of `simulation_group_id` or an admin, and the session must belong to that persona and group.
- `test_system_prompt`: the caller must be an instructor of `simulation_group_id` or an admin. `patient_id` must belong to the group, and `session_id` must be a playground scratch ID prefixed with `test-`.
- Denials return `401` (no caller identity), `400` (malformed IDs) or `403` (not permitted).

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group
- `session_id` (string, required): ID of the session
- `patient_id` (string, required): ID of the patient
- `session_name` (string, optional): Name of the session
- `stream` (string, optional): Enable streaming response (`"true"` or `"false"`, default `"false"`). When `"true"`, chunks are POSTed to the ECS socket server's `/stream-callback` route at the URL stored in SSM (`/{StackPrefix}/socket-callback-url`); the destination is never taken from the request.
- `mode` (string, optional): Operation mode — `"chat"` (default), `"debrief"`, `"match"`, `"test_debrief"`

**Request Body:**

```json
{
  "message_content": "What brings you in today?",
  "debrief_prompt": "Evaluate the student's clinical reasoning..."
}
```

**Parameters:**

- `message_content` (string, optional): Content of the student's message (used when mode=chat)
- `debrief_prompt` (string, optional): Custom debrief prompt text (required when mode=test_debrief)

**Response (mode=chat):**

```json
{
  "session_name": "Session 1",
  "llm_output": "Well, I've been having these headaches for about two weeks now...",
  "llm_verdict": "false"
}
```

**Response (mode=test_debrief):**

```json
{
  "summary": "The student demonstrated solid clinical assessment skills...",
  "questions_addressed": [
    {
      "question_id": "uuid",
      "question_text": "Did you ask about current medications?",
      "matched_messages": [
        {
          "message_content": "What medications are you currently taking?",
          "similarity_score": 0.92,
          "confidence_tier": "high"
        }
      ],
      "quality_assessment": "Thorough inquiry with appropriate follow-up"
    }
  ],
  "questions_missed": [
    {
      "question_id": "uuid",
      "question_text": "Did you ask about allergies?",
      "is_mandatory": true,
      "weight": 1.0
    }
  ],
  "recommendation_feedback": {
    "strengths": ["Good medication history taking"],
    "areas_for_improvement": ["Missing allergy assessment"]
  },
  "reasoning_gaps": "Student did not explore allergy history",
  "overall_score": 75,
  "suggested_rewrites": [
    {
      "original_message": "Any other health issues?",
      "matched_question_id": "uuid",
      "similarity_score": 0.6,
      "suggested_rewrite": "Do you have any known drug allergies?"
    }
  ],
  "answer_key_comparison": {
    "answer_key_available": true,
    "correct_elements": ["Identified hypertension"],
    "missing_elements": ["Did not identify diabetes risk"],
    "incorrect_elements": [],
    "overall_alignment": "Partially aligned"
  },
  "recommendation": "Focus on systematic review of patient history"
}
```

**Response Fields:**

- `llm_verdict` (string): "true" or "false" — whether the student has correctly diagnosed the patient
- `overall_score` (number): Numeric score from 0-100 for the session performance
- `confidence_tier` (string): "high", "medium", or "low" confidence in question matching

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/text_generation?simulation_group_id=uuid&session_id=uuid&patient_id=uuid&mode=chat" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"message_content": "What brings you in today?"}'
```

---

### Get Debrief

Get the AI-generated debrief evaluation for a completed chat session. Verifies the authenticated student owns the specified chat before returning the debrief.

**Endpoint:** `GET /student/get_debrief`

**Query Parameters:**

- `session_id` (string, required): ID of the session/chat
- `email` (string, optional): Email of the student (must match token email if provided; token email used if omitted)

**Security:** The endpoint verifies chat ownership by checking that the chat belongs to the authenticated student via the enrollment chain (`chats → student_interactions → enrollments → user`). Returns **403 Forbidden** if the chat does not belong to the authenticated user.

**Response (status=complete):**

```json
{
  "generated_text": "{\"summary\": \"...\", \"overall_score\": 85, ...}",
  "status": "complete"
}
```

**Response (status=generating):**

```json
{
  "error": "Debrief is still being generated",
  "status": "generating"
}
```

**Response Fields:**

- `status` (string): "complete" when debrief is ready, "generating" when still processing
- `generated_text` (string): JSON string containing the full debrief evaluation

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/get_debrief?session_id=uuid&email=student@example.com" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Conclude Interaction

Mark a session as completed with the student's recommendation. Triggers asynchronous debrief generation.

**Endpoint:** `POST /student/conclude_interaction`

**Query Parameters:**

- `session_id` (string, required): ID of the chat session to conclude
- `simulation_group_id` (string, required): ID of the simulation group
- `patient_id` (string, required): ID of the patient (persona)

**Request Body:**

```json
{
  "recommendation": "Based on my assessment, I recommend starting the patient on amlodipine 5mg daily for blood pressure management."
}
```

**Parameters:**

- `recommendation` (string, required): The student's recommendation text

**Response:**

```json
{
  "message": "Interaction concluded successfully",
  "chat": {
    "chat_id": "uuid",
    "is_ended": true,
    "recommendation": "Based on my assessment..."
  },
  "debrief_triggered": true
}
```

**Response Fields:**

- `debrief_triggered` (boolean): Whether debrief generation was triggered asynchronously

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/conclude_interaction?session_id=uuid&simulation_group_id=uuid&patient_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"recommendation": "Based on my assessment, I recommend starting the patient on amlodipine 5mg daily."}'
```


---

## Scoring & Completion

### Get Completion Status

Get completion status for all patient interactions in a simulation group.

**Endpoint:** `GET /student/get_completion_status`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group
- `student_email` (string, required): Email of the student (must match token email)

**Response:**

```json
{
  "statuses": [
    {
      "student_interaction_id": "uuid",
      "is_completed": true,
      "patient_name": "Maria Garcia"
    },
    {
      "student_interaction_id": "uuid",
      "is_completed": false,
      "patient_name": "John Smith"
    }
  ]
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/get_completion_status?simulation_group_id=uuid&student_email=student@example.com" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Feedback & Reporting

### Submit Debrief Feedback

Submit feedback on whether the AI debrief was helpful. The user is identified from the JWT token — no email field is required in the request body.

**Endpoint:** `POST /student/debrief_feedback`

**Request Body:**

```json
{
  "simulation_group_id": "uuid",
  "persona_id": "uuid",
  "chat_id": "uuid",
  "is_helpful": true,
  "comment": "The feedback was very specific and actionable."
}
```

**Parameters:**

- `simulation_group_id` (string, required): UUID of the simulation group
- `persona_id` (string, required): UUID of the persona (patient)
- `chat_id` (string, required): UUID of the chat session
- `is_helpful` (boolean, required): Whether the student found the debrief helpful
- `comment` (string, optional): Optional comment from the student

**Response:**

```json
{
  "feedback_id": "uuid"
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/debrief_feedback" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"simulation_group_id": "uuid", "persona_id": "uuid", "chat_id": "uuid", "is_helpful": true, "comment": "Very helpful!"}'
```

---

### Submit Issue Report

Report a technical or content issue with the AI patient simulation. The user is identified from the JWT token — no email field is required in the request body.

**Endpoint:** `POST /student/issue_report`

**Request Body:**

```json
{
  "simulation_group_id": "uuid",
  "persona_id": "uuid",
  "chat_id": "uuid",
  "issue_categories": ["Inaccurate response", "Out of character"],
  "details": "The patient mentioned a medication that contradicts their case file."
}
```

**Parameters:**

- `simulation_group_id` (string, required): UUID of the simulation group
- `persona_id` (string, required): UUID of the persona (patient)
- `chat_id` (string, required): UUID of the chat session
- `issue_categories` (array of strings, required): Non-empty array of issue category strings
- `details` (string, optional): Optional details about the reported issue

**Response:**

```json
{
  "report_id": "uuid"
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/issue_report" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"simulation_group_id": "uuid", "persona_id": "uuid", "chat_id": "uuid", "issue_categories": ["Inaccurate response"], "details": "Patient mentioned wrong medication."}'
```

---

## Files & Media

### Get All Files

Get a list of all document files for a specific group and patient.

**Endpoint:** `GET /student/get_all_files`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group
- `persona_id` (string, required): ID of the patient (persona)
- `patient_name` (string, required): Name of the patient

**Response:**

```json
{
  "files": ["Patient_Record.pdf", "Lab_Results.pdf", "Prescription_History.pdf"]
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/get_all_files?simulation_group_id=uuid&persona_id=uuid&patient_name=maria_garcia" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Profile Pictures

Get profile picture presigned URLs for patients in a simulation group.

**Endpoint:** `POST /student/get_profile_pictures`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group

**Response:**

```json
{
  "profile_pictures": {
    "persona-uuid-1": "https://s3.amazonaws.com/bucket/...",
    "persona-uuid-2": "https://s3.amazonaws.com/bucket/..."
  }
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/get_profile_pictures?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json"
```

---

### Get Persona Media

Get physical assessment materials for a patient.

**Endpoint:** `GET /student/persona_media`

**Query Parameters:**

- `persona_id` (string, required): ID of the persona (patient)

**Response:**

```json
[
  {
    "media_id": "uuid",
    "persona_id": "uuid",
    "title": "Blood Pressure Reading",
    "description": "Recent BP measurement",
    "media_type": "image",
    "url": "https://s3.amazonaws.com/bucket/..."
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/persona_media?persona_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Voice & Context

### Get Patient Voice ID

Get the voice ID for text-to-speech generation for a patient.

**Endpoint:** `GET /student/patient_voice_id`

**Query Parameters:**

- `patient_id` (string, required): The ID of the patient

**Response:**

```json
{
  "voice_id": "matthew"
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/patient_voice_id?patient_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Check Voice Enabled

Check if voice mode is enabled for a simulation group.

**Endpoint:** `GET /student/voice_enabled`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the simulation group

**Response:**

```json
{
  "voice_enabled": true
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/voice_enabled?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Empathy Summary

### Get Empathy Evaluation Summary

Get empathy evaluation summary and scores for a student's session.

**Endpoint:** `GET /student/empathy_summary`

**Query Parameters:**

- `session_id` (string, required): ID of the session
- `email` (string, optional): Email of the student (must match token email if provided; token email used if omitted)
- `simulation_group_id` (string, required): ID of the simulation group
- `patient_id` (string, required): ID of the patient

**Response:**

```json
{
  "overall_score": "4.2",
  "overall_level": "High",
  "total_interactions": 15,
  "empathy_interactions": 12,
  "avg_perspective_taking": "4.0",
  "avg_emotional_resonance": "4.5",
  "avg_acknowledgment": "4.1",
  "avg_language_communication": "4.3",
  "avg_cognitive_empathy": "4.0",
  "avg_affective_empathy": "4.4",
  "summary": "Student demonstrated consistently high empathy...",
  "realism_assessment": "Realistic",
  "realism_explanation": "Responses appeared genuine and contextually appropriate"
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/student/empathy_summary?session_id=uuid&email=student@example.com&simulation_group_id=uuid&patient_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```


---

# Instructor Endpoints

All instructor endpoints require the `instructorAuthorizer`. Additionally, the handler verifies the authenticated user has the `instructor` or `admin` role in the database (DB is the source of truth). If the role check fails, the request is rejected with **403 Forbidden**. Email-based query parameters are validated against the token email — a mismatch results in **401 Unauthorized**.

## Group Management

### Get Instructor Groups

Get all simulation groups where the instructor is enrolled.

**Endpoint:** `GET /instructor/groups`

**Query Parameters:**

- `email` (string, optional): Email of the instructor (must match token email if provided; token email used if omitted)

**Response:**

```json
[
  {
    "simulation_group_id": "uuid",
    "group_name": "Pharmacy 101 - Fall 2024",
    "group_description": "Introductory pharmacy simulation",
    "group_access_code": "ABC123",
    "group_student_access": true,
    "persona_count": 3,
    "student_count": 25,
    "instructor_count": 2
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/groups?email=instructor@example.com" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Student Group (Legacy)

Get groups for a specific student.

**Endpoint:** `GET /instructor/student_group`

**Query Parameters:**

- `email` (string, optional): Email of the instructor (must match token email if provided; token email used if omitted)

**Response:**

```json
[
  {
    "simulation_group_id": "uuid",
    "group_name": "Pharmacy 101",
    "group_description": "Introductory simulation"
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/student_group?email=instructor@example.com" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Create Simulation Group

Create a new simulation group.

**Endpoint:** `POST /instructor/create_simulation_group`

**Query Parameters:**

- `instructor_email` (string, optional): Email of the instructor (must match token email if provided; token email used if omitted)

**Request Body:**

```json
{
  "group_name": "Advanced Clinical Pharmacy",
  "group_description": "Complex patient scenarios for senior students",
  "group_student_access": true,
  "instructor_voice_enabled": true
}
```

**Parameters:**

- `group_name` (string, required): Name of the simulation group
- `group_description` (string, optional): Description of the group
- `group_student_access` (boolean, optional): Whether students can access the group (default: true)
- `instructor_voice_enabled` (boolean, optional): Whether voice is enabled (default: true)

**Response:**

```json
{
  "simulation_group_id": "uuid"
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/create_simulation_group?instructor_email=instructor@example.com" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"group_name": "Advanced Clinical Pharmacy", "group_description": "Complex patient scenarios", "group_student_access": true}'
```

---

### Generate Access Code

Generate a new access code for a simulation group.

**Endpoint:** `PUT /instructor/generate_access_code`

**Query Parameters:**

- `simulation_group_id` (string, required): The ID of the simulation group

**Response:**

```json
{
  "access_code": "XYZ789"
}
```

**Example (cURL):**

```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/generate_access_code?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Access Code

Get the current access code for a group.

**Endpoint:** `GET /instructor/get_access_code`

**Query Parameters:**

- `simulation_group_id` (string, required): The ID of the group

**Response:**

```json
{
  "group_access_code": "ABC123"
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/get_access_code?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Patient Management

### View Patients

Get all patients in a given simulation group.

**Endpoint:** `GET /instructor/view_patients`

**Query Parameters:**

- `simulation_group_id` (string, required): The ID of the group

**Response:**

```json
[
  {
    "persona_id": "uuid",
    "persona_name": "Maria Garcia",
    "persona_age": 45,
    "persona_gender": "Female",
    "persona_number": 1,
    "persona_prompt": "You are Maria Garcia, a 45-year-old woman...",
    "voice_enabled": true,
    "voice_id": "tiffany",
    "llm_completion": true,
    "has_dtps": true,
    "has_recommendations": true,
    "mode": "chat"
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/view_patients?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Create Patient

Create a new patient persona within a simulation group.

**Endpoint:** `POST /instructor/create_patient`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group
- `persona_name` (string, required): Name of the patient
- `persona_age` (string, required): Age of the patient
- `persona_gender` (string, required): Gender of the patient
- `persona_number` (string, required): Display order number
- `instructor_email` (string, optional): Email of the instructor (must match token email if provided; token email used if omitted)
- `voice_id` (string, optional): Voice ID for TTS

**Request Body:**

```json
{
  "persona_prompt": "You are Maria Garcia, a 45-year-old woman presenting with persistent headaches...",
  "voice_persona_prompt": "Speak with a calm, measured tone. You are worried but trying to stay composed."
}
```

**Parameters:**

- `persona_prompt` (string, required): System prompt for the patient persona
- `voice_persona_prompt` (string, optional): Voice-specific prompt for the persona

**Response:**

```json
{
  "persona_id": "uuid",
  "persona_name": "Maria Garcia",
  "persona_age": 45,
  "persona_gender": "Female",
  "persona_number": 1
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/create_patient?simulation_group_id=uuid&persona_name=Maria%20Garcia&persona_age=45&persona_gender=Female&persona_number=1&instructor_email=instructor@example.com" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"persona_prompt": "You are Maria Garcia, a 45-year-old woman..."}'
```

---

### Edit Patient

Update details of an existing patient.

**Endpoint:** `PUT /instructor/edit_patient`

**Query Parameters:**

- `persona_id` (string, required): ID of the patient
- `instructor_email` (string, optional): Email of the instructor (must match token email if provided; token email used if omitted)
- `simulation_group_id` (string, required): ID of the group

**Request Body:**

```json
{
  "persona_name": "Maria Garcia",
  "persona_age": 46,
  "persona_gender": "Female",
  "persona_prompt": "Updated persona prompt...",
  "voice_id": "tiffany",
  "voice_enabled": true,
  "voice_persona_prompt": "Updated voice prompt..."
}
```

**Parameters:**

- `persona_name` (string, required): Patient name
- `persona_age` (integer, required): Patient age
- `persona_gender` (string, required): Patient gender
- `persona_prompt` (string, required): Patient system prompt
- `voice_id` (string, optional): Voice ID for TTS (e.g., tiffany, matthew, amy, olivia, kiara, arjun)
- `voice_enabled` (boolean, optional): Whether voice mode is enabled
- `voice_persona_prompt` (string, optional): Voice-specific prompt

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/edit_patient?persona_id=uuid&instructor_email=instructor@example.com&simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"persona_name": "Maria Garcia", "persona_age": 46, "persona_gender": "Female", "persona_prompt": "Updated prompt..."}'
```

---

### Reorder Patient

Reorder and rename an existing patient.

**Endpoint:** `PUT /instructor/reorder_patient`

**Query Parameters:**

- `patient_id` (string, required): ID of the patient
- `patient_number` (integer, required): New display order number
- `instructor_email` (string, optional): Email of the instructor (must match token email if provided; token email used if omitted)

**Request Body:**

```json
{
  "patient_name": "Maria Garcia"
}
```

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/reorder_patient?patient_id=uuid&patient_number=2&instructor_email=instructor@example.com" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"patient_name": "Maria Garcia"}'
```

---

### Delete Patient

Delete a patient persona from a group.

**Endpoint:** `DELETE /instructor/delete_patient`

**Query Parameters:**

- `persona_id` (string, required): The ID of the patient to delete

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/delete_patient?persona_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Student Management

### View Students

Get all students enrolled in a simulation group.

**Endpoint:** `GET /instructor/view_students`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group

**Response:**

```json
[
  {
    "user_email": "student@example.com",
    "username": "jdoe",
    "first_name": "Jane",
    "last_name": "Doe"
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/view_students?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Delete Student

Remove a student from a simulation group.

**Endpoint:** `DELETE /instructor/delete_student`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group
- `instructor_email` (string, optional): Email of the instructor (must match token email if provided; token email used if omitted)
- `user_email` (string, required): Email of the student to remove

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/delete_student?simulation_group_id=uuid&instructor_email=instructor@example.com&user_email=student@example.com" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### View Student Messages

Get all messages for a specific student in a group.

**Endpoint:** `GET /instructor/view_student_messages`

**Query Parameters:**

- `simulation_group_id` (string, required): The ID of the group
- `student_email` (string, required): The email of the student

**Response:**

```json
[
  {
    "message_content": "What medications are you taking?",
    "sent_at": "2024-05-15T09:05:00.000Z",
    "sender_type": "student"
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/view_student_messages?simulation_group_id=uuid&student_email=student@example.com" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Student Patients Messages

Get detailed conversation transcripts organized by patient.

**Endpoint:** `GET /instructor/student_patients_messages`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group
- `student_email` (string, required): Email of the student

**Response:**

```json
{
  "Maria Garcia": [
    {
      "chatId": "uuid",
      "chatName": "Session 1",
      "notes": "Patient notes...",
      "status": "ended",
      "messages": [
        {
          "message_content": "Hello, how are you feeling?",
          "sender_type": "student",
          "sent_at": "2024-05-15T09:00:00.000Z"
        }
      ]
    }
  ]
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/student_patients_messages?simulation_group_id=uuid&student_email=student@example.com" \
  -H "Authorization: eyJraWQiOiJ..."
```


---

## Prompt Management

### Get System Prompt

Get the system prompt for a simulation group.

**Endpoint:** `GET /instructor/get_prompt`

**Query Parameters:**

- `simulation_group_id` (string, required): The ID of the group

**Response:**

```json
{
  "system_prompt": "You are a patient in a clinical pharmacy simulation..."
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/get_prompt?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Update System Prompt

Update the system prompt for a simulation group.

**Endpoint:** `PUT /instructor/prompt`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group
- `instructor_email` (string, optional): Email of the instructor (must match token email if provided; token email used if omitted)

**Request Body:**

```json
{
  "prompt": "You are a patient in a clinical pharmacy simulation. Respond naturally..."
}
```

**Parameters:**

- `prompt` (string, required): New system prompt text

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/prompt?simulation_group_id=uuid&instructor_email=instructor@example.com" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"prompt": "You are a patient in a clinical pharmacy simulation..."}'
```

---

### Get Debrief Prompt

Get the debrief evaluation prompt for a simulation group.

**Endpoint:** `GET /instructor/get_debrief_prompt`

**Query Parameters:**

- `simulation_group_id` (string, required): The ID of the group

**Response:**

```json
{
  "debrief_prompt": "Evaluate the student's clinical reasoning and question coverage..."
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/get_debrief_prompt?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Update Debrief Prompt

Update the debrief evaluation prompt for a simulation group.

**Endpoint:** `PUT /instructor/debrief_prompt`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group
- `instructor_email` (string, optional): Email of the instructor (must match token email if provided; token email used if omitted)

**Request Body:**

```json
{
  "prompt": "Evaluate the student's performance based on the following criteria..."
}
```

**Parameters:**

- `prompt` (string, required): New debrief prompt text

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/debrief_prompt?simulation_group_id=uuid&instructor_email=instructor@example.com" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Evaluate the student performance..."}'
```

---

### Get Default Debrief Prompt

Get the system built-in default debrief prompt.

**Endpoint:** `GET /instructor/get_default_debrief_prompt`

**Response:**

```json
{
  "default_debrief_prompt": "You are an expert clinical evaluator..."
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/get_default_debrief_prompt" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Previous Prompts

Get prompt change history for a group.

**Endpoint:** `GET /instructor/previous_prompts`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group
- `instructor_email` (string, optional): Email of the instructor (must match token email if provided; token email used if omitted)

**Response:**

```json
[
  {
    "timestamp": "2024-05-01T10:00:00.000Z",
    "previous_prompt": "Old system prompt text..."
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/previous_prompts?simulation_group_id=uuid&instructor_email=instructor@example.com" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Prompt History

Get full prompt history with user details.

**Endpoint:** `GET /instructor/get_prompt_history`

**Query Parameters:**

- `simulation_group_id` (string, required): The ID of the simulation group
- `type` (string, required): The type of prompt history — `"system"` or `"debrief"`

**Response:**

```json
[
  {
    "id": "uuid",
    "text": "Previous prompt content...",
    "saved_at": "2024-05-01T10:00:00.000Z",
    "modified_by_email": "instructor@example.com",
    "modified_by_first_name": "John",
    "modified_by_last_name": "Smith"
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/get_prompt_history?simulation_group_id=uuid&type=debrief" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Analytics & Reporting

### Get Analytics

Get engagement and completion analytics for a simulation group.

**Endpoint:** `GET /instructor/analytics`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group

**Response:**

```json
[
  {
    "persona_id": "uuid",
    "persona_name": "Maria Garcia",
    "persona_number": 1,
    "student_message_count": 150,
    "ai_message_count": 148,
    "access_count": 30,
    "ai_score_percentage": 75,
    "llm_completion": true,
    "instructor_completion_percentage": 80
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/analytics?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Debrief (Instructor)

Get AI debrief for a student's completed chat session (instructor access). Authorizes by verifying the chat belongs to the specified simulation group via the data model chain.

**Endpoint:** `GET /instructor/get_debrief`

**Query Parameters:**

- `session_id` (string, required): ID of the session/chat
- `simulation_group_id` (string, required): ID of the simulation group (used for authorization — chat must belong to this group)

**Security:** The endpoint verifies access by joining `chats → student_interactions → personas` and confirming the persona belongs to the given simulation group. Returns **404** if the chat is not found in the group (avoids leaking existence of chats in other groups).

**Response:**

```json
{
  "generated_text": "{\"summary\": \"...\", \"overall_score\": 85, ...}",
  "status": "complete"
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/get_debrief?session_id=uuid&simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Completion Status (Instructor)

Get completion status for all interactions in a simulation group for a specific student.

**Endpoint:** `GET /instructor/get_completion_status`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group
- `student_email` (string, required): Email of the student

**Response:**

```json
{
  "statuses": [
    {
      "student_interaction_id": "uuid",
      "is_completed": true,
      "patient_name": "Maria Garcia"
    }
  ]
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/get_completion_status?simulation_group_id=uuid&student_email=student@example.com" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Toggle Completion

Toggle the completion status of a student interaction.

**Endpoint:** `PUT /instructor/toggle_completion`

**Query Parameters:**

- `student_interaction_id` (string, required): ID of the interaction

**Response:**

```json
{
  "student_interaction_id": "uuid",
  "is_completed": true
}
```

**Example (cURL):**

```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/toggle_completion?student_interaction_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Toggle LLM Completion

Toggle the LLM completion flag for a patient (controls whether AI-driven completion is active).

**Endpoint:** `PUT /instructor/toggle_llm_completion`

**Query Parameters:**

- `patient_id` (string, required): ID of the patient

**Response:**

```json
{
  "message": "LLM completion toggled successfully",
  "llm_completion": false
}
```

**Example (cURL):**

```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/toggle_llm_completion?patient_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Ingestion Status

Get the ingestion status of uploaded files for a specific patient.

**Endpoint:** `GET /instructor/ingestion_status`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group
- `patient_id` (string, required): ID of the patient

**Response:**

```json
{
  "Patient_Record_1.pdf": "Completed",
  "Patient_Record_2.pdf": "Processing",
  "Patient_Record_3.pdf": "Failed"
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/ingestion_status?simulation_group_id=uuid&patient_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Empathy Summary (Instructor)

Get empathy evaluation summary for a student in a group.

**Endpoint:** `GET /instructor/empathy_summary`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the simulation group
- `student_email` (string, required): Email of the student

**Response:**

```json
{
  "overall_score": "4.2",
  "overall_level": "High",
  "total_interactions": 15,
  "empathy_interactions": 12
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/empathy_summary?simulation_group_id=uuid&student_email=student@example.com" \
  -H "Authorization: eyJraWQiOiJ..."
```


---

## File & Metadata Management

### Get All Files (Instructor)

Get a list of all document files for a specific group and patient.

**Endpoint:** `GET /instructor/get_all_files`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group
- `persona_id` (string, required): ID of the patient (persona)
- `patient_name` (string, required): Name of the patient

**Response:**

```json
{
  "files": ["Patient_Record.pdf", "Lab_Results.pdf"]
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/get_all_files?simulation_group_id=uuid&persona_id=uuid&patient_name=maria_garcia" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Profile Pictures (Instructor)

Get profile picture URLs for patients in a group.

**Endpoint:** `POST /instructor/get_profile_pictures`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group

**Response:**

```json
{
  "profile_pictures": {
    "persona-uuid-1": "https://s3.amazonaws.com/bucket/..."
  }
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/get_profile_pictures?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json"
```

---

### Generate Presigned URL

Generate a presigned URL for uploading files to S3.

**Endpoint:** `GET /instructor/generate_presigned_url`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group
- `patient_id` (string, required): ID of the patient
- `patient_name` (string, required): Name of the patient
- `file_type` (string, required): Type of file (e.g., pdf, jpg)
- `file_name` (string, required): Name of the file
- `folder_type` (string, required): Type of folder (e.g., documents, profile_pictures)

**Response:**

```json
{
  "presignedurl": "https://s3.amazonaws.com/bucket/...?X-Amz-Signature=..."
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/generate_presigned_url?simulation_group_id=uuid&patient_id=uuid&patient_name=maria_garcia&file_type=pdf&file_name=lab_results.pdf&folder_type=documents" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Delete File

Delete a case file from S3.

**Endpoint:** `DELETE /instructor/delete_file`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group
- `patient_id` (string, required): ID of the patient
- `patient_name` (string, required): Name of the patient
- `file_type` (string, required): Type of file (pdf or jpg)
- `file_name` (string, required): Name of the file
- `folder_type` (string, required): Type of folder

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/delete_file?simulation_group_id=uuid&patient_id=uuid&patient_name=maria_garcia&file_type=pdf&file_name=old_record.pdf&folder_type=documents" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Delete Patient S3 Files

Delete all S3 files for a patient.

**Endpoint:** `DELETE /instructor/delete_patient_s3`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group
- `patient_id` (string, required): ID of the patient
- `patient_name` (string, required): Name of the patient

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/delete_patient_s3?simulation_group_id=uuid&patient_id=uuid&patient_name=maria_garcia" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Update Metadata

Update metadata/display name for a patient file.

**Endpoint:** `PUT /instructor/update_metadata`

**Query Parameters:**

- `patient_id` (string, required): ID of the patient
- `filename` (string, required): Name of the file
- `filetype` (string, required): Type of the file

**Request Body:**

```json
{
  "metadata": "Updated description of the file contents"
}
```

**Parameters:**

- `metadata` (string, required): New metadata content for the file

**Response:**

```json
{
  "file_id": "uuid",
  "patient_id": "uuid",
  "filetype": "pdf",
  "s3_bucket_reference": "bucket-name",
  "filepath": "group/patient/file.pdf",
  "filename": "lab_results.pdf",
  "time_uploaded": "2024-05-01T10:00:00.000Z",
  "metadata": "Updated description of the file contents"
}
```

**Example (cURL):**

```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/update_metadata?patient_id=uuid&filename=lab_results.pdf&filetype=pdf" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"metadata": "Updated description of the file contents"}'
```

---

## Question Bank & Assessment

### Get Question Bank (Instructor)

Browse the organization question bank (read-only).

**Endpoint:** `GET /instructor/question_bank`

**Response:**

```json
[
  {
    "question_id": "uuid",
    "title": "Medication History",
    "question_text": "Did you ask about current medications?",
    "evaluation_criteria": "Student should inquire about all current prescriptions",
    "is_mandatory": true
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/question_bank" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Create Question (Instructor)

Create a new question in the organization's question bank. The `created_by` field is resolved server-side from the authenticated instructor's JWT email — it is not passed as a parameter.

**Endpoint:** `POST /instructor/question_bank`

**Authentication:** `instructorAuthorizer` (JWT)

**Query Parameters:**

- `organization_id` (string, required): ID of the organization to create the question in

**Request Body:**

```json
{
  "title": "Allergy Assessment",
  "question_text": "Did you ask about drug allergies?",
  "evaluation_criteria": "Student should specifically ask about known drug allergies and reactions",
  "clinical_intent": "Establish allergy history before recommending therapy",
  "category": "Safety",
  "difficulty_level": "basic",
  "is_mandatory": true,
  "weight": 1.5,
  "max_score": 10,
  "tags": ["allergies", "safety"]
}
```

**Parameters:**

- `title` (string, required): Question title
- `question_text` (string, required): Full question text
- `evaluation_criteria` (string, required): Criteria for evaluating student performance
- `clinical_intent` (string, optional, default: `""`): Clinical intent behind the question. An omitted, null, or non-string value is stored as an empty string rather than `NULL`
- `category` (string, optional): Question category
- `difficulty_level` (string, optional): Difficulty level (e.g., "basic", "intermediate", "advanced")
- `is_mandatory` (boolean, optional, default: `false`): Whether the question is mandatory
- `weight` (number, optional, default: `1.0`): Scoring weight
- `max_score` (number, optional, default: `100`): Maximum score
- `tags` (array of strings, optional, default: `[]`): Tags for filtering and organization

**Response Codes:**

| Status | Description |
|--------|-------------|
| 201 | Created — Question successfully created |
| 400 | Bad Request — Missing required fields (`title`, `question_text`, or `evaluation_criteria`) or invalid `organization_id` |
| 401 | Unauthorized — Invalid or missing JWT token, or user lacks instructor role |
| 500 | Internal Server Error — Unexpected failure |

**Response (201 Created):**

```json
{
  "question_id": "uuid",
  "organization_id": "uuid",
  "title": "Allergy Assessment",
  "question_text": "Did you ask about drug allergies?",
  "evaluation_criteria": "Student should specifically ask about known drug allergies and reactions",
  "clinical_intent": "Establish allergy history before recommending therapy",
  "category": "Safety",
  "difficulty_level": "basic",
  "is_mandatory": true,
  "weight": 1.5,
  "max_score": 10,
  "tags": ["allergies", "safety"],
  "created_by": "instructor@example.com",
  "created_at": "2024-06-15T14:30:00.000Z",
  "is_active": true
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/question_bank?organization_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"title": "Allergy Assessment", "question_text": "Did you ask about drug allergies?", "evaluation_criteria": "Should ask about allergies", "category": "Safety", "is_mandatory": true}'
```

> **Note:** Deleting questions is an admin-only operation. See [Delete Question](#delete-question) in the [Question Bank (Admin)](#question-bank-admin) section.

---

### Update Question (Instructor)

Update a question in the question bank.

**Endpoint:** `PUT /instructor/question_bank`

**Query Parameters:**

- `question_id` (string, required): ID of the question to update

**Request Body:**

```json
{
  "title": "Updated Title",
  "question_text": "Updated question text",
  "evaluation_criteria": "Updated criteria",
  "clinical_intent": "Updated clinical intent",
  "is_mandatory": true,
  "tags": ["allergies", "safety"]
}
```

**Parameters:**

- `title` (string, optional): New question title
- `question_text` (string, optional): New question text
- `evaluation_criteria` (string, optional): New evaluation criteria
- `clinical_intent` (string, optional): New clinical intent
- `is_mandatory` (boolean, optional): Whether the question is mandatory
- `tags` (array of strings, optional): Replacement tag list. An empty array `[]` clears the stored tags; omitting the field leaves them unchanged

**Response Codes:**

| Status | Description |
|--------|-------------|
| 200 | OK — Question updated; the full updated row is returned |
| 400 | Bad Request — Missing `question_id` or request body, or `tags` is present but not an array. A non-array `tags` value is rejected before any database write with `{"error": "tags must be an array of strings"}` |
| 401 | Unauthorized — Invalid or missing JWT token, or user lacks instructor role |
| 404 | Not Found — No question matches `question_id` |
| 500 | Internal Server Error — Unexpected failure |

**Example (cURL):**

```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/question_bank?question_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"title": "Updated Title", "question_text": "Updated question", "evaluation_criteria": "Updated criteria", "clinical_intent": "Updated clinical intent", "is_mandatory": true, "tags": ["allergies", "safety"]}'
```

> **Note:** The instructor question bank resource exposes only `GET`, `POST`, and `PUT`. There is no `DELETE /instructor/question_bank` — deleting questions is an admin-only operation. See [Delete Question](#delete-question) in the [Question Bank (Admin)](#question-bank-admin) section.

---

### Get Simulation Group Questions

Get questions assigned to a simulation group, optionally filtered by persona.

**Endpoint:** `GET /instructor/simulation_group_questions`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the simulation group
- `persona_id` (string, optional): Persona ID to filter by

**Response:**

```json
[
  {
    "group_question_id": "uuid",
    "question_id": "uuid",
    "simulation_group_id": "uuid",
    "persona_id": "uuid",
    "title": "Medication History",
    "question_text": "Did you ask about current medications?",
    "weight_override": 1.5,
    "max_score_override": 10,
    "order": 1
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/simulation_group_questions?simulation_group_id=uuid&persona_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Assign Question to Group

Assign a question from the bank to a group + persona.

**Endpoint:** `POST /instructor/simulation_group_questions`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the simulation group
- `question_id` (string, required): ID of the question from the bank
- `persona_id` (string, required): ID of the persona

**Request Body:**

```json
{
  "weight_override": 1.5,
  "max_score_override": 10,
  "order": 1
}
```

**Parameters:**

- `weight_override` (number, optional): Override weight for scoring
- `max_score_override` (number, optional): Override max score
- `order` (integer, optional): Display order

**Response:** `201 Created`

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/simulation_group_questions?simulation_group_id=uuid&question_id=uuid&persona_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"weight_override": 1.5, "order": 1}'
```

---

### Update Question Assignment

Update overrides or reorder an assigned question.

**Endpoint:** `PUT /instructor/simulation_group_questions`

**Query Parameters:**

- `group_question_id` (string, required): ID of the assignment to update

**Request Body:**

```json
{
  "weight_override": 2.0,
  "max_score_override": 15,
  "order": 2
}
```

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/simulation_group_questions?group_question_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"weight_override": 2.0, "order": 2}'
```

---

### Unassign Question

Remove a question assignment from a group/persona.

**Endpoint:** `DELETE /instructor/simulation_group_questions`

**Query Parameters:**

- `group_question_id` (string, required): ID of the assignment to remove

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/simulation_group_questions?group_question_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Question Interactions

Get question interaction analytics for a simulation group.

**Endpoint:** `GET /instructor/question_interactions`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the simulation group
- `persona_id` (string, optional): Persona ID to filter by
- `student_email` (string, optional): Student email to filter by

**Response:**

```json
[
  {
    "question_id": "uuid",
    "question_text": "Did you ask about medications?",
    "times_asked": 15,
    "total_students": 20
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/question_interactions?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Key Question Coverage

Get per-patient key question coverage for debriefed students.

**Endpoint:** `GET /instructor/key_question_coverage`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the simulation group

**Response:**

```json
[
  {
    "persona_id": "uuid",
    "persona_name": "Maria Garcia",
    "coverage_percentage": 85,
    "total_questions": 10,
    "questions_covered": 8
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/key_question_coverage?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Patient Key Question Analytics

Get per-question student-asked counts for a specific patient.

**Endpoint:** `GET /instructor/patient_key_question_analytics`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the simulation group
- `persona_id` (string, required): ID of the persona (patient)

**Response:**

```json
[
  {
    "question_id": "uuid",
    "question_text": "Did you ask about allergies?",
    "students_asked": 18,
    "total_students": 25
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/patient_key_question_analytics?simulation_group_id=uuid&persona_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get DTP Bank (Instructor)

Browse the DTP bank (read-only).

**Endpoint:** `GET /instructor/dtp_bank`

**Query Parameters:**

- `organization_id` (string, required): ID of the organization

**Response:**

```json
[
  {
    "dtp_id": "uuid",
    "title": "Drug Interaction Warning",
    "expected_dtp_text": "Student should identify the interaction between...",
    "is_active": true
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/dtp_bank?organization_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Create DTP Item (Instructor)

Create a new DTP item in the organization's DTP bank. The `created_by` field is resolved server-side from the authenticated instructor's JWT email — it is not passed as a parameter.

**Endpoint:** `POST /instructor/dtp_bank`

**Authentication:** `instructorAuthorizer` (JWT)

**Query Parameters:**

- `organization_id` (string, required): ID of the organization to create the DTP item in

**Request Body:**

```json
{
  "title": "Untreated Indication",
  "expected_dtp_text": "Patient has hypertension with no antihypertensive therapy prescribed",
  "clinical_intent": "Student should recognize the untreated indication",
  "evaluation_criteria": "Student names the condition and the absent therapy",
  "tags": ["hypertension", "untreated"],
  "is_required": true
}
```

**Parameters:**

- `title` (string, required): DTP item title. A blank or whitespace-only value is rejected with **400**
- `expected_dtp_text` (string, required): The expected DTP statement. A blank or whitespace-only value is rejected with **400**
- `clinical_intent` (string, optional, default: `""`): Clinical intent behind the DTP. An omitted, null, or non-string value is stored as an empty string rather than `NULL`
- `evaluation_criteria` (string, optional, default: `""`): Criteria for evaluating the student's DTP. An omitted, null, or non-string value is stored as an empty string rather than `NULL`
- `tags` (array of strings, optional, default: `[]`): Tags for filtering and organization
- `is_required` (boolean, optional, default: `false`): Whether the DTP item must be identified

**Response Codes:**

| Status | Description |
|--------|-------------|
| 201 | Created — DTP item successfully created; the full row is returned |
| 400 | Bad Request — Missing `organization_id` or request body, a blank required field (the error names the field, e.g. `{"error": "title is required"}`), or `tags` is present but not an array |
| 401 | Unauthorized — Invalid or missing JWT token, or the authenticated identity could not be determined |
| 500 | Internal Server Error — Unexpected failure |

**Response (201 Created):**

```json
{
  "dtp_id": "uuid",
  "organization_id": "uuid",
  "created_by": "uuid",
  "title": "Untreated Indication",
  "expected_dtp_text": "Patient has hypertension with no antihypertensive therapy prescribed",
  "clinical_intent": "Student should recognize the untreated indication",
  "evaluation_criteria": "Student names the condition and the absent therapy",
  "tags": ["hypertension", "untreated"],
  "is_required": true,
  "is_active": true,
  "created_at": "2024-06-15T14:30:00.000Z"
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/dtp_bank?organization_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"title": "Untreated Indication", "expected_dtp_text": "Patient has hypertension with no antihypertensive therapy prescribed", "clinical_intent": "Recognize the untreated indication", "is_required": true, "tags": ["hypertension"]}'
```

> **Note:** Deleting DTP items is an admin-only operation. See [Delete DTP](#delete-dtp) in the [DTP Bank (Admin)](#dtp-bank-admin) section.

---

### Update DTP Item (Instructor)

Update a DTP item in the DTP bank.

**Endpoint:** `PUT /instructor/dtp_bank`

**Authentication:** `instructorAuthorizer` (JWT)

**Query Parameters:**

- `dtp_id` (string, required): ID of the DTP item to update

**Request Body:**

```json
{
  "title": "Updated Title",
  "expected_dtp_text": "Updated expected DTP text",
  "clinical_intent": "Updated clinical intent",
  "evaluation_criteria": "Updated criteria",
  "tags": ["hypertension", "untreated"],
  "is_required": true
}
```

**Parameters:**

- `title` (string, optional): New DTP item title
- `expected_dtp_text` (string, optional): New expected DTP statement
- `clinical_intent` (string, optional): New clinical intent
- `evaluation_criteria` (string, optional): New evaluation criteria
- `tags` (array of strings, optional): Replacement tag list. An empty array `[]` clears the stored tags; omitting the field leaves them unchanged
- `is_required` (boolean, optional): Whether the DTP item must be identified

Every field is optional — an omitted field retains its stored value.

**Response Codes:**

| Status | Description |
|--------|-------------|
| 200 | OK — DTP item updated; the full updated row is returned |
| 400 | Bad Request — Missing `dtp_id` or request body, or `tags` is present but not an array. A non-array `tags` value is rejected before any database write with `{"error": "tags must be an array of strings"}` |
| 401 | Unauthorized — Invalid or missing JWT token, or user lacks instructor role |
| 404 | Not Found — No DTP item matches `dtp_id` |
| 500 | Internal Server Error — Unexpected failure |

**Example (cURL):**

```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/dtp_bank?dtp_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"title": "Updated Title", "expected_dtp_text": "Updated expected DTP text", "clinical_intent": "Updated clinical intent", "is_required": true, "tags": ["hypertension", "untreated"]}'
```

> **Note:** `is_active` is deliberately not accepted on this endpoint. The instructor DTP bank read filters on `is_active = true`, so honouring `is_active` here would let a `PUT` hide an item permanently — a delete under another name. Deactivation remains an admin-only operation.

> **Note:** The instructor DTP bank resource exposes only `GET`, `POST`, and `PUT`. There is no `DELETE /instructor/dtp_bank` — deleting DTP items is an admin-only operation. See [Delete DTP](#delete-dtp) in the [DTP Bank (Admin)](#dtp-bank-admin) section.

---

### Get Recommendations Bank (Instructor)

Browse the recommendations bank (read-only).

**Endpoint:** `GET /instructor/recommendations_bank`

**Query Parameters:**

- `organization_id` (string, required): ID of the organization

**Response:**

```json
[
  {
    "recommendation_id": "uuid",
    "title": "Dosage Adjustment",
    "recommendation_text": "Recommend dose reduction based on renal function",
    "is_active": true
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/recommendations_bank?organization_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Create Recommendation Item (Instructor)

Create a new recommendation item in the organization's recommendations bank. The `created_by` field is resolved server-side from the authenticated instructor's JWT email — it is not passed as a parameter.

**Endpoint:** `POST /instructor/recommendations_bank`

**Authentication:** `instructorAuthorizer` (JWT)

**Query Parameters:**

- `organization_id` (string, required): ID of the organization to create the recommendation item in

**Request Body:**

```json
{
  "title": "Dosage Adjustment",
  "recommendation_text": "Reduce the dose based on the patient's renal function",
  "rationale": "Renal clearance is reduced, raising the risk of accumulation",
  "evaluation_criteria": "Student proposes a specific reduced dose and cites renal function",
  "tags": ["renal", "dosing"]
}
```

**Parameters:**

- `title` (string, required): Recommendation item title. A blank or whitespace-only value is rejected with **400**
- `recommendation_text` (string, required): The expected recommendation. A blank or whitespace-only value is rejected with **400**
- `rationale` (string, optional, default: `""`): Rationale behind the recommendation. An omitted, null, or non-string value is stored as an empty string rather than `NULL`
- `evaluation_criteria` (string, optional, default: `""`): Criteria for evaluating the student's recommendation. An omitted, null, or non-string value is stored as an empty string rather than `NULL`
- `tags` (array of strings, optional, default: `[]`): Tags for filtering and organization

**Response Codes:**

| Status | Description |
|--------|-------------|
| 201 | Created — Recommendation item successfully created; the full row is returned |
| 400 | Bad Request — Missing `organization_id` or request body, a blank required field (the error names the field, e.g. `{"error": "recommendation_text is required"}`), or `tags` is present but not an array |
| 401 | Unauthorized — Invalid or missing JWT token, or the authenticated identity could not be determined |
| 500 | Internal Server Error — Unexpected failure |

**Response (201 Created):**

```json
{
  "recommendation_id": "uuid",
  "organization_id": "uuid",
  "created_by": "uuid",
  "title": "Dosage Adjustment",
  "recommendation_text": "Reduce the dose based on the patient's renal function",
  "evaluation_criteria": "Student proposes a specific reduced dose and cites renal function",
  "rationale": "Renal clearance is reduced, raising the risk of accumulation",
  "tags": ["renal", "dosing"],
  "is_active": true,
  "created_at": "2024-06-15T14:30:00.000Z"
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/recommendations_bank?organization_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"title": "Dosage Adjustment", "recommendation_text": "Reduce the dose based on renal function", "rationale": "Reduced renal clearance raises accumulation risk", "tags": ["renal"]}'
```

> **Note:** Deleting recommendation items is an admin-only operation. See [Delete Recommendation](#delete-recommendation) in the [Recommendations Bank (Admin)](#recommendations-bank-admin) section.

---

### Update Recommendation Item (Instructor)

Update a recommendation item in the recommendations bank.

**Endpoint:** `PUT /instructor/recommendations_bank`

**Authentication:** `instructorAuthorizer` (JWT)

**Query Parameters:**

- `recommendation_id` (string, required): ID of the recommendation item to update

**Request Body:**

```json
{
  "title": "Updated Title",
  "recommendation_text": "Updated recommendation text",
  "rationale": "Updated rationale",
  "evaluation_criteria": "Updated criteria",
  "tags": ["renal", "dosing"]
}
```

**Parameters:**

- `title` (string, optional): New recommendation item title
- `recommendation_text` (string, optional): New expected recommendation
- `rationale` (string, optional): New rationale
- `evaluation_criteria` (string, optional): New evaluation criteria
- `tags` (array of strings, optional): Replacement tag list. An empty array `[]` clears the stored tags; omitting the field leaves them unchanged

Every field is optional — an omitted field retains its stored value.

**Response Codes:**

| Status | Description |
|--------|-------------|
| 200 | OK — Recommendation item updated; the full updated row is returned |
| 400 | Bad Request — Missing `recommendation_id` or request body, or `tags` is present but not an array. A non-array `tags` value is rejected before any database write with `{"error": "tags must be an array of strings"}` |
| 401 | Unauthorized — Invalid or missing JWT token, or user lacks instructor role |
| 404 | Not Found — No recommendation item matches `recommendation_id` |
| 500 | Internal Server Error — Unexpected failure |

**Example (cURL):**

```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/recommendations_bank?recommendation_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"title": "Updated Title", "recommendation_text": "Updated recommendation text", "rationale": "Updated rationale", "tags": ["renal", "dosing"]}'
```

> **Note:** `is_active` is deliberately not accepted on this endpoint. The instructor recommendations bank read filters on `is_active = true`, so honouring `is_active` here would let a `PUT` hide an item permanently — a delete under another name. Deactivation remains an admin-only operation.

> **Note:** The instructor recommendations bank resource exposes only `GET`, `POST`, and `PUT`. There is no `DELETE /instructor/recommendations_bank` — deleting recommendation items is an admin-only operation. See [Delete Recommendation](#delete-recommendation) in the [Recommendations Bank (Admin)](#recommendations-bank-admin) section.


---

## DTP Assignments

### Get Simulation Group DTPs

Get DTP assignments for a simulation group.

**Endpoint:** `GET /instructor/simulation_group_dtps`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the simulation group
- `persona_id` (string, optional): Persona ID to filter by

**Response:**

```json
[
  {
    "group_dtp_id": "uuid",
    "dtp_id": "uuid",
    "simulation_group_id": "uuid",
    "persona_id": "uuid",
    "title": "Drug Interaction Warning",
    "sort_order": 1
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/simulation_group_dtps?simulation_group_id=uuid&persona_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Assign DTP to Group

Assign one or more DTPs to a simulation group.

**Endpoint:** `POST /instructor/simulation_group_dtps`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the simulation group

**Request Body:**

```json
{
  "dtp_id": "uuid",
  "persona_id": "uuid"
}
```

**Parameters:**

- `dtp_id` (string or array of strings, required): DTP ID(s) to assign
- `persona_id` (string, optional): Persona to scope the assignment to

**Response:** `201 Created`

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/simulation_group_dtps?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"dtp_id": "uuid", "persona_id": "uuid"}'
```

---

### Reorder DTP Assignments

Reorder DTP assignments within a simulation group.

**Endpoint:** `PUT /instructor/simulation_group_dtps`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the simulation group

**Request Body:**

```json
{
  "order": [
    { "group_dtp_id": "uuid-1", "sort_order": 1 },
    { "group_dtp_id": "uuid-2", "sort_order": 2 }
  ]
}
```

**Parameters:**

- `order` (array, required): Array of objects with `group_dtp_id` and `sort_order`

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/simulation_group_dtps?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"order": [{"group_dtp_id": "uuid-1", "sort_order": 1}, {"group_dtp_id": "uuid-2", "sort_order": 2}]}'
```

---

### Unassign DTP from Group

Remove a DTP assignment from a group.

**Endpoint:** `DELETE /instructor/simulation_group_dtps`

**Query Parameters:**

- `group_dtp_id` (string, required): ID of the DTP assignment to remove

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/simulation_group_dtps?group_dtp_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Recommendation Assignments

### Get Simulation Group Recommendations

Get recommendation assignments for a simulation group.

**Endpoint:** `GET /instructor/simulation_group_recommendations`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the simulation group
- `persona_id` (string, optional): Persona ID to filter by

**Response:**

```json
[
  {
    "group_recommendation_id": "uuid",
    "recommendation_id": "uuid",
    "simulation_group_id": "uuid",
    "persona_id": "uuid",
    "title": "Dosage Adjustment",
    "sort_order": 1
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/simulation_group_recommendations?simulation_group_id=uuid&persona_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Assign Recommendation to Group

Assign one or more recommendations to a simulation group.

**Endpoint:** `POST /instructor/simulation_group_recommendations`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the simulation group

**Request Body:**

```json
{
  "recommendation_id": "uuid",
  "persona_id": "uuid"
}
```

**Parameters:**

- `recommendation_id` (string or array of strings, required): Recommendation ID(s) to assign
- `persona_id` (string, optional): Persona to scope the assignment to

**Response:** `201 Created`

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/simulation_group_recommendations?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"recommendation_id": "uuid", "persona_id": "uuid"}'
```

---

### Reorder Recommendation Assignments

Reorder recommendation assignments within a simulation group.

**Endpoint:** `PUT /instructor/simulation_group_recommendations`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the simulation group

**Request Body:**

```json
{
  "order": [
    { "group_recommendation_id": "uuid-1", "sort_order": 1 },
    { "group_recommendation_id": "uuid-2", "sort_order": 2 }
  ]
}
```

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/simulation_group_recommendations?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"order": [{"group_recommendation_id": "uuid-1", "sort_order": 1}]}'
```

---

### Unassign Recommendation from Group

Remove a recommendation assignment from a group.

**Endpoint:** `DELETE /instructor/simulation_group_recommendations`

**Query Parameters:**

- `group_recommendation_id` (string, required): ID of the recommendation assignment to remove

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/simulation_group_recommendations?group_recommendation_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Physical Assessment Materials

### Get Persona Media (Instructor)

Get physical assessment materials for a patient.

**Endpoint:** `GET /instructor/persona_media`

**Query Parameters:**

- `persona_id` (string, required): ID of the persona (patient)

**Response:**

```json
[
  {
    "media_id": "uuid",
    "persona_id": "uuid",
    "title": "Blood Pressure Reading",
    "description": "Recent BP measurement: 145/92",
    "media_type": "image",
    "url": "https://s3.amazonaws.com/bucket/..."
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/persona_media?persona_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Add Persona Media

Add a new physical assessment material.

**Endpoint:** `POST /instructor/persona_media`

**Query Parameters:**

- `persona_id` (string, required): ID of the persona (patient)

**Request Body:**

```json
{
  "title": "EKG Results",
  "description": "12-lead EKG showing normal sinus rhythm",
  "media_type": "image",
  "url": "https://s3.amazonaws.com/bucket/ekg.png"
}
```

**Response:** `201 Created`

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/persona_media?persona_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"title": "EKG Results", "description": "12-lead EKG", "media_type": "image", "url": "https://s3.amazonaws.com/bucket/ekg.png"}'
```

---

### Update Persona Media

Update an existing physical assessment material.

**Endpoint:** `PUT /instructor/persona_media`

**Query Parameters:**

- `media_id` (string, required): ID of the media to update

**Request Body:**

```json
{
  "title": "Updated EKG Results",
  "description": "Updated description",
  "media_type": "image",
  "url": "https://s3.amazonaws.com/bucket/ekg_v2.png"
}
```

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/persona_media?media_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"title": "Updated EKG Results", "description": "Updated", "media_type": "image", "url": "https://s3.amazonaws.com/bucket/ekg_v2.png"}'
```

---

### Delete Persona Media

Delete a physical assessment material.

**Endpoint:** `DELETE /instructor/persona_media`

**Query Parameters:**

- `media_id` (string, required): ID of the media to delete

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/persona_media?media_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Student Progress & Sessions

### Get Student Progress

Get student progress for a specific patient in a group.

**Endpoint:** `GET /instructor/student_progress`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the simulation group
- `persona_id` (string, required): ID of the persona

**Response:**

```json
[
  {
    "student_email": "student@example.com",
    "first_name": "Jane",
    "last_name": "Doe",
    "is_completed": true,
    "score": 85
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/student_progress?simulation_group_id=uuid&persona_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Completed Sessions

Get completed chat sessions for a simulation group. Used by the Prompt Playground for debrief prompt testing.

**Endpoint:** `GET /instructor/completed_sessions`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the simulation group

**Response:**

```json
[
  {
    "chat_id": "uuid",
    "chat_name": "Session 1",
    "last_accessed": "2024-05-20T14:30:00.000Z",
    "first_name": "Jane",
    "last_name": "Doe",
    "persona_name": "Maria Garcia",
    "persona_id": "uuid"
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/instructor/completed_sessions?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```


---

# Admin Endpoints

All admin endpoints require the `adminAuthorizer`. Additionally, the handler verifies admin access by checking that the user has `admin` in the database `roles` array (the only source of truth for roles). Role changes made through `elevate_instructor`, `lower_instructor`, `elevate_admin` and `lower_admin` are written to the `role_audit_log` table in the same transaction as the role update. If the check fails, the request is rejected with **403 Forbidden**.

## Instructor Management

### Get All Instructors

Get all users with the instructor role.

**Endpoint:** `GET /admin/instructors`

**Query Parameters:**

- `instructor_email` (string, optional): Email of the admin (backwards-compatible; the authenticated admin's email from the token is used for authorization)

**Response:**

```json
[
  {
    "user_email": "instructor@example.com",
    "first_name": "John",
    "last_name": "Smith"
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/instructors?instructor_email=admin@example.com" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Elevate to Instructor

Grant the instructor role to a registered user. The target user must exist in both Cognito (registered account) and the database (completed first sign-in).

**Endpoint:** `POST /admin/elevate_instructor`

**Query Parameters:**

- `email` (string, required): Email of the user to be elevated

**Security:**
- Verifies the target user exists in Cognito via `AdminGetUser`. Returns **400** if the user has not registered.
- Verifies the user exists in the database. Returns **400** if the user registered but hasn't completed sign-in (post-confirmation trigger hasn't fired).
- If the user already has `instructor` or `admin` role, no changes are made.

**Response:**

```json
{
  "message": "User role updated to instructor."
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/elevate_instructor?email=user@example.com" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json"
```

---

### Lower Instructor

Revoke instructor role and convert user back to student. Deletes all instructor enrollments.

**Endpoint:** `POST /admin/lower_instructor`

**Query Parameters:**

- `email` (string, required): Email of the user to be lowered

**Response:**

```json
{
  "message": "User role updated to student for user@example.com"
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/lower_instructor?email=instructor@example.com" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json"
```

---

### Enroll Instructor

Assign an instructor to a simulation group.

**Endpoint:** `POST /admin/enroll_instructor`

**Request Body:**

```json
{
  "simulation_group_id": "uuid",
  "instructor_email": "instructor@example.com"
}
```

**Parameters:**

- `simulation_group_id` (string, required): ID of the group
- `instructor_email` (string, required): Email of the instructor

**Response:**

```json
{
  "message": "Instructor enrolled and patients linked successfully"
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/enroll_instructor" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"simulation_group_id": "uuid", "instructor_email": "instructor@example.com"}'
```

---

### Delete Instructor Enrollments

Remove all enrollments for an instructor.

**Endpoint:** `DELETE /admin/delete_instructor_enrolments`

**Query Parameters:**

- `instructor_email` (string, required): Email of the instructor

**Response:**

```json
{
  "message": "Instructor enrolments deleted successfully."
}
```

**Example (cURL):**

```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/delete_instructor_enrolments?instructor_email=instructor@example.com" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Delete Group Instructor Enrollments

Remove all instructor enrollments from a specific group.

**Endpoint:** `DELETE /admin/delete_group_instructor_enrolments`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group

**Response:**

```json
{
  "message": "Group instructor enrolments deleted successfully."
}
```

**Example (cURL):**

```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/delete_group_instructor_enrolments?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Group Instructors

Get all instructors assigned to a group.

**Endpoint:** `GET /admin/groupInstructors`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group

**Response:**

```json
[
  {
    "user_email": "instructor@example.com",
    "first_name": "John",
    "last_name": "Smith"
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/groupInstructors?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Instructor Groups

Get all groups assigned to a specific instructor.

**Endpoint:** `GET /admin/instructorGroups`

**Query Parameters:**

- `instructor_email` (string, required): Email of the instructor

**Response:**

```json
[
  {
    "simulation_group_id": "uuid",
    "group_name": "Pharmacy 101",
    "group_description": "Intro simulation"
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/instructorGroups?instructor_email=instructor@example.com" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Simulation Group Management (Admin)

### Get All Simulation Groups

Get all simulation groups in the system.

**Endpoint:** `GET /admin/simulation_groups`

**Response:**

```json
[
  {
    "simulation_group_id": "uuid",
    "group_name": "Pharmacy 101",
    "group_description": "Introductory simulation",
    "group_access_code": "ABC123",
    "group_student_access": true,
    "persona_count": 3,
    "student_count": 25,
    "instructor_count": 2
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/simulation_groups" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Create Simulation Group (Admin)

Create a new simulation group.

**Endpoint:** `POST /admin/create_simulation_group`

**Request Body:**

```json
{
  "group_name": "Advanced Clinical Pharmacy",
  "group_description": "Complex patient scenarios",
  "group_student_access": true,
  "system_prompt": "You are a patient in a clinical simulation...",
  "admin_voice_enabled": true,
  "instructor_voice_enabled": true
}
```

**Parameters:**

- `group_name` (string, required): Name of the group
- `group_description` (string, required): Description
- `group_student_access` (boolean, required): Student access toggle
- `system_prompt` (string, optional): System prompt for the group
- `admin_voice_enabled` (boolean, optional): Admin voice toggle (default: true)
- `instructor_voice_enabled` (boolean, optional): Instructor voice toggle (default: true)

**Response:**

```json
{
  "simulation_group_id": "uuid"
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/create_simulation_group" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"group_name": "Advanced Clinical Pharmacy", "group_description": "Complex scenarios", "group_student_access": true}'
```

---

### Update Group Access

Update the student access setting for a group.

**Endpoint:** `POST /admin/updateGroupAccess`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group
- `access` (boolean, required): Student access status

**Response:**

```json
{
  "message": "Group settings updated successfully"
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/updateGroupAccess?simulation_group_id=uuid&access=true" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json"
```

---

### Regenerate Access Code

Generate a new access code for a simulation group.

**Endpoint:** `POST /admin/regenerate_access_code`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the simulation group

**Response:**

```json
{
  "access_code": "NEW789"
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/regenerate_access_code?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json"
```

---

### Delete Group

Delete a simulation group and all related records. Cascades deletion and cleans up S3 data.

**Endpoint:** `DELETE /admin/delete_group`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the group to delete

**Response:**

```json
{
  "message": "Group and related records deleted successfully."
}
```

**Example (cURL):**

```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/delete_group?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```


---

## System Prompts

### Get System Prompts

Get the current global system prompt and history.

**Endpoint:** `GET /admin/system_prompts`

**Response:**

```json
{
  "current_prompt": "You are a patient in a clinical pharmacy simulation...",
  "history": [
    {
      "history_id": "uuid",
      "prompt_content": "Previous prompt version...",
      "created_at": "2024-04-01T10:00:00.000Z"
    }
  ]
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/system_prompts" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Update System Prompt

Update the global system prompt.

**Endpoint:** `POST /admin/update_system_prompt`

**Request Body:**

```json
{
  "prompt_content": "You are a patient in a clinical pharmacy simulation. Respond naturally and realistically..."
}
```

**Parameters:**

- `prompt_content` (string, required): New system prompt content

**Response:**

```json
{
  "message": "System prompt updated successfully"
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/update_system_prompt" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"prompt_content": "You are a patient in a clinical pharmacy simulation..."}'
```

---

### Restore System Prompt

Restore a previous system prompt as the active prompt.

**Endpoint:** `POST /admin/restore_system_prompt`

**Query Parameters:**

- `history_id` (string, optional): History ID of the prompt to restore

**Request Body:**

```json
{
  "prompt_content": "Prompt content to restore (if no history_id)"
}
```

**Response:**

```json
{
  "message": "System prompt restored successfully"
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/restore_system_prompt?history_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json"
```

---

## Empathy Prompts

### Get Empathy Prompts

Get the current empathy evaluation prompt and history.

**Endpoint:** `GET /admin/empathy_prompts`

**Response:**

```json
{
  "current_prompt": "Evaluate the empathy displayed by the student...",
  "history": [
    {
      "history_id": "uuid",
      "prompt_content": "Previous empathy prompt...",
      "created_at": "2024-04-01T10:00:00.000Z"
    }
  ]
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/empathy_prompts" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Update Empathy Prompt

Update the empathy evaluation prompt.

**Endpoint:** `POST /admin/update_empathy_prompt`

**Request Body:**

```json
{
  "prompt_content": "Evaluate the empathy displayed by the student during this interaction..."
}
```

**Parameters:**

- `prompt_content` (string, required): New empathy evaluation prompt content

**Response:**

```json
{
  "message": "Empathy prompt updated successfully"
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/update_empathy_prompt" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"prompt_content": "Evaluate the empathy displayed by the student..."}'
```

---

### Restore Empathy Prompt

Restore the default empathy evaluation prompt.

**Endpoint:** `POST /admin/restore_empathy_prompt`

**Response:**

```json
{
  "message": "Default empathy prompt restored successfully"
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/restore_empathy_prompt" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json"
```

---

## Organization Management

### Get All Organizations

List all organizations.

**Endpoint:** `GET /admin/organizations`

**Response:**

```json
[
  {
    "organization_id": "uuid",
    "name": "University of Example",
    "description": "School of Pharmacy",
    "type": "university",
    "ai_persona": "Patient",
    "user_role": "Student",
    "icon_color": "#03045E"
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/organizations" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Organization

Get a specific organization by ID.

**Endpoint:** `GET /admin/organization`

**Query Parameters:**

- `organization_id` (string, required): ID of the organization

**Response:**

```json
{
  "organization_id": "uuid",
  "name": "University of Example",
  "description": "School of Pharmacy",
  "type": "university",
  "ai_persona": "Patient",
  "user_role": "Student",
  "icon_color": "#03045E",
  "system_prompt": "You are a patient..."
}
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/organization?organization_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Create Organization

Create a new organization.

**Endpoint:** `POST /admin/create_organization`

**Request Body:**

```json
{
  "name": "University of Example",
  "description": "School of Pharmacy",
  "type": "university",
  "ai_persona": "Patient",
  "user_role": "Student",
  "icon_color": "#03045E",
  "system_prompt": "You are a patient in a clinical simulation..."
}
```

**Parameters:**

- `name` (string, required): Organization name
- `description` (string, optional): Description
- `type` (string, optional): Organization type
- `ai_persona` (string, optional): Label for AI persona (default: "Patient")
- `user_role` (string, optional): Label for user role (default: "Student")
- `icon_color` (string, optional): Brand color hex (default: "#03045E")
- `system_prompt` (string, optional): Default system prompt

**Response:** `201 Created`

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/create_organization" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"name": "University of Example", "description": "School of Pharmacy", "type": "university"}'
```

---

### Update Organization

Update an existing organization.

**Endpoint:** `PUT /admin/update_organization`

**Query Parameters:**

- `organization_id` (string, required): ID of the organization to update

**Request Body:**

```json
{
  "name": "Updated University Name",
  "description": "Updated description",
  "type": "university",
  "ai_persona": "Patient",
  "user_role": "Student",
  "icon_color": "#1A237E",
  "system_prompt": "Updated prompt..."
}
```

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/update_organization?organization_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"name": "Updated University Name", "icon_color": "#1A237E"}'
```

---

### Delete Organization

Delete an organization.

**Endpoint:** `DELETE /admin/delete_organization`

**Query Parameters:**

- `organization_id` (string, required): ID of the organization to delete

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/delete_organization?organization_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```


---

## Question Bank (Admin)

### Get Question Bank

Get all questions in the question bank for an organization.

**Endpoint:** `GET /admin/question_bank`

**Query Parameters:**

- `organization_id` (string, required): ID of the organization

**Response:**

```json
[
  {
    "question_id": "uuid",
    "organization_id": "uuid",
    "title": "Medication History",
    "question_text": "Did you ask about current medications?",
    "evaluation_criteria": "Student should inquire about all current prescriptions",
    "category": "History Taking",
    "tags": ["medications", "history"],
    "difficulty_level": "basic",
    "is_mandatory": true,
    "weight": 1.0,
    "max_score": 10,
    "is_active": true,
    "created_at": "2024-01-15T10:00:00.000Z"
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/question_bank?organization_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Create Question

Create a new question in the question bank.

**Endpoint:** `POST /admin/question_bank`

**Query Parameters:**

- `organization_id` (string, required): ID of the organization
- `created_by` (string, required): User ID of the admin creating the question

**Request Body:**

```json
{
  "title": "Allergy Assessment",
  "question_text": "Did you ask about drug allergies?",
  "evaluation_criteria": "Student should specifically ask about known drug allergies and reactions",
  "category": "Safety",
  "tags": ["allergies", "safety"],
  "difficulty_level": "basic",
  "is_mandatory": true,
  "weight": 1.5,
  "max_score": 10,
  "is_active": true
}
```

**Parameters:**

- `title` (string, required): Question title
- `question_text` (string, required): Full question text
- `evaluation_criteria` (string, optional): Criteria for evaluating student performance
- `category` (string, optional): Question category
- `tags` (array of strings, optional): Tags for filtering
- `difficulty_level` (string, optional): Difficulty level
- `is_mandatory` (boolean, optional): Whether the question is mandatory
- `weight` (number, optional): Scoring weight
- `max_score` (integer, optional): Maximum score
- `is_active` (boolean, optional): Whether the question is active

**Response:** `201 Created`

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/question_bank?organization_id=uuid&created_by=admin-uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"title": "Allergy Assessment", "question_text": "Did you ask about drug allergies?", "evaluation_criteria": "Should ask about allergies", "is_mandatory": true}'
```

---

### Update Question

Update an existing question.

**Endpoint:** `PUT /admin/question_bank`

**Query Parameters:**

- `organization_id` (string, required): ID of the organization that owns the question. The update only matches a question in this organization; otherwise `404`.
- `question_id` (string, required): ID of the question to update

**Request Body:**

```json
{
  "title": "Updated Title",
  "question_text": "Updated question text",
  "evaluation_criteria": "Updated criteria",
  "category": "Updated Category",
  "tags": ["updated", "tags"],
  "difficulty_level": "intermediate",
  "is_mandatory": false,
  "weight": 2.0,
  "max_score": 15,
  "is_active": true
}
```

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/question_bank?organization_id=uuid&question_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"title": "Updated Title", "question_text": "Updated question", "is_mandatory": false}'
```

---

### Delete Question

Delete a question from the question bank.

**Endpoint:** `DELETE /admin/question_bank`

**Query Parameters:**

- `organization_id` (string, required): ID of the organization that owns the question. The delete only matches a question in this organization; otherwise `404`.
- `question_id` (string, required): ID of the question to delete

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/question_bank?organization_id=uuid&question_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## DTP Bank (Admin)

### Get DTP Bank

Get all DTP (Discrete Teaching Point) items for an organization.

**Endpoint:** `GET /admin/dtp_bank`

**Query Parameters:**

- `organization_id` (string, required): ID of the organization

**Response:**

```json
[
  {
    "dtp_id": "uuid",
    "organization_id": "uuid",
    "title": "Drug Interaction Warning",
    "expected_dtp_text": "Student should identify the interaction between lisinopril and potassium supplements",
    "clinical_intent": "Prevent hyperkalemia",
    "evaluation_criteria": "Must mention potassium monitoring",
    "tags": ["interactions", "safety"],
    "is_required": true,
    "is_active": true,
    "created_at": "2024-01-15T10:00:00.000Z"
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/dtp_bank?organization_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Create DTP

Create a new DTP item.

**Endpoint:** `POST /admin/dtp_bank`

**Query Parameters:**

- `organization_id` (string, required): ID of the organization

**Request Body:**

```json
{
  "title": "Renal Dose Adjustment",
  "expected_dtp_text": "Student should recommend dose adjustment based on creatinine clearance",
  "clinical_intent": "Prevent drug toxicity in renal impairment",
  "evaluation_criteria": "Must calculate CrCl and recommend appropriate dose",
  "tags": ["renal", "dosing"],
  "is_required": true
}
```

**Parameters:**

- `title` (string, required): DTP title
- `expected_dtp_text` (string, required): Expected teaching point text
- `clinical_intent` (string, optional): Clinical intent description
- `evaluation_criteria` (string, optional): Evaluation criteria
- `tags` (array of strings, optional): Tags for filtering
- `is_required` (boolean, optional): Whether this DTP is required

**Response:** `201 Created`

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/dtp_bank?organization_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"title": "Renal Dose Adjustment", "expected_dtp_text": "Student should recommend dose adjustment...", "is_required": true}'
```

---

### Update DTP

Update an existing DTP item.

**Endpoint:** `PUT /admin/dtp_bank`

**Query Parameters:**

- `organization_id` (string, required): ID of the organization that owns the DTP item. The update only matches an item in this organization; otherwise `404`.
- `dtp_id` (string, required): ID of the DTP item to update

**Request Body:**

```json
{
  "title": "Updated Title",
  "expected_dtp_text": "Updated expected text",
  "clinical_intent": "Updated intent",
  "evaluation_criteria": "Updated criteria",
  "tags": ["updated"],
  "is_required": false,
  "is_active": true
}
```

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/dtp_bank?organization_id=uuid&dtp_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"title": "Updated Title", "is_active": true}'
```

---

### Delete DTP

Delete a DTP item.

**Endpoint:** `DELETE /admin/dtp_bank`

**Query Parameters:**

- `organization_id` (string, required): ID of the organization that owns the DTP item. The delete only matches an item in this organization; otherwise `404`.
- `dtp_id` (string, required): ID of the DTP item to delete

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/dtp_bank?organization_id=uuid&dtp_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Recommendations Bank (Admin)

### Get Recommendations Bank

Get all recommendation items for an organization.

**Endpoint:** `GET /admin/recommendations_bank`

**Query Parameters:**

- `organization_id` (string, required): ID of the organization

**Response:**

```json
[
  {
    "recommendation_id": "uuid",
    "organization_id": "uuid",
    "title": "Dosage Adjustment",
    "recommendation_text": "Recommend dose reduction based on renal function",
    "evaluation_criteria": "Must reference GFR in recommendation",
    "rationale": "Prevents accumulation in renal impairment",
    "is_active": true,
    "created_at": "2024-01-15T10:00:00.000Z"
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/recommendations_bank?organization_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Create Recommendation

Create a new recommendation item.

**Endpoint:** `POST /admin/recommendations_bank`

**Query Parameters:**

- `organization_id` (string, required): ID of the organization

**Request Body:**

```json
{
  "title": "Monitor Liver Function",
  "recommendation_text": "Recommend periodic LFT monitoring with statin therapy",
  "evaluation_criteria": "Must mention monitoring frequency",
  "rationale": "Statins can cause hepatotoxicity"
}
```

**Parameters:**

- `title` (string, required): Recommendation title
- `recommendation_text` (string, required): Full recommendation text
- `evaluation_criteria` (string, optional): Evaluation criteria
- `rationale` (string, optional): Clinical rationale

**Response:** `201 Created`

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/recommendations_bank?organization_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"title": "Monitor Liver Function", "recommendation_text": "Recommend periodic LFT monitoring..."}'
```

---

### Update Recommendation

Update an existing recommendation item.

**Endpoint:** `PUT /admin/recommendations_bank`

**Query Parameters:**

- `organization_id` (string, required): ID of the organization that owns the recommendation. The update only matches an item in this organization; otherwise `404`.
- `recommendation_id` (string, required): ID of the recommendation to update

**Request Body:**

```json
{
  "title": "Updated Title",
  "recommendation_text": "Updated text",
  "evaluation_criteria": "Updated criteria",
  "rationale": "Updated rationale",
  "is_active": true
}
```

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X PUT "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/recommendations_bank?organization_id=uuid&recommendation_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"title": "Updated Title", "is_active": true}'
```

---

### Delete Recommendation

Delete a recommendation item.

**Endpoint:** `DELETE /admin/recommendations_bank`

**Query Parameters:**

- `organization_id` (string, required): ID of the organization that owns the recommendation. The delete only matches an item in this organization; otherwise `404`.
- `recommendation_id` (string, required): ID of the recommendation to delete

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/recommendations_bank?organization_id=uuid&recommendation_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Issue Reports & Feedback (Admin)

### Get Issue Reports

Get all student issue reports for a simulation group.

**Endpoint:** `GET /admin/issue_reports`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the simulation group

**Response:**

```json
[
  {
    "report_id": "uuid",
    "student_email": "student@example.com",
    "student_first_name": "Jane",
    "student_last_name": "Doe",
    "patient_name": "Maria Garcia",
    "issue_categories": ["Inaccurate response"],
    "details": "Patient mentioned wrong medication",
    "submitted_at": "2024-05-20T14:30:00.000Z"
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/issue_reports?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Delete Issue Report

Delete an issue report.

**Endpoint:** `DELETE /admin/issue_report`

**Query Parameters:**

- `report_id` (string, required): ID of the issue report to delete

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/issue_report?report_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Debrief Feedback

Get all debrief feedback for a simulation group.

**Endpoint:** `GET /admin/debrief_feedback`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the simulation group

**Response:**

```json
[
  {
    "feedback_id": "uuid",
    "student_email": "student@example.com",
    "student_first_name": "Jane",
    "student_last_name": "Doe",
    "patient_name": "Maria Garcia",
    "is_helpful": true,
    "comment": "Very detailed feedback",
    "submitted_at": "2024-05-20T15:00:00.000Z"
  }
]
```

**Example (cURL):**

```bash
curl -X GET "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/debrief_feedback?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Delete Debrief Feedback

Delete a debrief feedback entry.

**Endpoint:** `DELETE /admin/debrief_feedback`

**Query Parameters:**

- `feedback_id` (string, required): ID of the debrief feedback to delete

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X DELETE "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/debrief_feedback?feedback_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Message Limits

### Update Group Message Limit

Set the maximum number of student messages allowed per chat session for a group.

**Endpoint:** `POST /admin/update_group_message_limit`

**Query Parameters:**

- `simulation_group_id` (string, required): ID of the simulation group

**Request Body:**

```json
{
  "max_messages_per_chat": 50
}
```

**Parameters:**

- `max_messages_per_chat` (integer or null, required): Maximum messages per chat. Set to `null` for unlimited.

**Response:**

```json
{
  "message": "Message limit updated successfully",
  "max_messages_per_chat": 50
}
```

**Example (cURL):**

```bash
curl -X POST "https://api-id.execute-api.us-east-1.amazonaws.com/prod/admin/update_group_message_limit?simulation_group_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"max_messages_per_chat": 50}'
```
