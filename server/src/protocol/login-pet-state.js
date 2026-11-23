import { assertLocalIdentity } from "../identity/local-identity.js";
import { assertPetState } from "../pet-domain/pet-state.js";
import { createLocalLoginSuccess } from "./login.js";

export const LoginCompatibilityProfile = Object.freeze({
  DISABLED: "disabled",
  LOCAL_VISIBLE: "local-visible",
});

export class LoginPetStateMappingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LoginPetStateMappingError";
    this.code = code;
  }
}

// Local compatibility candidate: status 1 was visibly identified as the
// working state. The earlier status-0 death observation was confounded by a
// zero health value, so idle now uses status 0 with a healthy PetState. This
// does not claim to reproduce Tencent's historical server rule.
const LOCAL_ACTIVITY_STATUS_LOGIN_MAPPING = Object.freeze({
  idle: Object.freeze({ statusId: 0, statusDescription: "IDLE" }),
});

// Authoritative FeedLogic static evidence consumes PETSIZE_VALUE / 140.0 as
// the desktop scale. Zero falls back to 0.1, which produced the observed
// 14-by-14 pet. This is a client wire value, not persisted domain state.
export const LOCAL_NORMAL_PET_SIZE_VALUE = 140;

function cumulativeGrowthAtLevelStart(level) {
  const levelValue = BigInt(level);
  return (
    100n *
    (levelValue +
      (levelValue * (levelValue + 1n) * (2n * levelValue + 1n)) / 24n)
  );
}

function mapCurrentLevelGrowthToWire(level, growth) {
  // FeedLogic treats GROWTH_VALUE as cumulative growth, subtracting this
  // exact level-start formula before rendering the current-level progress.
  const wireValue = cumulativeGrowthAtLevelStart(level) + BigInt(growth);
  if (wireValue > 0xffffffffn) {
    throw new LoginPetStateMappingError(
      "LOGIN_GROWTH_VALUE_OUT_OF_RANGE",
      "PetState level and growth exceed the confirmed 32-bit Login field",
    );
  }
  return Number(wireValue);
}

function encodeKnownLocalAscii(value, fieldName) {
  if (typeof value !== "string" || !/^[\x20-\x7e]+$/u.test(value)) {
    throw new LoginPetStateMappingError(
      "LOGIN_TEXT_ENCODING_UNSUPPORTED",
      `${fieldName} cannot be mapped until the authoritative text encoding is confirmed`,
    );
  }
  const source = Buffer.from(value, "ascii");
  if (source.length > 16) {
    throw new LoginPetStateMappingError(
      "LOGIN_TEXT_TOO_LONG",
      `${fieldName} exceeds the confirmed 16-byte Login field`,
    );
  }
  const target = Buffer.alloc(16);
  source.copy(target);
  return target;
}

function mapActivityStatus(activityStatus) {
  const mapping = LOCAL_ACTIVITY_STATUS_LOGIN_MAPPING[activityStatus];
  if (!mapping) {
    throw new LoginPetStateMappingError(
      "LOGIN_ACTIVITY_STATUS_UNSUPPORTED",
      "PetState.activityStatus has no confirmed local Login wire mapping",
    );
  }
  return mapping;
}

export function mapPetStateToLoginSuccess(
  request,
  {
    localIdentity,
    petState,
    compatibilityProfile = LoginCompatibilityProfile.DISABLED,
  } = {},
) {
  const identity = assertLocalIdentity(localIdentity);
  const state = assertPetState(petState);
  if (!Object.values(LoginCompatibilityProfile).includes(compatibilityProfile)) {
    throw new LoginPetStateMappingError(
      "INVALID_COMPATIBILITY_PROFILE",
      "Login compatibility profile is not supported",
    );
  }
  const fallbackApplied =
    compatibilityProfile === LoginCompatibilityProfile.LOCAL_VISIBLE && state.level === 0;
  const levelValue = fallbackApplied ? 1 : state.level;
  const activityStatus = mapActivityStatus(state.activityStatus);
  const baseMessage = createLocalLoginSuccess(request, {
    petName: encodeKnownLocalAscii(state.nickname, "PetState.nickname"),
    masterName: encodeKnownLocalAscii(identity.displayName, "LocalIdentity.displayName"),
    levelValue,
  });
  return Object.freeze({
    message: Object.freeze({
      ...baseMessage,
      statusId: activityStatus.statusId,
      statusDescription: encodeKnownLocalAscii(
        activityStatus.statusDescription,
        "PetState.activityStatus",
      ),
      unknown_0x47: state.hunger,
      unknown_0x49: state.cleanliness,
      unknown_0x4b: state.health,
      unknown_0x4d: LOCAL_NORMAL_PET_SIZE_VALUE,
      unknown_0x4e: state.mood,
      unknown_0x61: mapCurrentLevelGrowthToWire(levelValue, state.growth),
    }),
    metadata: Object.freeze({
      compatibilityProfile,
      levelSource: fallbackApplied ? "local-visible-fallback" : "pet-state",
      levelValue,
    }),
  });
}
