"""Helpers to turn Pydantic schemas into provider-friendly JSON Schema."""

from __future__ import annotations

import copy
import json
import re
from typing import Any

from pydantic import BaseModel

_DROP_KEYS = {
    "title",
    "default",
    "examples",
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "pattern",
}


def inline_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Return the model's JSON schema with ``$ref``s inlined and noise removed."""
    schema = model.model_json_schema()
    defs = schema.pop("$defs", {})

    def resolve(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                name = node["$ref"].split("/")[-1]
                return resolve(copy.deepcopy(defs[name]))
            cleaned: dict[str, Any] = {}
            for k, v in node.items():
                if k in _DROP_KEYS:
                    continue
                if k == "exclusiveMinimum":
                    cleaned["minimum"] = v
                elif k == "exclusiveMaximum":
                    cleaned["maximum"] = v
                else:
                    cleaned[k] = resolve(v)
            return cleaned
        if isinstance(node, list):
            return [resolve(v) for v in node]
        return node

    return resolve(schema)


def schema_prompt(model: type[BaseModel]) -> str:
    return json.dumps(inline_schema(model), separators=(",", ":"))


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


def parse_json_object(text: str) -> dict[str, Any]:
    """Parse a JSON object, tolerating code fences and surrounding prose."""
    cleaned = _FENCE.sub("", text.strip())
    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError:
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start == -1 or end <= start:
            raise
        value = json.loads(cleaned[start : end + 1])
    if not isinstance(value, dict):
        raise json.JSONDecodeError("Top-level JSON value is not an object", cleaned, 0)
    return value
