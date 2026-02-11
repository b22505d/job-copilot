from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parents[1]
PROFILE_PATH = BASE_DIR / "profile.json"


class PersonalInfo(BaseModel):
    first_name: str
    last_name: str
    email: str
    phone: str
    location: str


class Links(BaseModel):
    linkedin: str = ""
    github: str = ""
    portfolio: str = ""


class WorkAuth(BaseModel):
    need_sponsorship: bool = False
    work_authorization: str = ""


class ExperienceItem(BaseModel):
    company: str
    title: str
    start_date: str = ""
    end_date: str = ""
    location: str = ""
    summary: str = ""


class EducationItem(BaseModel):
    school: str
    degree: str
    start_date: str = ""
    end_date: str = ""


class Documents(BaseModel):
    resume_url: str = ""
    cover_letter_url: str = ""


class Profile(BaseModel):
    personal: PersonalInfo
    links: Links
    work_auth: WorkAuth
    experience: list[ExperienceItem] = Field(default_factory=list)
    education: list[EducationItem] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    documents: Documents


class LoginRequest(BaseModel):
    email: str
    password: str


class ResumeUploadRequest(BaseModel):
    filename: str


class AuditEvent(BaseModel):
    site: str
    job_url: str
    filled_fields: list[str] = Field(default_factory=list)
    skipped_fields: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class JobEvent(BaseModel):
    site: str
    job_url: str
    title: str = ""
    company: str = ""
    external_job_id: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)


app = FastAPI(title="Job Copilot MVP API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def load_profile() -> Profile:
    if not PROFILE_PATH.exists():
        raise HTTPException(status_code=500, detail="profile.json is missing")
    with PROFILE_PATH.open("r", encoding="utf-8") as file:
        return Profile.model_validate(json.load(file))


def save_profile(profile: Profile) -> None:
    with PROFILE_PATH.open("w", encoding="utf-8") as file:
        json.dump(profile.model_dump(mode="json"), file, indent=2)


profile_store = load_profile()
audit_events: list[dict[str, Any]] = []
saved_jobs: list[dict[str, Any]] = []
applied_jobs: list[dict[str, Any]] = []


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/auth/login")
def login(_: LoginRequest) -> dict[str, str]:
    # Local MVP auth stub. Replace with real auth in production.
    return {"access_token": "local-dev-token", "token_type": "bearer"}


@app.get("/profile", response_model=Profile)
def get_profile() -> Profile:
    return profile_store


@app.put("/profile", response_model=Profile)
def put_profile(profile: Profile) -> Profile:
    global profile_store
    profile_store = profile
    save_profile(profile_store)
    return profile_store


@app.post("/documents/resume")
def upload_resume(payload: ResumeUploadRequest) -> dict[str, str]:
    file_id = str(uuid4())
    base = os.getenv("SIGNED_URL_BASE", "https://s3.local.example/resumes")
    signed_url = f"{base}/{file_id}/{payload.filename}?signature=dev"
    return {"file_id": file_id, "signed_url": signed_url}


@app.post("/events/audit")
def create_audit_event(event: AuditEvent) -> dict[str, Any]:
    event_id = str(uuid4())
    record = {
        "id": event_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **event.model_dump(mode="json"),
    }
    audit_events.append(record)
    return {"id": event_id, "status": "recorded"}


@app.post("/jobs/save")
def save_job(event: JobEvent) -> dict[str, Any]:
    event_id = str(uuid4())
    record = {
        "id": event_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "status": "saved",
        **event.model_dump(mode="json"),
    }
    saved_jobs.append(record)
    return {"id": event_id, "status": "saved"}


@app.get("/jobs/save")
def list_saved_jobs() -> dict[str, Any]:
    return {"items": saved_jobs, "count": len(saved_jobs)}


@app.post("/jobs/applied")
def mark_job_applied(event: JobEvent) -> dict[str, Any]:
    event_id = str(uuid4())
    record = {
        "id": event_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "status": "applied",
        **event.model_dump(mode="json"),
    }
    applied_jobs.append(record)
    return {"id": event_id, "status": "applied"}


@app.get("/jobs/applied")
def list_applied_jobs() -> dict[str, Any]:
    return {"items": applied_jobs, "count": len(applied_jobs)}
