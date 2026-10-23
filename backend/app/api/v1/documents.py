from __future__ import annotations

import uuid

from fastapi import APIRouter, File, Form, Request, UploadFile

from app.api.deps import DB, CurrentUser, Providers, SettingsDep, Storage, limit_ai
from app.core.errors import AppError, ValidationFailed
from app.models import Document
from app.schemas.documents import DocumentCorrection, DocumentOut
from app.services import document_service
from app.services.auth_service import get_owned_document

router = APIRouter(prefix="/documents", tags=["documents"])


def to_out(doc: Document) -> DocumentOut:
    return DocumentOut(
        id=doc.id,
        document_type=doc.document_type,
        file_name=doc.file_name,  # type: ignore[arg-type]
        parsing_status=doc.parsing_status,
        parsing_error=doc.parsing_error,
        extracted_data=doc.extracted_data,
        character_count=len(doc.extracted_text or ""),
        created_at=doc.created_at,
    )


async def _read_limited(upload: UploadFile, limit: int) -> bytes:
    data = await upload.read(limit + 1)
    if len(data) > limit:
        mb = limit // (1024 * 1024)
        raise AppError(
            f"The file is larger than {mb} MB. Upload a smaller file.", code="FILE_TOO_LARGE", status_code=413
        )
    return data


@router.post("/resume", response_model=DocumentOut, status_code=201)
async def upload_resume(
    user: CurrentUser,
    db: DB,
    settings: SettingsDep,
    providers: Providers,
    storage: Storage,
    file: UploadFile = File(...),
) -> DocumentOut:
    data = await _read_limited(file, settings.max_upload_bytes)
    validated = document_service.validate_upload(file.filename, data, settings)
    limit_ai(user, settings)
    doc = await document_service.ingest_document(
        db=db,
        storage=storage,
        provider=providers.text,
        settings=settings,
        user_id=user.id,
        document_type="resume",
        file=validated,
        text=None,
    )
    return to_out(doc)


@router.post("/job-description", response_model=DocumentOut, status_code=201)
async def upload_job_description(
    request: Request,
    user: CurrentUser,
    db: DB,
    settings: SettingsDep,
    providers: Providers,
    storage: Storage,
    file: UploadFile | None = File(default=None),
    text: str | None = Form(default=None),
) -> DocumentOut:
    if file is not None and text:
        raise ValidationFailed("Provide either a file or pasted text, not both.", code="JD_AMBIGUOUS")
    validated = None
    if file is not None:
        data = await _read_limited(file, settings.max_upload_bytes)
        validated = document_service.validate_upload(file.filename, data, settings)
    elif text is not None:
        if len(text) > settings.max_jd_text_chars:
            raise ValidationFailed(
                "The job description is too long. Paste up to 30,000 characters.", code="JD_TOO_LONG"
            )
    else:
        raise ValidationFailed("Upload a job description or paste its text.", code="JD_MISSING")
    limit_ai(user, settings)
    doc = await document_service.ingest_document(
        db=db,
        storage=storage,
        provider=providers.text,
        settings=settings,
        user_id=user.id,
        document_type="job_description",
        file=validated,
        text=text if validated is None else None,
    )
    return to_out(doc)


@router.get("/{document_id}", response_model=DocumentOut)
async def get_document(document_id: uuid.UUID, user: CurrentUser, db: DB) -> DocumentOut:
    return to_out(await get_owned_document(db, user.id, document_id))


@router.post("/{document_id}/parse", response_model=DocumentOut)
async def retry_parse(
    document_id: uuid.UUID, user: CurrentUser, db: DB, settings: SettingsDep, providers: Providers
) -> DocumentOut:
    """Retry structured parsing after a failure."""
    doc = await get_owned_document(db, user.id, document_id)
    if doc.parsing_status == "parsed":
        return to_out(doc)
    limit_ai(user, settings)
    doc.parsing_status = "extracting"
    await db.commit()
    await document_service.run_parse(db=db, provider=providers.text, doc=doc)
    return to_out(doc)


@router.patch("/{document_id}", response_model=DocumentOut)
async def correct_document(
    document_id: uuid.UUID, body: DocumentCorrection, user: CurrentUser, db: DB
) -> DocumentOut:
    """Manual correction of extracted fields (validated against the same schema)."""
    doc = await get_owned_document(db, user.id, document_id)
    doc.extracted_data = document_service.validate_correction(doc.document_type, body.extracted_data)
    doc.parsing_status = "parsed"
    doc.parsing_error = None
    await db.commit()
    return to_out(doc)
