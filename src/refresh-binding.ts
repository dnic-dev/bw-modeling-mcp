/**
 * Ties a refresh token to the MCP client it was issued to.
 *
 * The OAuth proxy talks to the identity service with one client of its own on behalf of every
 * MCP client, so the identity service cannot tell them apart: a refresh token issued to one
 * client would be honoured when another presents it. That matters most for public clients,
 * which have no secret to prove anything with.
 *
 * Every refresh token handed out is therefore sealed together with the client id and unsealed
 * only for that client. The ciphertext also keeps the upstream token away from the client, so
 * it cannot be redeemed at the identity service directly either. The key comes from the
 * server's binding secret, which every instance of one deployment shares.
 *
 * A token from before the binding carries no prefix and is refused: the client signs in once
 * more and receives a sealed one.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export const SEALED_PREFIX = 'bwrt1.';
const KDF_LABEL = 'bw-mcp-refresh-binding/v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class RefreshTokenBinding {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (!secret) throw new Error('RefreshTokenBinding requires a secret');
    this.key = createHmac('sha256', secret).update(KDF_LABEL).digest();
  }

  seal(refreshToken: string, clientId: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plain = Buffer.from(JSON.stringify({ rt: refreshToken, cid: clientId }), 'utf8');
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return SEALED_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }

  /** The upstream refresh token, or undefined when the token is forged, altered or another client's. */
  unseal(sealed: string, clientId: string): string | undefined {
    if (!sealed.startsWith(SEALED_PREFIX)) return undefined;
    try {
      const raw = Buffer.from(sealed.slice(SEALED_PREFIX.length), 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, IV_BYTES));
      decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
      const { rt, cid } = JSON.parse(plain.toString('utf8')) as { rt?: unknown; cid?: unknown };
      return cid === clientId && typeof rt === 'string' ? rt : undefined;
    } catch {
      return undefined;
    }
  }
}
