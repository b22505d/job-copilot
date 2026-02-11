from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
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


class AiFieldQuestion(BaseModel):
    field_id: str
    label: str
    field_type: str
    required: bool = False
    options: list[str] = Field(default_factory=list)
    current_value: Any = None


class AiFieldAnswer(BaseModel):
    field_id: str
    value: Any = ""
    confidence: float = 0.0
    reason: str = ""
    source: str = "inferred"


class AiAnswerRequest(BaseModel):
    site: str
    job_url: str
    job_title: str = ""
    company: str = ""
    job_description: str = ""
    fields: list[AiFieldQuestion] = Field(default_factory=list)
    profile: Optional[Profile] = None


class AiAnswerResponse(BaseModel):
    answers: list[AiFieldAnswer] = Field(default_factory=list)
    used_llm: bool = False
    model: str = ""
    message: str = ""


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


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", text.lower())).strip()


def clamp_confidence(score: float) -> float:
    return max(0.0, min(1.0, score))


def parse_json_from_llm(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text)
    return json.loads(text)


def pick_best_option(options: list[str], terms: list[str]) -> Optional[str]:
    normalized_options = [(option, normalize_text(option)) for option in options if option.strip()]
    for term in terms:
        normalized_term = normalize_text(term)
        for option, normalized_option in normalized_options:
            if normalized_term and normalized_term in normalized_option:
                return option
    return None


def build_heuristic_answers(profile: Profile, fields: list[AiFieldQuestion]) -> list[AiFieldAnswer]:
    answers: list[AiFieldAnswer] = []

    for field in fields:
        label = normalize_text(field.label)
        options = field.options
        value: Any = None
        confidence = 0.0
        reason = ""

        if "sponsor" in label:
            sponsorship_needed = bool(profile.work_auth.need_sponsorship)
            preferred = "Yes" if sponsorship_needed else "No"
            selected = pick_best_option(options, [preferred])
            value = selected or preferred
            confidence = 0.82
            reason = "Derived from profile.work_auth.need_sponsorship."
        elif "authorized to work" in label or "work authorization" in label:
            authorization = (profile.work_auth.work_authorization or "").strip()
            selected = pick_best_option(options, [authorization, "Yes"])
            value = selected or authorization or "Yes"
            confidence = 0.78
            reason = "Derived from profile.work_auth.work_authorization."
        elif "linkedin" in label and profile.links.linkedin:
            value = profile.links.linkedin
            confidence = 0.9
            reason = "Copied from profile.links.linkedin."
        elif "github" in label and profile.links.github:
            value = profile.links.github
            confidence = 0.9
            reason = "Copied from profile.links.github."
        elif "portfolio" in label and profile.links.portfolio:
            value = profile.links.portfolio
            confidence = 0.9
            reason = "Copied from profile.links.portfolio."
        elif "location" in label and profile.personal.location:
            value = profile.personal.location
            confidence = 0.82
            reason = "Copied from profile.personal.location."

        if value is None:
            continue

        answers.append(
            AiFieldAnswer(
                field_id=field.field_id,
                value=value,
                confidence=clamp_confidence(confidence),
                reason=reason,
                source="profile",
            )
        )

    return answers


def call_openai_for_field_answers(request: AiAnswerRequest, profile: Profile) -> tuple[list[AiFieldAnswer], str]:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        return [], ""

    model = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
    api_base = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1").rstrip("/")
    url = f"{api_base}/chat/completions"

    system_prompt = (
        "You are a job application assistant. Return JSON only with this shape: "
        "{\"answers\":[{\"field_id\":\"...\",\"value\":...,\"confidence\":0.0-1.0,"
        "\"reason\":\"...\",\"source\":\"resume|job_description|profile|inferred\"}]}. "
        "Rules: do not invent facts, prefer profile data, choose option values exactly from provided options, "
        "and keep confidence below 0.75 when uncertain."
    )
    user_payload = {
        "profile": profile.model_dump(mode="json"),
        "job": {
            "site": request.site,
            "job_url": request.job_url,
            "job_title": request.job_title,
            "company": request.company,
            "job_description": request.job_description[:12000],
        },
        "fields": [field.model_dump(mode="json") for field in request.fields],
    }
    body = {
        "model": model,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(user_payload)},
        ],
    }
    request_data = json.dumps(body).encode("utf-8")
    http_request = urllib.request.Request(
        url,
        data=request_data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(http_request, timeout=60) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"OpenAI API error ({exc.code}): {details[:500]}") from exc
    except Exception as exc:  # pragma: no cover - network errors are environment-specific
        raise RuntimeError(f"OpenAI request failed: {exc}") from exc

    try:
        content = payload["choices"][0]["message"]["content"]
        parsed = parse_json_from_llm(content)
    except Exception as exc:
        raise RuntimeError(f"Could not parse OpenAI response: {exc}") from exc

    output: list[AiFieldAnswer] = []
    for item in parsed.get("answers", []):
        try:
            answer = AiFieldAnswer.model_validate(item)
            answer.confidence = clamp_confidence(float(answer.confidence))
            output.append(answer)
        except Exception:
            continue

    return output, model


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


@app.post("/ai/answer-fields", response_model=AiAnswerResponse)
def ai_answer_fields(request: AiAnswerRequest) -> AiAnswerResponse:
    profile = request.profile or profile_store
    heuristic_answers = build_heuristic_answers(profile, request.fields)
    answer_map: dict[str, AiFieldAnswer] = {answer.field_id: answer for answer in heuristic_answers}

    used_llm = False
    model_name = ""
    message = ""

    try:
        llm_answers, model_name = call_openai_for_field_answers(request, profile)
        if llm_answers:
            used_llm = True
        for answer in llm_answers:
            existing = answer_map.get(answer.field_id)
            if not existing or answer.confidence >= existing.confidence:
                answer_map[answer.field_id] = answer
    except RuntimeError as exc:
        message = str(exc)

    if not os.getenv("OPENAI_API_KEY", "").strip():
        message = "OPENAI_API_KEY not set. Returned heuristic answers only."

    return AiAnswerResponse(
        answers=list(answer_map.values()),
        used_llm=used_llm,
        model=model_name,
        message=message,
    )


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
