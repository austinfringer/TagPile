export function isValidUsername(username: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(username);
}

export const PASSWORD_MIN_LENGTH = 8;
/** bcrypt uses only the first 72 bytes of its input. */
export const PASSWORD_MAX_BYTES = 72;

/** Any characters are permitted. The length counts Unicode code points, not UTF-16 units. */
export function isValidPassword(password: string): boolean {
  return (
    [...password].length >= PASSWORD_MIN_LENGTH &&
    Buffer.byteLength(password, 'utf8') <= PASSWORD_MAX_BYTES
  );
}

export const PASSWORD_RULE = `Password must have at least ${PASSWORD_MIN_LENGTH} characters and at most ${PASSWORD_MAX_BYTES} bytes`;
