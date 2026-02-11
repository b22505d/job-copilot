# Job Copilot MVP Starter

This repo includes:
- `backend/`: FastAPI service with profile and tracking endpoints
- `extension/`: Chrome Extension (Manifest V3) that autofills Greenhouse forms

## 1) Run backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Endpoints implemented:
- `POST /auth/login` (local stub)
- `GET /profile`
- `PUT /profile`
- `POST /documents/resume` (returns mock signed URL + file id)
- `POST /events/audit`
- `POST /jobs/save`
- `GET /jobs/save`
- `POST /jobs/applied`
- `GET /jobs/applied`

Canonical profile is in `backend/profile.json`.
For this MVP scaffold, profile persistence is file-based and job/audit events are in-memory; swap to Postgres + S3-compatible storage next.

## 2) Load extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `extension/`

## 3) Use autofill

1. Open a Greenhouse job application page
2. Click extension icon
3. Keep backend URL as `http://127.0.0.1:8000` (or change it)
4. Click **Autofill Current Tab**
5. Review all fields manually and submit yourself

Safety behavior:
- Never auto-submits
- Skips low-confidence matches
- Shows in-page summary panel (filled/skipped/missing)
- Sends audit log to backend

## 4) Quick validation target

- Test on at least 3 Greenhouse postings
- Confirm fills for: first name, last name, email, phone, linkedin
- Confirm low-confidence fields are highlighted and skipped

## 5) Next step

Add a Lever adapter with the same interface:
- `detect()`
- `extract_fields()`
- `map_fields()`
- `fill()`
- `upload_resume()`
