export const PetGender = Object.freeze({
  UNSPECIFIED: "unspecified",
  MALE: "male",
  FEMALE: "female",
});

// These are deliberately local, non-punitive product defaults. Their visible
// scales were confirmed against the authoritative client; they do not claim a
// historical Tencent initialization rule.
export const LOCAL_PRODUCT_INITIAL_PET_VALUES = Object.freeze({
  level: 0,
  growth: 0,
  hunger: 3_100,
  cleanliness: 3_100,
  mood: 1_000,
  health: 5,
  activityStatus: "idle",
});

export const PET_ATTRIBUTE_MAXIMUMS = Object.freeze({
  hunger: 3_100,
  cleanliness: 3_100,
  mood: 1_000,
  health: 5,
});

export const PET_STATE_UPDATABLE_FIELDS = Object.freeze([
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

const PET_STATE_UPDATABLE_FIELD_SET = new Set(PET_STATE_UPDATABLE_FIELDS);

export class PetStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PetStateError";
    this.code = code;
  }
}

function requireInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new PetStateError(
      "INVALID_PET_STATE",
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
}

function requireText(value, name, maximumLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    [...value].length > maximumLength ||
    /\0|[\r\n]/u.test(value)
  ) {
    throw new PetStateError(
      "INVALID_PET_STATE",
      `${name} must be non-empty text of at most ${maximumLength} characters`,
    );
  }
}

function readNow(now) {
  if (typeof now !== "function") {
    throw new PetStateError("INVALID_TIME_SOURCE", "now must be a function");
  }
  const value = now();
  requireInteger(value, 0, Number.MAX_SAFE_INTEGER, "lastSavedAt");
  return value;
}

export function createPetState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PetStateError("INVALID_PET_STATE", "PetState must be an object");
  }
  requireInteger(input.petId, 1, 0xffffffff, "petId");
  if (!Object.values(PetGender).includes(input.gender)) {
    throw new PetStateError("INVALID_PET_STATE", "gender is not a supported local value");
  }
  requireText(input.nickname, "nickname", 64);
  requireInteger(input.level, 0, 0xffff, "level");
  requireInteger(input.growth, 0, 0xffffffff, "growth");
  for (const [field, maximum] of Object.entries(PET_ATTRIBUTE_MAXIMUMS)) {
    requireInteger(input[field], 0, maximum, field);
  }
  requireText(input.activityStatus, "activityStatus", 64);
  requireInteger(input.version, 1, Number.MAX_SAFE_INTEGER, "version");
  requireInteger(input.lastSavedAt, 0, Number.MAX_SAFE_INTEGER, "lastSavedAt");

  return Object.freeze({
    petId: input.petId,
    gender: input.gender,
    nickname: input.nickname,
    level: input.level,
    growth: input.growth,
    hunger: input.hunger,
    cleanliness: input.cleanliness,
    mood: input.mood,
    health: input.health,
    activityStatus: input.activityStatus,
    version: input.version,
    lastSavedAt: input.lastSavedAt,
  });
}

export function assertPetState(value) {
  return createPetState(value);
}

export function clonePetState(value) {
  return Object.freeze({ ...assertPetState(value) });
}

export function createInitialPetState(
  {
    petId,
    gender = PetGender.UNSPECIFIED,
    nickname,
    level = LOCAL_PRODUCT_INITIAL_PET_VALUES.level,
  },
  { now = Date.now } = {},
) {
  return createPetState({
    petId,
    gender,
    nickname,
    ...LOCAL_PRODUCT_INITIAL_PET_VALUES,
    level,
    version: 1,
    lastSavedAt: readNow(now),
  });
}

export function updatePetState(current, changes, { now = Date.now } = {}) {
  const state = assertPetState(current);
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new PetStateError("INVALID_PET_STATE", "PetState changes must be an object");
  }
  const changeFields = Reflect.ownKeys(changes);
  if (changeFields.length === 0) {
    throw new PetStateError(
      "EMPTY_PET_STATE_CHANGE",
      "PetState changes must include at least one updatable field",
    );
  }
  if (Object.hasOwn(changes, "petId")) {
    throw new PetStateError("PET_ID_IMMUTABLE", "an existing PetState cannot change petId");
  }
  if (Object.hasOwn(changes, "version") || Object.hasOwn(changes, "lastSavedAt")) {
    throw new PetStateError(
      "PET_REVISION_MANAGED",
      "version and lastSavedAt are advanced by updatePetState",
    );
  }
  const unknownFields = changeFields.filter(
    (field) => typeof field !== "string" || !PET_STATE_UPDATABLE_FIELD_SET.has(field),
  );
  if (unknownFields.length > 0) {
    throw new PetStateError(
      "UNKNOWN_PET_STATE_CHANGE",
      `PetState changes contain unsupported fields: ${unknownFields.map(String).join(", ")}`,
    );
  }
  return createPetState({
    ...state,
    ...changes,
    petId: state.petId,
    version: state.version + 1,
    lastSavedAt: readNow(now),
  });
}
