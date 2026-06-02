# Google Drive → Constellation Document Processing Service

**Production-grade Node.js service** that reads medical documents from a Google Drive queue folder, applies OCR for title extraction, maps to LOINC document types, converts to base64, and generates structured JSON payloads for Constellation patient creation with MongoDB persistence.

---

## Architecture Overview

```
Google Drive Folder (Queue)
        ↓
    [Poll every 10s]
        ↓
   Read File (1st in folder)
        ↓
   Extract Patient ID from filename (MRN)
        ↓
   Download file & convert to Base64
        ↓
   Apply OCR to extract document title
        ↓
   Match title to Document Type mapping
        ↓
   Record in MongoDB (audit trail)
        ↓
   Build JSON payload:
   {
     "fileName": "12345_lab_result.PNG",
     "patientId": "12345",
     "documentType": "Lab. Test Results",
     "documentTypeDetails": {
       "category": "Laboratory",
       "loincCode": "83540.8",
       "loincDisplay": "Glucose in Serum"
     },
     "base64Image": "iVBORw0KGgo...",
     "timestamp": "2026-06-02T09:11:50.000Z"
   }
        ↓
   Save payload to file
        ↓
   Move file to "Processed" folder
        ↓
   Mark as "processed" in MongoDB
        ↓
   Next file...
```

---

## Prerequisites

- **Node.js** 16+ (we recommend LTS: 18 or 20)
- **npm** or **yarn**
- **Google Service Account** with Drive API enabled
- **MongoDB** 4.4+ (local or remote instance)
- **Tesseract OCR** (installed via Node package)
- Medical document files (PNG, PDF, JPEG, etc.)

---

## Step 1: Google Service Account Setup

### 1a. Create Google Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a **new project** or select existing
3. Go to **APIs & Services** → **Credentials**
4. Click **Create Credentials** → **Service Account**
5. Fill in:
   - Service account name: `mirth-file-processor`
   - Service account ID: (auto-filled)
6. Click **Create and Continue**
7. Skip optional steps, click **Done**

### 1b. Create Service Account Key

1. In the **Service Accounts** list, click the service account you just created
2. Go to **Keys** tab
3. Click **Add Key** → **Create new key**
4. Choose **JSON** format
5. **Download** the JSON file → save as `credentials.json` in your project root

### 1c. Enable Google Drive API

1. Go to **APIs & Services** → **Library**
2. Search for **"Google Drive API"**
3. Click it and press **Enable**

### 1d. Share Google Drive Folder with Service Account

1. In the downloaded `credentials.json`, find the `client_email` field
2. Get the email (looks like `mirth@project-123.iam.gserviceaccount.com`)
3. In Google Drive:
   - Create (or select) the **queue folder**
   - Right-click → **Share**
   - Paste the service account email
   - Grant **Editor** access
   - Click **Share**
4. Copy the **Folder ID** from the URL:
   - `https://drive.google.com/drive/folders/` **`1A2B3C4D5E6F7G8H9I0J`** ← This is the ID

---

## Step 2: MongoDB Setup

### 2a. Install MongoDB (if not already installed)

**Option A: Local MongoDB on Windows**
```powershell
# Download and install from https://www.mongodb.com/try/download/community

# Or via Chocolatey
choco install mongodb-community

# Start MongoDB
net start MongoDB
```

**Option B: MongoDB Atlas (Cloud)**
1. Go to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)
2. Create free account
3. Create a cluster
4. Get connection string: `mongodb+srv://username:password@cluster.mongodb.net/database`
5. Add to `.env` as `MONGO_URI`

**Verify MongoDB is running:**
```bash
mongo
# Or with MongoDB 6.0+:
mongosh
```

---

## Step 3: Local Setup

### 3a. Clone/Download Project

```bash
# Create project directory
mkdir google-drive-mirth-service
cd google-drive-mirth-service

# Download the files:
# - google-drive-mirth-service.js
# - package.json
# - .env.example
# - credentials.json (from Google Cloud Console)
```

### 3b. Install Dependencies

```bash
npm install
```

Expected output:
```
added 150+ packages, and audited 152 packages
```

### 3c. Configure Environment

```bash
# Create and edit .env
nano .env

# Add the following values:
```

