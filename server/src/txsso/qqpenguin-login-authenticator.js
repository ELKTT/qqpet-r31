import { LoginProtocolError } from "../protocol/login.js";
import { LocalServiceTicketIssuer } from "./service-ticket-issuer.js";
import { QQPENGUIN_SERVICE_ID } from "./service-id.js";

export class QqPenguinLoginTicketAuthenticator {
  constructor({ ticketIssuer, serviceId = QQPENGUIN_SERVICE_ID, allowLocalQqsignTicket = false, onAuthenticated } = {}) {
    if (!(ticketIssuer instanceof LocalServiceTicketIssuer)) {
      throw new TypeError("ticketIssuer must be a LocalServiceTicketIssuer");
    }
    if (!Number.isInteger(serviceId) || serviceId <= 0 || serviceId > 0xffffffff) {
      throw new TypeError("serviceId must be a nonzero unsigned 32-bit integer");
    }
    if (typeof allowLocalQqsignTicket !== "boolean" ||
        (onAuthenticated !== undefined && (typeof onAuthenticated !== "function" || !allowLocalQqsignTicket))) {
      throw new TypeError("invalid local ticket authentication options");
    }
    this.ticketIssuer = ticketIssuer;
    this.serviceId = serviceId;
    this.allowLocalQqsignTicket = allowLocalQqsignTicket;
    this.onAuthenticated = onAuthenticated;
  }

  authenticate(loginRequest) {
    if (!loginRequest || loginRequest.type !== "LoginRequest") {
      throw new LoginProtocolError("INVALID_ARGUMENT", "loginRequest must be a LoginRequest");
    }
    const localQqsign = this.allowLocalQqsignTicket && loginRequest.credentialModeOrLength === 64;
    if (loginRequest.credentialModeOrLength !== 1 && !localQqsign) {
      throw new LoginProtocolError(
        "UNSUPPORTED_LOGIN_CREDENTIAL",
        "original TXSSO login requires the SSOSIGN credential marker",
      );
    }
    if (!Buffer.isBuffer(loginRequest.credential)) {
      throw new LoginProtocolError("INVALID_LOGIN_CREDENTIAL", "SSOSIGN must be a byte buffer");
    }
    // The approved local QQSIGN seam keeps the original length marker, but only
    // accepts this issuer's exact hexadecimal service ticket, never arbitrary QQSIGN.
    if (localQqsign && (loginRequest.credential.length !== 64 ||
        !loginRequest.credential.every(byte => (byte >= 48 && byte <= 57) ||
          (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102)))) {
      throw new LoginProtocolError("INVALID_LOGIN_CREDENTIAL", "invalid local service ticket");
    }
    const signHex = loginRequest.credential.toString("ascii");
    let identity;
    try {
      identity = this.ticketIssuer.verifyHex(signHex, { serviceId: this.serviceId });
    } catch {
      throw new LoginProtocolError(
        "INVALID_LOGIN_CREDENTIAL",
        "SSOSIGN is not a locally issued QQPenguin service ticket",
      );
    }
    this.onAuthenticated?.(signHex,loginRequest);
    return Object.freeze({
      kind: "txsso-service-ticket",
      uin: identity.uin,
      serviceId: identity.serviceId,
      sensitiveValuesPresent: false,
    });
  }
}
