from __future__ import annotations

import uuid

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.deps import DB, CurrentUser
from app.core.errors import ValidationFailed
from app.schemas.documents import JobExtraction
from app.services.auth_service import get_owned_document
from app.services.role_detection_service import RoleDetection, detect_roles

router = APIRouter(prefix="/roles", tags=["roles"])


class DetectIn(BaseModel):
    job_description_document_id: uuid.UUID


@router.post("/detect", response_model=RoleDetection)
async def detect(body: DetectIn, user: CurrentUser, db: DB) -> RoleDetection:
    doc = await get_owned_document(db, user.id, body.job_description_document_id)
    if doc.document_type != "job_description":
        raise ValidationFailed("Choose a job description document.", code="DOCUMENT_TYPE_MISMATCH")
    if doc.parsing_status != "parsed" or not doc.extracted_data:
        raise ValidationFailed("The job description hasn't been parsed yet.", code="JOB_NOT_PARSED")
    return detect_roles(JobExtraction.model_validate(doc.extracted_data))