**Example .env:**
```
# MongoDB Configuration
MONGO_URI=mongodb://localhost:27017
MONGO_DB_NAME=google_drive_mirth

# Google Drive Configuration
GOOGLE_KEY_FILE=./credentials.json
QUEUE_FOLDER_ID=1A2B3C4D5E6F7G8H9I0J
PROCESSED_FOLDER_ID=1X2Y3Z4D5E6F7G8H9ABC

# Service Configuration
SERVICE_PORT=3000
POLL_INTERVAL_MS=10000
LOG_LEVEL=info
NODE_ENV=production

# Document Type Mapping
DOCUMENT_TYPES_FILE=./mapping-documents-types.xlsx
```

---

## Step 4: Deployment

### 4a. Test the Service Locally

```bash
# Start the service
npm run start

# In another terminal, test health endpoint:
curl http://localhost:3000/health

# Expected response:
# {"status":"ok","timestamp":"2026-06-02T...","database":"connected"}
```

### 4b. Manual File Processing

```bash
# Upload a test file to QUEUE_FOLDER_ID in Google Drive
# File naming convention: <PATIENT_ID>_<description>.<ext>
# Example: 12345_lab_result.PNG

# Trigger manual processing:
curl -X POST http://localhost:3000/api/process-next

# Monitor logs:
npm run start 2>&1 | tail -f
```

### 4c. Verify Processing

Check after processing:

1. **Google Drive**: File should move to PROCESSED_FOLDER_ID
2. **MongoDB**: Run query:
   ```bash
   mongosh
   > use google_drive_mirth
   > db.file_queue.findOne({ status: "processed" })
   ```
3. **Payload Output**: Check `sample_output/` folder for generated JSON

**Example Mirth destination script** (simple logging):
```javascript
// In Mirth destination, Processor tab:
logger.info('Received file: ' + msg['fileName']);
logger.info('Patient ID: ' + msg['patientId']);
logger.info('Base64 size: ' + msg['base64'].length);

// Write to database or file system here
// Then respond with ACK
```

### 3b. Mirth Response

The service expects HTTP 200-299 status from Mirth. Customize the check in `isValidAck()`:

```javascript
// In MirthConnector.isValidAck():
isValidAck(response) {
  // Current: 200-299 status
  // Customize for your ACK format:
  return response.status >= 200 && response.status < 300;
  
  // Or check response body:
  // return response.data?.status === 'OK' || response.data?.success === true;
}
```

---

## Step 4: Run the Service

### 4a. Development Mode

```bash
npm run dev
```

**Expected output:**
```
[INFO] 2024-01-15T10:30:45.123Z - === Google Drive → Mirth Service Starting ===
[INFO] 2024-01-15T10:30:45.456Z - Configuration {
  googleDriveFolder: '1A2B3C4D5E6F7G8H9I0J',
  mirthEndpoint: 'http://localhost:8080/api/channels/receive',
  pollInterval: '10000ms',
  databaseEnabled: true
}
[INFO] 2024-01-15T10:30:46.789Z - Google Drive client initialized
[INFO] 2024-01-15T10:30:47.012Z - Database layer: ENABLED
[INFO] 2024-01-15T10:30:47.345Z - Service running on http://localhost:3000
[INFO] 2024-01-15T10:30:47.678Z - Polling started (every 10000ms)
```

### 4b. Test the Service

**In a separate terminal:**

```bash
# Health check
curl http://localhost:3000/health

# Expected response:
# {"status":"ok","timestamp":"2024-01-15T10:30:50.000Z","processing":false}

# Queue status
curl http://localhost:3000/api/queue-status

# Expected response (if DB enabled):
# {"pending":1,"processed":5,"failed":0}

# Manual trigger
curl -X POST http://localhost:3000/api/process-next

# Expected response:
# {"status":"File processing initiated"}
```

### 4c. Production Mode

```bash
# Using npm
npm start

# Or using Node directly
node google-drive-mirth-service.js

# Or using PM2 (recommended for production)
npm install -g pm2
pm2 start google-drive-mirth-service.js --name "mirth-file-processor"
pm2 logs mirth-file-processor
pm2 startup
pm2 save
```

---

## Step 5: Database Audit Trail (Optional)

### What the Database Tracks

If `DB_ENABLED=true`, the service creates `file-queue.db` with:

| Column | Type | Example |
|--------|------|---------|
| `id` | INTEGER | 1 |
| `googleFileId` | TEXT | `abc123def456` |
| `fileName` | TEXT | `19507-discharge.PNG` |
| `mimeType` | TEXT | `image/png` |
| `patientId` | TEXT | `19507` |
| `status` | TEXT | `pending` / `processed` / `failed` |
| `createdAt` | DATETIME | `2024-01-15 10:30:45` |
| `processedAt` | DATETIME | `2024-01-15 10:31:22` |
| `mirthAckReceived` | BOOLEAN | 1 / 0 |
| `errorMessage` | TEXT | `timeout` / `connection refused` |
| `attempts` | INTEGER | 1 / 2 / 3 |

