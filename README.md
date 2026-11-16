# Patient Interaction Practice Tool

This prototype is a simulation platform for pharmacy education built on AWS. Students interact with AI-powered patient personas through text and voice chat, practicing clinical assessment and communication skills in a safe, repeatable environment. Instructors create simulation groups with configurable patient scenarios, and the system generates AI-powered debriefs evaluating student performance against key clinical questions.

## Documentation

| Document | Description |
|----------|-------------|
| [Deployment Guide](docs/DEPLOYMENT_GUIDE.md) | End-to-end deployment instructions, prerequisites, and troubleshooting |
| [Architecture Deep Dive](docs/ARCHITECTURE_DEEP_DIVE.md) | System architecture, component breakdown, data flows, and database schema |
| [User Guide](docs/USER_GUIDE.md) | How to use the platform as a student, instructor, or admin |
| [Modification Guide](docs/MODIFICATION_GUIDE.md) | Customizing colors, extending the API, configuring LLMs, and local dev setup |
| [Database Migrations](docs/DATABASE_MIGRATIONS.md) | Migration system usage, patterns, and safety guidelines |
| [Dependency Management](docs/DEPENDENCY_MANAGEMENT.md) | Dependency locking and update procedures for Python and Node.js |
| [API Documentation](docs/api-documentation.md) | REST API endpoints, request/response formats |
| [Data Ingestion](docs/DATA_INGESTION.md) | Document processing pipeline for patient case materials |
| [Bedrock Guardrails](docs/BEDROCK_GUARDRAILS.md) | AI safety guardrails configuration |
| [Voice Agent Setup](docs/AGENTCORE_VOICE_AGENT_SETUP.md) | Bedrock AgentCore voice agent deployment |
| [Voice Agent Deep Dive](docs/VOICE_AGENT_DEEP_DIVE.md) | Voice architecture and Nova Sonic integration |
| [Custom Domain & SES](docs/CUSTOM_DOMAIN_AND_SES.md) | Custom domain setup, SES email delivery, and Amplify hosting |
| [Contributing to Docs](docs/CONTRIBUTING_DOCS.md) | Guidelines for writing and maintaining documentation |
| [Changelog](docs/CHANGELOG.md) | Version history and release notes |

## High-Level Architecture

![Architecture Diagram](docs/architecture-diagram-no-numberings-with-ses.drawio.png)

For a detailed breakdown of each component, data flows, and the full database schema, see the [Architecture Deep Dive](docs/ARCHITECTURE_DEEP_DIVE.md).

## Directories

```
.
├── cdk/                  # AWS CDK infrastructure + backend services
│   ├── bin/              # CDK app entry point
│   ├── lib/              # CDK stack definitions
│   ├── lambda/           # Lambda function source code (JS + Python)
│   ├── text_generation/  # AI text generation service (Docker Lambda)
│   ├── data_ingestion/   # Document processing pipeline (Docker Lambda)
│   ├── socket-server/    # Real-time server (ECS Fargate)
│   ├── voice-agent/      # Bedrock AgentCore voice agent
│   └── layers/           # Lambda layers (shared dependencies)
├── frontend/             # React SPA (Vite + Tailwind + shadcn/ui)
│   └── src/
│       ├── pages/        # Route-level page components
│       ├── components/   # Reusable UI components
│       ├── services/     # API service layers
│       ├── hooks/        # Custom React hooks
│       └── lib/          # Shared utilities
├── docs/                 # Project documentation
└── scripts/              # Utility scripts
```

