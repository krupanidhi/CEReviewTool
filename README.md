# CE Review Check List Validator

A web-based tool for validating CE Review Check Lists using Azure Document Intelligence and Azure OpenAI.

## Features

- **Document Upload**: Upload PDF, images, or other document formats
- **Azure Document Intelligence**: Automatic text and structure extraction
- **JSON Output**: Structured JSON extraction from documents
- **Azure OpenAI Integration**: Fine-tuned model support for intelligent validation
- **Dark Theme UI**: Modern, professional interface matching Barrier Analysis tool

## Prerequisites

- Node.js 18+ and npm
- Azure Document Intelligence resource
- Azure OpenAI resource with fine-tuned model deployment

## Installation

```bash
# Install all dependencies (root, client, and server)
npm run install:all
```

## Configuration

Environment variables are configured in `.env`:

- `VITE_AZURE_DOC_ENDPOINT`: Azure Document Intelligence endpoint
- `VITE_AZURE_DOC_KEY`: Azure Document Intelligence API key
- `VITE_AZURE_OPENAI_ENDPOINT`: Azure OpenAI endpoint
- `VITE_AZURE_OPENAI_KEY`: Azure OpenAI API key
- `VITE_AZURE_OPENAI_DEPLOYMENT`: OpenAI deployment name (e.g., gpt-4)
- `PORT`: Server port (default: 3001)

## Running the Application

```bash
# Run both client and server in development mode
npm run dev

# Run client only
npm run dev:client

# Run server only
npm run dev:server
```

The application will be available at:
- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:3001

## API Endpoints

### POST /api/upload
Upload a document for processing
- **Body**: multipart/form-data with `file` field
- **Response**: JSON with extracted document data

### POST /api/analyze
Analyze extracted document data with Azure OpenAI
- **Body**: JSON with document data
- **Response**: Validation results and insights

### GET /api/documents
List all processed documents

## Project Structure

```
CEReviewTool/
├── client/              # React + Vite frontend
│   ├── src/
│   │   ├── components/  # React components
│   │   ├── services/    # API services
│   │   └── App.jsx      # Main app component
│   └── package.json
├── server/              # Express API server
│   ├── routes/          # API routes
│   ├── services/        # Azure service integrations
│   └── server.js        # Server entry point
├── documents/           # Uploaded documents storage
└── package.json         # Root package.json
```

## Development

The tool uses:
- **Frontend**: React 18, Vite, TailwindCSS
- **Backend**: Express, Azure SDK
- **Document Processing**: Azure Document Intelligence SDK
- **AI Integration**: Azure OpenAI SDK

## License

ISC