### Query Examples

```bash
# Install sqlite3 CLI
apt-get install sqlite3

# Connect to database
sqlite3 file-queue.db

# View all files
sqlite> SELECT * FROM file_queue;

# View pending files
sqlite> SELECT fileName, patientId FROM file_queue WHERE status = 'pending';

# View failed files with errors
sqlite> SELECT fileName, errorMessage, attempts FROM file_queue WHERE status = 'failed';

# Count by status
sqlite> SELECT status, COUNT(*) as count FROM file_queue GROUP BY status;

# Exit
sqlite> .exit
```

---

## Step 6: Deployment (Linux/OCI VM)

### 6a. SSH to Linux VM

```powershell
# From Windows PowerShell
ssh -i path\to\private-key opc@your.vm.ip
```

### 6b. Install Node.js

```bash
# Ubuntu 22.04 (recommended)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node --version   # v20.x.x
npm --version    # 10.x.x
```

### 6c. Deploy Project

```bash
# Create app directory
sudo mkdir -p /opt/mirth-file-processor
cd /opt/mirth-file-processor

# Upload files from Windows:
# Use SCP or WinSCP to copy:
# - google-drive-mirth-service.js
# - package.json
# - credentials.json (SECURE: 600 permissions)
# - .env (SECURE: 600 permissions)

# Set permissions
sudo chown -R ubuntu:ubuntu /opt/mirth-file-processor
chmod 600 credentials.json
chmod 600 .env

# Install dependencies
npm install --production

# Start with PM2
npm install -g pm2
pm2 start google-drive-mirth-service.js --name "mirth-filer" --watch
pm2 startup systemd -u ubuntu --hp /home/ubuntu
pm2 save

# Verify running
pm2 logs mirth-filer
pm2 list
```

### 6d. Systemd Service (Alternative to PM2)

```bash
# Create service file
sudo nano /etc/systemd/system/mirth-file-processor.service
```

**File content:**
```ini
[Unit]
Description=Mirth File Processor Service
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/mirth-file-processor
ExecStart=/usr/bin/node /opt/mirth-file-processor/google-drive-mirth-service.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
EnvironmentFile=/opt/mirth-file-processor/.env

[Install]
WantedBy=multi-user.target
```

**Enable and start:**
```bash
sudo systemctl daemon-reload
sudo systemctl enable mirth-file-processor
sudo systemctl start mirth-file-processor
sudo systemctl status mirth-file-processor

# View logs
sudo journalctl -u mirth-file-processor -f
```

---

## Troubleshooting

### Problem: "Cannot find module 'googleapis'"

```bash
npm install
npm list googleapis
```

### Problem: "Invalid credentials"

1. Verify `credentials.json` exists and is valid JSON
2. Check `GOOGLE_KEY_FILE` in `.env` points to correct path
3. Verify Google Drive API is enabled
4. Verify service account has access to queue folder

```bash
# Test Google Drive access
cat credentials.json | jq '.client_email'  # Get email
# Make sure this email has Editor access to queue folder in Google Drive
```

### Problem: "Connection refused to Mirth"

1. Verify Mirth is running:
   ```bash
   curl http://localhost:8080/api/status
   ```

2. Verify correct endpoint in `.env`:
   ```
   MIRTH_BASE_URL=http://localhost:8080
   MIRTH_ENDPOINT=/api/channels/receive
   ```

3. Check Mirth logs for errors

### Problem: "No files being processed"

1. Verify queue folder ID in `.env` is correct
2. Put a test file in the Google Drive folder
3. Check logs: `npm run dev` and look for "Processing file"
4. Manually trigger: `curl -X POST http://localhost:3000/api/process-next`

### Problem: "ACK timeout or 500 error from Mirth"

1. Increase timeout: `MIRTH_TIMEOUT=60000` (60 seconds)
2. Check Mirth channel is running
3. Verify Mirth destination returns 200 status
4. Check Mirth logs for processing errors

### Enable Debug Logging

```bash
# In .env
LOG_LEVEL=debug

# Or start with debug:
DEBUG=* npm run dev
```

---

## Performance Tuning

### For High Volume

