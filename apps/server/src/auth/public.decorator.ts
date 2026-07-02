import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'nuncio:isPublic';

/**
 * Exempts a route (or a whole controller) from the global AuthGuard.
 * Reserved for endpoints that carry their own auth (webhook HMAC) or
 * intentionally expose nothing sensitive (health, auth login/status).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
