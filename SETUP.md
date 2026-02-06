# CE Review Tool - Setup Guide

## Quick Start

Follow these steps to get the CE Review Tool up and running:

### 1. Install Dependencies

```bash
# Navigate to project root
cd C:\Users\KPeterson\CascadeProjects\CEReviewTool

# Install all dependencies (root, client, and server)
npm run install:all
```

This will install:
- Root dependencies (concurrently for running both servers)
- Client dependencies (React, Vite, TailwindCSS, Lucide icons, Axios)
- Server dependencies (Express, Azure SDKs, Multer for file uploads)

### 2. Verify Environment Variables

The `.env` file should already be configured with your Azure credentials:

```env
# Azure Document Intelligence
VITE_AZURE_DOC_ENDPOINT=https://eastus.api.cognitive.microsoft.com/
VITE_AZURE_DOC_KEY=4584da939fd449f7aeb19db68a39b054

# Azure OpenAI
VITE_AZURE_OPENAI_ENDPOINT=https://dmiai.openai.azure.com/
VITE_AZURE_OPENAI_KEY=AylJ7jnWCBDscUdJF4Qx8bXmxvpRKrDqsEGKyZl0hwHyeSqAU53KJQQJ99CAACYeBjFXJ3w3AAABACOGivS7
VITE_AZURE_OPENAI_DEPLOYMENT=gpt-4

# Server Configuration
PORT=3001
```

### 3. Start the Application

```bash
# Run both client and server concurrently
npm run dev
```

This will start:
- **Frontend (React + Vite)**: http://localhost:5173
- **Backend (Express API)**: http://localhost:3001

### 4. Access the Application

Open your browser and navigate to:
```
http://localhost:5173
```

## Project Structure

```
CEReviewTool/
├── client/                      # React frontend
│   ├── src/
│   │   ├── components/
│   │   │   ├── DocumentUpload.jsx    # File upload with drag-drop
│   │   │   ├── DocumentList.jsx      # Document library view
│   │   │   └── AnalysisView.jsx      # Analysis results display
│   │   ├── services/
│   │   │   └── api.js                # API client functions
│   │   ├── App.jsx                   # Main application component
│   │   ├── main.jsx                  # React entry point
│   │   └── index.css                 # Global styles (dark theme)
│   ├── index.html
│   ├── vite.config.js
│   ├── tailwind.config.js
│   └── package.json
│
├── server/                      # Express API server
│   ├── routes/
│   │   ├── upload.js                 # Document upload endpoint
│   │   ├── analyze.js                # AI analysis endpoints
│   │   └── documents.js              # Document management endpoints
│   ├── services/
│   │   ├── documentIntelligence.js   # Azure Document Intelligence SDK
│   │   └── openAI.js                 # Azure OpenAI SDK
│   ├── server.js                     # Server entry point
│   └── package.json
│
├── documents/                   # Uploaded documents storage
├── .env                        # Environment variables
├── package.json                # Root package.json
├── README.md                   # Project documentation
└── SETUP.md                    # This file

```

## Features

### 1. Document Upload
- Drag-and-drop interface
- Supports PDF, Word, images (JPEG, PNG, TIFF, BMP)
- Maximum file size: 50MB
- Automatic Azure Document Intelligence processing

### 2. Document Intelligence
- Text extraction from any document format
- Table detection and extraction
- Key-value pair recognition
- Page structure analysis
- Paragraph and style detection

### 3. AI-Powered Analysis
- Azure OpenAI GPT-4 integration
- Intelligent document validation
- CE review checklist validation
- Structured JSON output
- Custom prompt support

### 4. Document Library
- View all processed documents
- Search and filter capabilities
- Download extracted JSON data
- Delete documents
- View detailed analysis results

## API Endpoints

### Document Upload
```
POST /api/upload
Content-Type: multipart/form-data
Body: { file: <file> }
```

### List Documents
```
GET /api/documents
```

### Get Document Details
```
GET /api/documents/:id
```

### Delete Document
```
DELETE /api/documents/:id
```

### AI Analysis
```
POST /api/analyze
Content-Type: application/json
Body: { documentData: <object>, prompt?: <string> }
```

### Checklist Validation
```
POST /api/analyze/validate
Content-Type: application/json
Body: { documentData: <object>, checklist: <array> }
```

### Health Check
```
GET /api/health
```

## Integration with Azure Foundry Fine-Tuned Models

To use a fine-tuned model from Azure Foundry:

1. **Update the deployment name** in `.env`:
   ```env
   VITE_AZURE_OPENAI_DEPLOYMENT=your-fine-tuned-model-name
   ```

2. **The system will automatically use the fine-tuned model** for all AI analysis operations.

3. **Custom validation prompts** can be sent via the API:
   ```javascript
   await analyzeDocument(documentData, "Your custom prompt here")
   ```

## Troubleshooting

### Port Already in Use
If port 3001 or 5173 is already in use:
1. Change the port in `.env` (for server)
2. Change the port in `client/vite.config.js` (for client)

### Azure Credentials Issues
Verify your Azure credentials are correct:
```bash
# Test the API health endpoint
curl http://localhost:3001/api/health
```

### File Upload Fails
- Check file size (max 50MB)
- Verify file format is supported
- Check server logs for detailed error messages

### CSS Not Loading
The `@tailwind` warnings in CSS are normal before running `npm install`. They will resolve after TailwindCSS is installed.

## Development

### Run Client Only
```bash
npm run dev:client
```

### Run Server Only
```bash
npm run dev:server
```

### Build for Production
```bash
npm run build
```

## Next Steps

1. Upload a test document to verify Document Intelligence integration
2. Run AI analysis to verify Azure OpenAI integration
3. Customize the validation checklist for your CE review requirements
4. Integrate with your fine-tuned model by updating the deployment name

## Support

For issues or questions:
- Check server logs in the terminal
- Check browser console for client-side errors
- Verify Azure service quotas and limits
- Ensure all environment variables are correctly set