```bash
# .env adjustments
POLL_INTERVAL_MS=5000        # Check more frequently
MAX_CONCURRENT=3             # Process 3 files in parallel (adjust code to support)
MIRTH_TIMEOUT=60000          # Give Mirth more time
MIRTH_RETRIES=5              # More retries for reliability
```

### Memory & CPU

```bash
# Start with Node memory limit
node --max-old-space-size=2048 google-drive-mirth-service.js

# Or in PM2
pm2 start google-drive-mirth-service.js --max-memory-restart 2G
```

---

## Monitoring & Alerts

### Health Check Endpoint

```bash
# Every 30 seconds from monitoring tool
curl -s http://localhost:3000/health | jq '.status'
```

### Queue Status Endpoint

```bash
# Check queue depth periodically
curl -s http://localhost:3000/api/queue-status | jq '.pending'

# Alert if pending > 100
```

### Log Parsing

```bash
# Count errors in last hour
pm2 logs mirth-filer | grep ERROR | wc -l

# Watch for Mirth failures
pm2 logs mirth-filer | grep "Mirth send failed"
```

---

## Security Best Practices

1. **Credentials**: Never commit `credentials.json` or `.env` to Git
   ```bash
   echo "credentials.json" >> .gitignore
   echo ".env" >> .gitignore
   ```

2. **File Permissions**: Restrict credentials
   ```bash
   chmod 600 credentials.json
   chmod 600 .env
   ```

3. **Network**: Restrict Mirth endpoint access (firewall rules)

4. **Service Account**: Use minimal required permissions

5. **Secrets Management**: In production, use:
   - AWS Secrets Manager
   - Azure Key Vault
   - HashiCorp Vault
   - Google Secret Manager

6. **TLS/SSL**: If Mirth is remote, use HTTPS:
   ```bash
   MIRTH_BASE_URL=https://mirth-prod.company.com
   ```

---

## Code Customization

### Change File Naming Pattern

In `FileProcessor.extractPatientIdFromFileName()`:

```javascript
// Current: "19507-discharge.PNG" → "19507"
const match = fileName.match(/^(\d+)-/);

// Custom: Extract from different format
// "PATIENT_19507_discharge.PNG" → "19507"
const match = fileName.match(/PATIENT_(\d+)_/);

return match ? match[1] : 'UNKNOWN';
```

### Custom Mirth ACK Validation

In `MirthConnector.isValidAck()`:

```javascript
isValidAck(response) {
  // Current: HTTP 200-299
  return response.status >= 200 && response.status < 300;
  
  // Custom: Check response body
  if (response.data?.status === 'ACCEPTED') return true;
  if (response.data?.errorCode === 0) return true;
  return false;
}
```

### Disable Database

In `.env`:
```
DB_ENABLED=false
```

The service will skip all database operations.

---

## Architecture Decisions

### Sequential Processing (MAX_CONCURRENT=1)

**Why**: Healthcare integrations typically require strict ordering and auditing. Processing one file at a time ensures:
- Files are processed in order
- ACK is fully received before next file
- Database audit trail is clean
- Retry logic is straightforward

If you need parallel processing, modify the code to use a queue pool (e.g., `p-queue`).

### Exponential Backoff Retry

Failure delays: 2s → 4s → 8s (for 3 retries)

**Why**: Allows Mirth temporary issues to resolve without hammering the server.

### Base64 Encoding

All file types converted to base64 for JSON transport.

**Why**: Works for all MIME types (images, PDFs, documents). JSON-safe.

---

## API Reference

### POST /api/channels/receive (Mirth)

**Request:**
```json
{
  "fileName": "19507-discharge.PNG",
  "mimeType": "image/png",
  "patientId": "19507",
  "base64": "iVBORw0KGgo...",
  "timestamp": "2024-01-15T10:30:50.123Z"
}
```

**Response (Expected):**
```json
{
  "status": 200,
  "message": "OK"
}
```

### GET /health (Service)

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:50.000Z",
  "processing": false
}
```

### POST /api/process-next (Service)

Manually trigger processing of next file.

**Response:**
```json
{
  "status": "File processing initiated"
}
```

### GET /api/queue-status (Service)

**Response:**
```json
{
  "pending": 12,
  "processed": 156,
  "failed": 2
}
```

---

## Support & Maintenance

- **Logs**: Check `pm2 logs mirth-filer` or journalctl
- **Database**: Regular backups of `file-queue.db`
- **Dependencies**: Update periodically: `npm update`
- **Mirth Version**: Test with your specific Mirth version

---

**Version**: 1.0.0  
**Last Updated**: 2024-01-15  
**Author**: DevOps Integration Team
