const FORBIDDEN_PET_FIELDS = Object.freeze([
  "petId",
  "gender",
  "nickname",
  "level",
  "growth",
  "hunger",
  "cleanliness",
  "mood",
  "health",
  "activityStatus",
]);

export class LocalIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalIdentityError";
    this.code = code;
  }
}

function requireText(value, name, maximumLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new LocalIdentityError(
      "INVALID_LOCAL_IDENTITY",
      `${name} must be a non-empty string of at most ${maximumLength} characters`,
    );
  }
  if (/\0|[\r\n]/u.test(value)) {
    throw new LocalIdentityError("INVALID_LOCAL_IDENTITY", `${name} contains a forbidden control`);
  }
}

export function createLocalIdentity(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LocalIdentityError("INVALID_LOCAL_IDENTITY", "LocalIdentity must be an object");
  }
  for (const field of FORBIDDEN_PET_FIELDS) {
    if (Object.hasOwn(input, field)) {
      throw new LocalIdentityError(
        "PET_FIELDS_NOT_ALLOWED",
        `LocalIdentity cannot contain PetState field ${field}`,
      );
    }
  }
  requireText(input.identityId, "identityId", 128);
  requireText(input.displayName, "displayName", 64);
  if (!/^[a-z0-9][a-z0-9._:-]*$/iu.test(input.identityId)) {
    throw new LocalIdentityError(
      "INVALID_LOCAL_IDENTITY",
      "identityId must use stable local identifier characters",
    );
  }
  return Object.freeze({ identityId: input.identityId, displayName: input.displayName });
}

export function assertLocalIdentity(value) {
  return createLocalIdentity(value);
}

export function cloneLocalIdentity(value) {
  const identity = assertLocalIdentity(value);
  return Object.freeze({ ...identity });
}