| Directory | Description |
|-----------|-------------|
| `/cdk` | AWS CDK infrastructure code (TypeScript) |
| `/cdk/bin` | CDK app entry point and stack orchestration |
| `/cdk/lib` | CDK stack definitions for all infrastructure (VPC, database, API, auth, hosting, WAF) |
| `/cdk/lambda` | Lambda function source code (Node.js 22.x and Python 3.12) |
| `/cdk/layers` | Lambda layers for shared dependencies (postgres, psycopg2, aws-jwt-verify, jose) |
| `/cdk/text_generation` | AI text generation service — LangChain + Bedrock for chat, debriefs, question matching (Docker Lambda) |
| `/cdk/data_ingestion` | Document processing pipeline — PDF ingestion into pgvector store (Docker Lambda) |
| `/cdk/socket-server` | Real-time server — Socket.IO voice on ECS Fargate |
| `/cdk/voice-agent` | Bedrock AgentCore voice agent with Nova Sonic |
| `/frontend` | React 19 frontend application (TypeScript, Vite, Tailwind CSS, shadcn/ui) |
| `/frontend/src/pages` | Page-level components organized by user role (student, instructor, admin) |
| `/frontend/src/components` | Reusable UI components and shadcn/ui primitives |
| `/frontend/src/services` | API service layer for backend communication |
| `/frontend/src/hooks` | Custom React hooks including WebSocket and panel management |
| `/frontend/src/lib` | Shared utilities (auth, API client, browser detection, debrief parsing) |
| `/docs` | Project documentation including deployment, architecture, and user guides |


## Technology Stack

### Frontend

- React 19 with TypeScript
- Vite 7 for build tooling
- Tailwind CSS 4 for styling
- shadcn/ui (Radix UI) for UI components
- AWS Amplify v6 for Cognito authentication
- Recharts for analytics charts
- React Router v7 for client-side routing
- Socket.IO client for real-time communication

### Backend

- AWS Lambda (Node.js 22 and Python 3.12) for serverless compute
- Amazon Bedrock with Claude Sonnet 5.5 (Anthropic) for LLM inference
- Cohere Embed v4 via Amazon Bedrock for vector embeddings
- LangChain for AI orchestration (chat, debriefs, question matching)
- PostgreSQL 16 (Amazon RDS) with pgvector for relational and vector data storage
- Amazon DynamoDB for conversation session state
- Amazon S3 for document and file storage
- Amazon API Gateway (REST) for API management
- AWS AppSync (GraphQL) for real-time text streaming subscriptions
- Amazon Cognito for authentication and authorization


### Real-Time & Voice

- Socket.IO on ECS Fargate for WebSocket communication
- Amazon Bedrock AgentCore with Nova Sonic 2.0 for speech-to-speech voice AI

### Infrastructure

- AWS CDK v2 (TypeScript) for infrastructure as code
- AWS CodePipeline and CodeBuild for CI/CD
- Amazon ECS Fargate for containerized services
- Amazon RDS with RDS Proxy for managed PostgreSQL
- Amazon VPC for network isolation
- AWS WAF for API and AppSync protection
- Amazon CloudFront for content delivery
- Amazon SES for email delivery
- AWS Amplify Hosting for frontend deployment

## Credits

This application was architected and developed by [Ayush Srihari](https://www.linkedin.com/in/ayush-s-7b500b1a1/) and [Rajrupa Sanyal](https://www.linkedin.com/in/rajrupa-sanyal-7b7557276/) with project assistance by [Carrie Schulz](https://www.linkedin.com/in/carrie-schulz/). Thanks to the UBC Cloud Innovation Centre Technical and Project Management teams for their guidance and support.



## License

This project is licensed under the [MIT License](LICENSE).

Licenses of libraries and tools used by the system are listed below:

[PostgreSQL license](https://www.postgresql.org/about/licence/) - For PostgreSQL — a liberal open source license, similar to BSD or MIT.

[Anthropic Acceptable Use Policy](https://www.anthropic.com/legal/aup) -  For Cohere Embed English v3, accessed via Amazon Bedrock for vector embeddings.

[Cohere terms of use](https://cohere.com/terms-of-use) - For Claude Haiku 4.5 and Claude Sonnet 5.5, accessed via Amazon Bedrock for text generation.