const ALLOWED_RELEASE_TYPES = new Set(["SWB", "电放", "正本"]);

export function normalizeReleaseType(value) {
  if (value == null || value === "") return value;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^SWB$/i.test(raw) || /海运单/i.test(raw)) return "SWB";
  if (/电放|telex/i.test(raw)) return "电放";
  if (/正本|original|OBL/i.test(raw)) return "正本";
  return raw;
}

export function validateReleaseTypeBody(body) {
  if (!body) return { ok: true };
  const hasSnake = Object.prototype.hasOwnProperty.call(body, "release_type");
  const hasCamel = Object.prototype.hasOwnProperty.call(body, "releaseType");
  if (!hasSnake && !hasCamel) {
    return { ok: true };
  }
  const normalized = normalizeReleaseType(hasSnake ? body.release_type : body.releaseType);
  if (normalized == null || normalized === "") {
    body.release_type = null;
    return { ok: true };
  }
  if (!ALLOWED_RELEASE_TYPES.has(normalized)) {
    return {
      ok: false,
      error: "出单方式只能选择 SWB / 电放 / 正本，请不要自由输入。",
    };
  }
  body.release_type = normalized;
  return { ok: true };
}
