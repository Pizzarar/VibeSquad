// Loopback callers need the local token to write (S3). Tests send it like the CLI and desktop proxy do.
import { getLocalToken } from "../../server/auth.mjs";

export const ownerHeaders = (extra = {}) => ({ "x-vibesquad-token": getLocalToken(), ...extra });
